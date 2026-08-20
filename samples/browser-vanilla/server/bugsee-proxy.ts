import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

// WORKAROUND for a staging-backend defect (samples/browser-vanilla/FINDINGS.md F-2, blocker): the real
// `https://apidev.bugsee.com` always answers CORS preflights with a HARDCODED
// `Access-Control-Allow-Origin: https://appdev.bugsee.com` (the staging dashboard's own origin), never
// reflecting the requesting page's origin — so a genuine third-party site (this sample, or ANY real
// customer site) cannot call it directly from a browser at all; every request is blocked before it
// leaves the browser (`net::ERR_FAILED`, the SDK's session-creation POST never sent). This is a backend
// defect outside this repo (samples never fix SDK/backend code), so this sample instead runs its OWN
// same-origin reverse proxy: the browser talks to `/bugsee-proxy/*` on :5301 (same-origin, no CORS
// involved at all), and THIS process — a plain Node server, not subject to browser CORS — relays the
// request to the real staging endpoint and relays the response back byte for byte. The data that lands
// on Bugsee staging is identical either way; only the transport hop from browser→collector is rerouted
// through a relay that isn't a browser. See README.md "Known backend defect" for the full writeup.
//
// SECOND workaround piggybacked on the same relay (FINDINGS.md F-3, blocker): every `@bugsee/core`
// control-plane request (any runtime — browser, node, workers, …) hardcodes the header
// `x-client-type: 'web'` (packages/core/src/bugsee-api.ts:38). The staging app this sample reports to
// (`SBROWSER`) is a `type: "javascript"` application (the newer JS-SDK app-type family — see the
// `javascript app-type` design work), and appserver's `isValidForClient` requires
// `x-client-type === application.type` exactly (code/utils.js:1100 in the appserver repo) — `'web'` only
// matches the OLD/legacy `web` app type, never `'javascript'`. Every session-creation request the real
// SDK sends is therefore rejected with `ApplicationTypeMismatchError` before this proxy was patched to
// compensate: verified directly against the real staging endpoint (curl, same payload, header flipped)
// — `x-client-type: javascript` → `{"ok":true,...}`, `x-client-type: web` →
// `{"ok":false,"error":{"type":"ApplicationTypeMismatchError",...}}`. Rewriting the header here, at the
// one hop that ISN'T inside the SDK, is what makes it possible to verify ANY scenario against this
// app at all.
//
// THIRD workaround, the load-bearing one (FINDINGS.md F-4, blocker): `@bugsee/core`'s
// `createBugseeApi` (packages/core/src/bugsee-api.ts `ensureSession`/`postIssue`) decodes the
// session/issue response body assuming a FLAT shape — `{ access_token }`, `{ endpoint, issueId,
// recordingId }` — but appserver's real `/v2/*` responses (confirmed by curl against the real staging
// endpoint) are wrapped in a `{ ok: true, result: {...} }` envelope for EVERY v2 route
// (appserver code/app.utils.js `success()`: apiVersion>=2 always wraps). So
// `decode(response.body).access_token` reads a field that only exists one level up, at
// `.result.access_token`, and gets `undefined` — the SDK sends `Authorization: Bearer undefined` on
// every subsequent call, which appserver correctly rejects as `SessionNotFoundError`. Nothing has ever
// successfully authenticated a session or created an issue against a real (non-mocked) v2 backend: the
// unit tests that cover `ensureSession`/`postIssue` mock the transport with the SAME flat (wrong) shape
// (packages/core/src/bugsee-api.test.ts:39, `enc({ access_token: token })`), so the mismatch was never
// caught. Compounding this, neither call checks the body's own `ok: false` flag — only the HTTP status
// (`isOk(response.status)`) — and appserver returns HTTP 200 even for a LOGICAL failure (e.g. the F-3
// `ApplicationTypeMismatchError` above came back as `200 {"ok":false,"error":{...}}`), so a rejected
// request is silently treated as a success with every field `undefined` rather than surfaced or
// retried. This proxy unwraps `result` back to the top level for the two affected endpoints so this
// sample's verification can proceed past this point; it does not touch the SDK's own (buggy) parsing.
//
// FOURTH workaround (FINDINGS.md F-5, blocker): even with F-3/F-4 worked around, the FINAL step —
// the signed S3 PUT itself — still 403s with `SignatureDoesNotMatch`. `createBundleUploader`
// (packages/core/src/bundle-uploader.ts) unconditionally sends an `x-amz-checksum-sha256` header on
// every PUT, but appserver's presigned URL (`code/components/app/issue/issue.service.js`, the
// `awsService.s3.signedUrl(params)` call around line 1737) only signs a `content_md5`/`content_sha256`
// requirement when the ISSUE-CREATE request body carried `bundle_md5`/`bundle_sha256` — fields
// `RequestJson` (packages/protocol/src/wire.ts) has no place for and the SDK never sends. The bucket
// uses SigV2 presigned URLs, whose signature covers `CanonicalizedAmzHeaders` (every `x-amz-*` header
// present on the actual request) — sending an x-amz header the presign step didn't account for
// invalidates the signature outright. Confirmed directly against the real S3 endpoint: the identical
// PUT succeeds with that header dropped, 403s `SignatureDoesNotMatch` with it present. Since the
// signed URL points straight at S3 (not through appserver), THIS relay also proxies the PUT
// (`/bugsee-proxy-s3?u=<url>`, endpoint rewritten below) so it can strip the one offending header —
// same category of defect as F-4, just one more hop down the same call chain.
const S3_PROXY_PATH = '/bugsee-proxy-s3';

// `content-encoding` is included here too: Node's built-in `fetch` transparently decompresses the
// upstream body before `arrayBuffer()` returns it, so relaying the ORIGINAL `content-encoding: gzip`
// header alongside the now-uncompressed bytes would corrupt the response for the browser.
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'keep-alive',
]);
// F-4 workaround targets: POST /v2/sessions and /v2/issues, whose success bodies the real SDK parses
// with the wrong (flat) shape — see the module comment above.
const UNWRAP_RESULT_PATHS = new Set(['/v2/sessions', '/v2/issues']);

export function bugseeCorsProxyPlugin(realEndpoint: string): Plugin {
  const handleS3 = async (req: IncomingMessage, res: ServerResponse, target: string): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      // F-5 workaround (see the module comment above): drop the header that invalidates the SigV2
      // presigned URL's signature — the one appserver never accounted for when signing it.
      if (key.toLowerCase() === 'x-amz-checksum-sha256') continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    try {
      const upstream = await fetch(target, { method: req.method, headers, body });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value;
      });
      responseHeaders['content-length'] = String(buf.byteLength);
      res.writeHead(upstream.status, responseHeaders);
      res.end(buf);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_failed', message: String(error) }));
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://internal');

    if (url.pathname === S3_PROXY_PATH) {
      const target = url.searchParams.get('u');
      if (target === null) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_target' }));
        return;
      }
      await handleS3(req, res, target);
      return;
    }

    if (!url.pathname.startsWith('/bugsee-proxy')) {
      next();
      return;
    }
    const targetPath = url.pathname.slice('/bugsee-proxy'.length) || '/';
    const target = `${realEndpoint}${targetPath}${url.search}`;

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    // F-3 workaround (see the module comment above): the SDK always sends 'web'; this app is
    // `type: "javascript"`, so rewrite it here — the one hop outside the SDK — or nothing gets through.
    if (headers['x-client-type'] === 'web') {
      headers['x-client-type'] = 'javascript';
    }

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      let buf = Buffer.from(await upstream.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value;
      });

      if (UNWRAP_RESULT_PATHS.has(targetPath) && req.method === 'POST') {
        try {
          const parsed = JSON.parse(buf.toString('utf8')) as { ok?: boolean; result?: unknown };
          if (parsed.ok === true && parsed.result !== null && typeof parsed.result === 'object') {
            const result = parsed.result as Record<string, unknown>;
            // F-4 (continued): /v2/issues' real success body is snake_case (`issue_id`,
            // `recording_id`), matching the rest of the wire protocol — but
            // `IssueCreateResult`/`postIssue` (packages/core/src/transport.ts,
            // packages/core/src/bugsee-api.ts) expect camelCase `issueId`/`recordingId`. Same class of
            // defect as the envelope unwrap above: never exercised against the real wire shape.
            if (targetPath === '/v2/issues') {
              if ('issue_id' in result) result.issueId = result.issue_id;
              if ('recording_id' in result) result.recordingId = result.recording_id;
              // F-5 workaround (see the module comment above): route the signed S3 PUT through this
              // relay too, so the offending header can be stripped before it reaches S3.
              if (typeof result.endpoint === 'string' && result.endpoint.startsWith('http')) {
                result.endpoint = `${S3_PROXY_PATH}?u=${encodeURIComponent(result.endpoint)}`;
              }
            }
            buf = Buffer.from(JSON.stringify({ ...result, ok: true }));
          }
        } catch {
          // Not JSON (or an already-flat/error body) — relay unchanged.
        }
      }

      responseHeaders['content-length'] = String(buf.byteLength);
      res.writeHead(upstream.status, responseHeaders);
      res.end(buf);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_failed', message: String(error) }));
    }
  };

  return {
    name: 'bugsee-cors-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
  };
}
