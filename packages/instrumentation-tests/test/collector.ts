// A mock Bugsee collector — the upload destination the instrumentation app's real transport talks to.
// It implements just enough of the control plane (session → issue → signed PUT) for the SDK's upload
// pipeline to deliver a bundle, plus an /echo endpoint the app fetches so the network interceptor has a
// real outgoing request to capture. Runs IN the test (runner) process; the app runs in a separate
// node/bun/deno process and reaches it over loopback HTTP — so the captured uploads ARE the assertion
// channel (no IPC needed).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { strFromU8, unzipSync } from '@bugsee/util';
import { Ajv, type ValidateFunction } from 'ajv';
// Validated against the SAME schema file shipped from @bugsee/protocol (the wire-contract package), so
// the harness and the contract cannot drift. Mirrors how webview-conformance.e2e.ts consumes
// packages/webview/bridge-protocol.schema.json.
import uploadContract from '../../protocol/upload-contract.schema.json' with { type: 'json' };

// Compiled once. `strict: false` because the schema uses `definitions` + a top-level oneOf purely as a
// container; we validate against the named definitions individually.
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(uploadContract, 'upload-contract');
const validator = (name: string): ValidateFunction =>
  ajv.getSchema(`upload-contract#/definitions/${name}`) as ValidateFunction;

/** One captured signed-PUT upload: the issue it belongs to + the raw bundle (zip) bytes. */
export interface CapturedUpload {
  issueId: string;
  body: Uint8Array;
}

/** A contract violation observed by the collector: which envelope, and what ajv said. */
export interface ContractViolation {
  /** Which envelope failed: the /v2/sessions body, the /v2/issues body, or a bundle's manifest.json. */
  where: 'session' | 'issue' | 'manifest' | 'request.json';
  errors: string;
}

export interface MockCollector {
  /** API origin the SDK is pointed at (no trailing slash). */
  url: string;
  /** Parsed POST /v2/sessions bodies (the environment envelope). */
  sessions: Array<Record<string, unknown>>;
  /** Parsed POST /v2/issues bodies (the report metadata). */
  issues: Array<Record<string, unknown>>;
  /** Captured signed-PUT bundles, in arrival order. */
  uploads: CapturedUpload[];
  /** How many times the app hit /echo (the captured outgoing request). */
  echoHits: number;
  /** The request headers of each /echo hit (so a test can assert injected traceparent/tracestate). */
  echoHeaders: Array<Record<string, string | string[] | undefined>>;
  /**
   * Every envelope that failed schema validation, in arrival order. The collector RECORDS rather than
   * rejects, so a contract break shows up as a readable test failure instead of an opaque upload error
   * mid-scenario. Assert it is empty — `assertNoContractViolations` does exactly that.
   */
  violations: ContractViolation[];
  close: () => Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

/** Start the mock collector on an ephemeral loopback port. */
export async function startMockCollector(): Promise<MockCollector> {
  const violations: ContractViolation[] = [];
  const check = (where: ContractViolation['where'], definition: string, value: unknown): void => {
    const validate = validator(definition);
    if (!validate(value)) {
      violations.push({ where, errors: JSON.stringify(validate.errors, null, 2) });
    }
  };
  const sessions: Array<Record<string, unknown>> = [];
  const issues: Array<Record<string, unknown>> = [];
  const uploads: CapturedUpload[] = [];
  const echoHeaders: Array<Record<string, string | string[] | undefined>> = [];
  let echoHits = 0;
  let issueSeq = 0;
  // Maps an upload path (/upload/<n>) to the issueId we minted for it, so a captured PUT can be
  // attributed back to its issue.
  const issueByUploadPath = new Map<string, string>();

  let base = '';

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    void (async () => {
      try {
        if (method === 'POST' && url.endsWith('/v2/sessions')) {
          const body = await readBody(req);
          const session = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
          sessions.push(session);
          // The session body NESTS the envelope under `environment` — it is not the envelope itself.
          // (Verified against the real payload: an earlier version of this check validated the whole
          // body and reported a false "missing platform" violation.)
          if (session.environment !== undefined) {
            check('session', 'environmentEnvelope', session.environment);
          }
          sendJson(res, 200, { access_token: 'e2e-access-token' });
          return;
        }
        if (method === 'POST' && url.endsWith('/v2/issues')) {
          const body = await readBody(req);
          const issue = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
          issues.push(issue);
          check('issue', 'requestJson', issue);
          issueSeq += 1;
          const issueId = `i${issueSeq}`;
          const uploadPath = `/upload/${issueSeq}`;
          issueByUploadPath.set(uploadPath, issueId);
          sendJson(res, 200, {
            endpoint: `${base}${uploadPath}`,
            issueId,
            recordingId: `r${issueSeq}`,
          });
          return;
        }
        if (method === 'PUT' && url.startsWith('/upload/')) {
          const body = await readBody(req);
          uploads.push({ issueId: issueByUploadPath.get(url) ?? url, body });
          // Validate the bundle's own root JSON files. Wrapped: a malformed or unreadable bundle must be
          // recorded as a violation, never crash the collector mid-scenario.
          try {
            const files = unzipSync(body) as Record<string, Uint8Array>;
            const parse = (n: string): unknown =>
              files[n] === undefined ? undefined : JSON.parse(strFromU8(files[n] as Uint8Array));
            const manifest = parse('manifest.json');
            if (manifest !== undefined) check('manifest', 'manifestJson', manifest);
            const request = parse('request.json');
            if (request !== undefined) check('request.json', 'requestJson', request);
          } catch (err) {
            violations.push({ where: 'manifest', errors: `unreadable bundle: ${String(err)}` });
          }
          res.writeHead(200);
          res.end();
          return;
        }
        if (url.startsWith('/echo')) {
          echoHits += 1;
          echoHeaders.push({ ...req.headers }); // captures any injected traceparent/tracestate
          sendJson(res, 200, { ok: true, ts: 'e2e' });
          return;
        }
        res.writeHead(404);
        res.end();
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    sessions,
    issues,
    uploads,
    echoHeaders,
    violations,
    get echoHits() {
      return echoHits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Force any keepalive sockets (the app's global fetch pools them) closed so close() resolves
        // promptly instead of waiting on a lingering connection up to the vitest hook timeout.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
