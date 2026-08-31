// A tiny static file server for `dist/` (the PRODUCTION webpack build) + a plain HTTP proxy for
// `/api/*` to the local API server (server/api-server.mjs, expected on :5346) — webpack has no
// built-in "preview" like Vite's; this is that, for the production output.
//
// WebSocket upgrade requests are NOT proxied here (a real customer would put this behind a real
// reverse proxy / CDN in production) — the presence-socket feature in the notes app degrades to
// "no live indicator" when served this way; every scenario this sample cares about (S4/S7 fetch/XHR/
// SSE, and above all the production source-map symbolication check) works over plain HTTP.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5322;
const API_PORT = 5346;
const distDir = fileURLToPath(new URL('../dist', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const proxied = httpRequest(
      { host: 'localhost', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxied.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'api_unreachable' }));
    });
    req.pipe(proxied);
    return;
  }

  let filePath = join(distDir, decodeURIComponent(url.pathname));
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(distDir, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('not found — did you run `pnpm build` first?');
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[serve-dist] serving dist/ on http://localhost:${PORT} (proxying /api -> :${API_PORT})`);
});
