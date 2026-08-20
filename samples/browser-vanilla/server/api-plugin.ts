import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { Plugin, ViteDevServer, PreviewServer } from 'vite';

// A tiny local "backend" for the Widget Shop sample, mounted as Vite middleware so the whole app
// (static assets + JSON API + SSE + WebSocket) is one process on one port (5301) in both `pnpm dev`
// and `pnpm build && pnpm preview`. Genuinely serves the product catalog, accepts checkout POSTs, and
// gives S7 (network capture) real 2xx/4xx/5xx/no-content-type/oversized responses to exercise.

const dataPath = fileURLToPath(new URL('../data/products.json', import.meta.url));
type Product = {
  id: string;
  name: string;
  price: number;
  category: string;
  description: string;
  image: string;
  priceHistory: number[];
  stock: number;
};

function loadProducts(): Product[] {
  return JSON.parse(readFileSync(dataPath, 'utf8')) as Product[];
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let orderCounter = 1000;

function handleApi(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = new URL(req.url ?? '/', 'http://internal');
  const { pathname } = url;

  if (pathname === '/api/products' && req.method === 'GET') {
    json(res, 200, loadProducts());
    return;
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch && req.method === 'GET') {
    const product = loadProducts().find((p) => p.id === productMatch[1]);
    if (product === undefined) {
      json(res, 404, { error: 'not_found', message: `no product ${productMatch[1]}` });
    } else {
      json(res, 200, product);
    }
    return;
  }

  if (pathname === '/api/checkout' && req.method === 'POST') {
    void readBody(req).then((raw) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        json(res, 400, { error: 'bad_request', message: 'invalid JSON body' });
        return;
      }
      if (body.simulateServerError === true) {
        json(res, 500, { error: 'internal_error', message: 'simulated checkout failure' });
        return;
      }
      if (typeof body.email !== 'string' || body.email.length === 0) {
        json(res, 400, { error: 'validation_error', message: 'email is required' });
        return;
      }
      orderCounter += 1;
      json(res, 200, { orderId: `ORD-${orderCounter}`, status: 'accepted' });
    });
    return;
  }

  // S7: a status the app must surface but must NOT report as an incident (a plain 4xx from the API).
  const statusMatch = pathname.match(/^\/api\/status\/(\d{3})$/);
  if (statusMatch) {
    json(res, Number(statusMatch[1]), { error: 'simulated', status: Number(statusMatch[1]) });
    return;
  }

  // S7: a response with a body larger than maxNetworkBodySize (default 20480 bytes).
  if (pathname === '/api/big') {
    const big = 'x'.repeat(40 * 1024);
    json(res, 200, { big });
    return;
  }

  // S7: a response with NO Content-Type header at all.
  if (pathname === '/api/no-content-type') {
    res.writeHead(200, {});
    res.end('plain body, no content-type');
    return;
  }

  // S7: a text/plain body round-trip (not JSON).
  if (pathname === '/api/echo-text' && req.method === 'POST') {
    void readBody(req).then((raw) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`echo: ${raw}`);
    });
    return;
  }

  // S9: a slow endpoint for interaction/transaction timing.
  if (pathname === '/api/slow') {
    const ms = Number(url.searchParams.get('ms') ?? '600');
    setTimeout(() => json(res, 200, { slept: ms }), ms);
    return;
  }

  // S8: an endpoint that echoes a header back, for filter-drop verification (wire level).
  if (pathname === '/api/echo-headers' && req.method === 'GET') {
    json(res, 200, { headers: req.headers });
    return;
  }

  // SSE: order status feed.
  if (pathname === '/api/orders/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const statuses = ['pending', 'processing', 'packed', 'shipped', 'delivered'];
    let i = 0;
    const send = (): void => {
      if (i >= statuses.length) {
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
        clearInterval(timer);
        return;
      }
      res.write(`event: status\ndata: ${JSON.stringify({ status: statuses[i], at: Date.now() })}\n\n`);
      i += 1;
    };
    send();
    const timer = setInterval(send, 700);
    req.on('close', () => clearInterval(timer));
    return;
  }

  next();
}

export function widgetShopApiPlugin(): Plugin {
  let wss: WebSocketServer | undefined;

  const attachWs = (server: ViteDevServer['httpServer'] | PreviewServer['httpServer']): void => {
    if (server === null || server === undefined) return;
    // `noServer: true` + our OWN 'upgrade' listener, filtered by pathname, rather than handing `server`
    // straight to `WebSocketServer` — ws's built-in `server`+`path` mode ABORTS (400) any upgrade whose
    // path doesn't match, and since Vite's dev server shares this same http.Server for its own HMR
    // WebSocket (path `/`), that would 400 Vite's own HMR socket on every request. Filtering ourselves
    // and only calling `handleUpgrade` for `/ws/chat` leaves every other upgrade (Vite's HMR included)
    // untouched for its own listener.
    wss = new WebSocketServer({ noServer: true });
    const httpServer = server as import('node:http').Server;
    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://internal').pathname;
      if (pathname !== '/ws/chat') return;
      wss?.handleUpgrade(req, socket, head, (ws) => wss?.emit('connection', ws, req));
    });
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ from: 'support', text: 'Hi! Welcome to Widget Shop support.' }));
      socket.on('message', (raw) => {
        let text = '';
        try {
          const parsed = JSON.parse(raw.toString()) as { text?: string };
          text = parsed.text ?? '';
        } catch {
          text = raw.toString();
        }
        // Echo back as a "support agent" reply after a short delay — a real round trip over WS.
        setTimeout(() => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ from: 'support', text: `Re: ${text}` }));
          }
        }, 300);
      });
    });
  };

  // Dev serves the Service Worker script from /src/sw/, which caps its registerable scope at that same
  // directory unless the response carries `Service-Worker-Allowed`; src/lib/sw-register.ts asks for
  // scope '/' (it needs to control the whole app), so without this header every registration rejects.
  // (The production path, /service-worker.js, is already top-level — the header is a harmless no-op
  // there, kept for symmetry rather than branching dev vs. preview.)
  const allowSwScope = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url ?? '';
    if (url.startsWith('/src/sw/service-worker') || url.startsWith('/service-worker.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
    }
    next();
  };

  return {
    name: 'widget-shop-api',
    configureServer(server) {
      server.middlewares.use(allowSwScope);
      server.middlewares.use((req, res, next) => handleApi(req, res, next));
      attachWs(server.httpServer);
    },
    configurePreviewServer(server) {
      server.middlewares.use(allowSwScope);
      server.middlewares.use((req, res, next) => handleApi(req, res, next));
      attachWs(server.httpServer);
    },
  };
}
