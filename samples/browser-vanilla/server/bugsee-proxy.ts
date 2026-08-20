import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

// A same-origin relay, and the ONE workaround this sample still needs. It is a backend/CORS gap, not
// an SDK defect.
//
// `https://apidev.bugsee.com` answers every CORS preflight with a hardcoded
// `Access-Control-Allow-Origin: https://appdev.bugsee.com` (the staging dashboard's own origin),
// never reflecting the requesting page's, and its `Access-Control-Allow-Headers` omits `x-app-token`
// and `x-bugsee-internal`, which the SDK sends on every call. So a genuine third-party page — this
// sample, or ANY real customer site — cannot call the collector from a browser at all: the request
// is refused before it leaves the browser. Samples do not fix SDK or backend code, so this sample
// runs its own same-origin reverse proxy instead: the browser talks to `/bugsee-proxy/*` on :5301
// (same origin, no CORS involved), and THIS process — a plain Node server, not subject to browser
// CORS — relays to the real staging endpoint and relays the response back byte for byte. The data
// that lands on Bugsee is identical; only the browser->collector hop is rerouted.
//
// The signed S3 PUT is relayed too (`/bugsee-proxy-s3?u=<url>`), for the same reason: the bundle
// bucket does not answer a cross-origin PUT from this origin either.
//
// This relay used to carry three MORE workarounds, for SDK defects this sample found: an
// `x-client-type: web` header the collector rejects for a `javascript` application, the unparsed
// `{ok, result}` response envelope with its snake_case ids, and an `x-amz-checksum-sha256` header
// the presigned url was never signed for. All three are fixed in @bugsee/core, so the relay no
// longer rewrites any request or response — it only forwards, and repoints the upload endpoint at
// its own S3 hop. See samples/FINDINGS.md.
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

export function bugseeCorsProxyPlugin(realEndpoint: string): Plugin {
  const handleS3 = async (req: IncomingMessage, res: ServerResponse, target: string): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
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

      // Relayed unchanged, with ONE exception: the signed upload url in the /v2/issues result points
      // straight at S3, which will not answer a cross-origin PUT from this page's origin — so it is
      // repointed at this relay's own S3 hop. The `{ok, result}` envelope is preserved exactly as the
      // collector sent it; the SDK parses it itself.
      if (targetPath === '/v2/issues' && req.method === 'POST') {
        try {
          const parsed = JSON.parse(buf.toString('utf8')) as { ok?: boolean; result?: unknown };
          const result = parsed.result as Record<string, unknown> | undefined;
          if (parsed.ok === true && result !== undefined && typeof result.endpoint === 'string') {
            result.endpoint = `${S3_PROXY_PATH}?u=${encodeURIComponent(result.endpoint)}`;
            buf = Buffer.from(JSON.stringify(parsed));
          }
        } catch {
          // Not JSON, or an error body — relay unchanged.
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
