import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer, PreviewServer } from 'vite';
import { WebSocketServer } from 'ws';
import { seedRecipes, type Recipe } from '../data/recipes';

// A tiny in-process "backend" for the Recipe Book sample, mounted as a Vite dev/preview server
// middleware so `pnpm dev` and `pnpm build && pnpm preview` are both a single command. It is a REAL
// API — recipes are actually stored (in-memory) and actually mutated by the editor — plus a family of
// deliberately-broken endpoints the Scenario panel drives to exercise S7 (network capture).

let recipes: Recipe[] = seedRecipes.map((r) => ({ ...r }));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/api/recipes' && method === 'GET') {
    sendJson(res, 200, recipes);
    return true;
  }

  if (path === '/api/recipes' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as Partial<Recipe>;
    const id = (body.title ?? 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36);
    const recipe: Recipe = {
      id,
      title: body.title ?? 'Untitled recipe',
      description: body.description ?? '',
      cookTimeMinutes: body.cookTimeMinutes ?? 0,
      tags: body.tags ?? [],
      ingredients: body.ingredients ?? [],
      steps: body.steps ?? [],
      image: body.image ?? '',
    };
    recipes = [recipe, ...recipes];
    sendJson(res, 201, recipe);
    return true;
  }

  const detailMatch = /^\/api\/recipes\/([^/]+)$/.exec(path);
  if (detailMatch) {
    const id = detailMatch[1];
    const idx = recipes.findIndex((r) => r.id === id);
    if (method === 'GET') {
      if (idx === -1) {
        sendJson(res, 404, { error: 'not_found', message: `No recipe with id "${id}"` });
      } else {
        sendJson(res, 200, recipes[idx]);
      }
      return true;
    }
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}') as Partial<Recipe>;
      if (idx === -1) {
        sendJson(res, 404, { error: 'not_found', message: `No recipe with id "${id}"` });
        return true;
      }
      recipes[idx] = { ...recipes[idx], ...body, id };
      sendJson(res, 200, recipes[idx]);
      return true;
    }
    if (method === 'DELETE') {
      if (idx === -1) {
        sendJson(res, 404, { error: 'not_found', message: `No recipe with id "${id}"` });
        return true;
      }
      recipes.splice(idx, 1);
      res.writeHead(204);
      res.end();
      return true;
    }
  }

  // --- S7 network-capture scenario endpoints ---

  if (path === '/api/scenarios/echo' && method === 'POST') {
    const body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body || '{}');
    return true;
  }

  if (path === '/api/scenarios/4xx') {
    sendJson(res, 400, { error: 'bad_request', message: 'This endpoint always returns 400.' });
    return true;
  }

  if (path === '/api/scenarios/5xx') {
    sendJson(res, 500, { error: 'internal', message: 'This endpoint always returns 500.' });
    return true;
  }

  if (path === '/api/scenarios/big') {
    // Larger than the SDK default maxNetworkBodySize (20480 bytes) so the capture must truncate, not
    // buffer unbounded — the "body over maxNetworkBodySize" leg of S7.
    const big = 'x'.repeat(60_000);
    sendJson(res, 200, { big });
    return true;
  }

  if (path === '/api/scenarios/no-content-type') {
    res.writeHead(200, {});
    res.end('a body with no Content-Type header at all');
    return true;
  }

  if (path === '/api/scenarios/veto-me') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/scenarios/text') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('a plain text response body, not JSON');
    return true;
  }

  if (path === '/api/scenarios/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`event: tick\ndata: ${JSON.stringify({ n, at: Date.now() })}\n\n`);
      if (n >= 3) {
        clearInterval(timer);
        res.end();
      }
    }, 150);
    req.on('close', () => clearInterval(timer));
    return true;
  }

  return false;
}

/** The minimal 'upgrade'-emitting surface both Vite's dev http.Server and its preview server (which can
 *  also be an Http2SecureServer) share — avoids fighting the two servers' different concrete types. */
interface UpgradeEmitter {
  on(
    event: 'upgrade',
    listener: (
      req: IncomingMessage,
      socket: import('node:net').Socket,
      head: Buffer,
    ) => void,
  ): void;
}

/** Attach the /api/scenarios/ws echo endpoint to the server's raw http.Server 'upgrade' event. */
function attachWebSocket(httpServer: UpgradeEmitter): void {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'welcome', message: 'connected to the recipe-book echo socket' }));
    ws.on('message', (data) => {
      ws.send(JSON.stringify({ type: 'echo', message: data.toString() }));
    });
  });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/scenarios/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });
}

export function recipeApiPlugin(): Plugin {
  return {
    name: 'recipe-book-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        handleApi(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch(next);
      });
      if (server.httpServer) attachWebSocket(server.httpServer);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use((req, res, next) => {
        handleApi(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch(next);
      });
      if (server.httpServer) attachWebSocket(server.httpServer);
    },
  };
}
