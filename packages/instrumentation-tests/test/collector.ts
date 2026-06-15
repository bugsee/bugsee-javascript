// A mock Bugsee collector — the upload destination the instrumentation app's real transport talks to.
// It implements just enough of the control plane (session → issue → signed PUT) for the SDK's upload
// pipeline to deliver a bundle, plus an /echo endpoint the app fetches so the network interceptor has a
// real outgoing request to capture. Runs IN the test (runner) process; the app runs in a separate
// node/bun/deno process and reaches it over loopback HTTP — so the captured uploads ARE the assertion
// channel (no IPC needed).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One captured signed-PUT upload: the issue it belongs to + the raw bundle (zip) bytes. */
export interface CapturedUpload {
  issueId: string;
  body: Uint8Array;
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
  const sessions: Array<Record<string, unknown>> = [];
  const issues: Array<Record<string, unknown>> = [];
  const uploads: CapturedUpload[] = [];
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
          sessions.push(JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>);
          sendJson(res, 200, { access_token: 'e2e-access-token' });
          return;
        }
        if (method === 'POST' && url.endsWith('/v2/issues')) {
          const body = await readBody(req);
          issues.push(JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>);
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
          res.writeHead(200);
          res.end();
          return;
        }
        if (url.startsWith('/echo')) {
          echoHits += 1;
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
