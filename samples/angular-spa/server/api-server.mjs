// A small local API for the Expense report app — plain node:http, no framework (the framework under
// test is on the client side: @bugsee/angular). Also hosts `/api/scenario/*` routes purpose-built to
// exercise S7 (network capture) edge cases, and (when STATIC_DIR is set) serves the production
// `ng build` output + falls back to index.html for client-side routing — so `pnpm preview` is a single
// process on one port, the same way a customer would deploy this app.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 5336);
const STATIC_DIR = process.env.STATIC_DIR ?? null;

// ---------------------------------------------------------------------------------------------
// In-memory expense-report store, seeded with real data so the app is genuinely useful on first load.
// ---------------------------------------------------------------------------------------------
const CATEGORIES = ['Travel', 'Meals', 'Software', 'Office supplies', 'Training'];
const expenses = new Map();
const activityLog = [];

function seed() {
  const seeded = [
    { title: 'Flight to re:Invent', amount: 482.5, category: 'Travel', status: 'approved' },
    { title: 'Team lunch', amount: 64.2, category: 'Meals', status: 'approved' },
    { title: 'Figma seats (Q3)', amount: 135, category: 'Software', status: 'pending' },
    { title: 'Conference ticket', amount: 899, category: 'Training', status: 'pending' },
    { title: 'Standing desk', amount: 310.75, category: 'Office supplies', status: 'rejected' },
  ];
  for (const s of seeded) {
    const id = randomUUID();
    expenses.set(id, {
      id,
      title: s.title,
      amount: s.amount,
      category: s.category,
      date: new Date(Date.now() - Math.random() * 30 * 86_400_000).toISOString().slice(0, 10),
      notes: '',
      status: s.status,
      attachment: null,
      createdAt: Date.now(),
    });
  }
}
seed();

function json(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  return JSON.parse(raw);
}

function broadcastActivity(entry) {
  activityLog.unshift(entry);
  activityLog.length = Math.min(activityLog.length, 50);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(entry));
  }
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(STATIC_DIR, rel);
  const fallback = join(STATIC_DIR, 'index.html');
  const target = existsSync(filePath) && statSync(filePath).isFile() ? filePath : fallback;
  if (!existsSync(target)) return json(res, 404, { error: 'not_found', path: pathname });
  const ext = extname(target);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // S10 needs a genuinely CROSS-ORIGIN request that carries a `traceparent` header: the app is served
  // by `ng serve` on :5306 while this API is on :5336, so a direct call here (bypassing the `/api`
  // dev-server proxy) is cross-origin, and `traceparent` is not a CORS-safelisted request header —
  // the browser sends a preflight OPTIONS first and drops the real request unless the preflight
  // allows that header. Without this block the cross-origin half of `s10-echo-headers` could not run
  // at all (and same-origin alone can never falsify `tracePropagationTargets`, which the decorator
  // consults ONLY for cross-origin URLs — packages/capture/src/traceparent.ts:136-142).
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,traceparent,tracestate');
  res.setHeader('Access-Control-Max-Age', '0'); // never let a cached preflight mask a later change
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // ---- S10 exclude probe -----------------------------------------------------------------------
    // Deliberately NOT under `/api/`: `tracePropagationTargets: ['/api/']` (src/app/bugsee.ts) is a
    // substring match against the full URL, so a cross-origin call to THIS path must NOT be decorated.
    // It echoes the received headers exactly like `/api/scenario/echo-headers` does, so the two probes
    // differ in one variable only — whether the URL matches the allowlist.
    if (parts[0] === 'echo-headers-unmatched' && req.method === 'GET') {
      return json(res, 200, req.headers);
    }

    // ---- Scenario routes (S7 network-capture edge cases) --------------------------------------
    if (parts[0] === 'api' && parts[1] === 'scenario') {
      const which = parts[2];
      if (which === 'get' && req.method === 'GET') {
        return json(res, 200, { ok: true, now: Date.now() });
      }
      if (which === 'echo-headers' && req.method === 'GET') {
        // S10: lets the client confirm a traceparent/tracestate header it cannot read off its own
        // outgoing request actually left the process — the server echoes back what it received.
        return json(res, 200, req.headers);
      }
      if (which === 'echo' && req.method === 'POST') {
        const body = await readJsonBody(req);
        return json(res, 200, { received: body });
      }
      if (which === 'echo-text' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(`echo: ${text}`);
      }
      if (which === '4xx') {
        return json(res, 404, { error: 'not_found', message: 'scenario 4xx: no such expense' });
      }
      if (which === '5xx') {
        return json(res, 500, { error: 'internal', message: 'scenario 5xx: simulated failure' });
      }
      if (which === 'no-content-type') {
        res.writeHead(200); // deliberately no Content-Type header
        return res.end('no content-type on this response');
      }
      if (which === 'large-body') {
        // Bigger than the sample's maxNetworkBodySize (see src/app/bugsee.ts) so the SDK's bounded-read
        // must truncate rather than buffer the whole thing.
        const big = 'x'.repeat(64 * 1024);
        return json(res, 200, { big });
      }
      if (which === 'slow') {
        const ms = Number(url.searchParams.get('ms') ?? '3000');
        await new Promise((resolve) => setTimeout(resolve, ms));
        return json(res, 200, { slept: ms });
      }
      if (which === 'sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          res.write(`event: activity\ndata: ${JSON.stringify({ n, at: Date.now() })}\n\n`);
          if (n >= 5) {
            clearInterval(timer);
            res.end();
          }
        }, 200);
        req.on('close', () => clearInterval(timer));
        return;
      }
    }

    // ---- Expense report API ----------------------------------------------------------------------
    if (parts[0] === 'api' && parts[1] === 'categories' && req.method === 'GET') {
      return json(res, 200, CATEGORIES);
    }

    if (parts[0] === 'api' && parts[1] === 'expenses' && parts.length === 2) {
      if (req.method === 'GET') {
        const status = url.searchParams.get('status');
        const all = [...expenses.values()].sort((a, b) => b.createdAt - a.createdAt);
        return json(res, 200, status ? all.filter((e) => e.status === status) : all);
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.title || String(body.title).trim().length < 3) {
          return json(res, 422, { error: 'validation', message: 'title must be at least 3 characters' });
        }
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return json(res, 422, { error: 'validation', message: 'amount must be a positive number' });
        }
        const id = randomUUID();
        const expense = {
          id,
          title: String(body.title),
          amount,
          category: String(body.category ?? CATEGORIES[0]),
          date: String(body.date ?? new Date().toISOString().slice(0, 10)),
          notes: String(body.notes ?? ''),
          status: 'pending',
          attachment: body.attachment ?? null,
          createdAt: Date.now(),
        };
        expenses.set(id, expense);
        broadcastActivity({ type: 'created', id, title: expense.title, at: Date.now() });
        return json(res, 201, expense);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'expenses' && parts.length === 3) {
      const id = parts[2];
      const existing = expenses.get(id);
      if (!existing) return json(res, 404, { error: 'not_found' });
      if (req.method === 'GET') return json(res, 200, existing);
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (body.status && !['pending', 'approved', 'rejected'].includes(body.status)) {
          return json(res, 422, { error: 'validation', message: 'invalid status' });
        }
        const updated = { ...existing, ...body, id };
        expenses.set(id, updated);
        if (body.status && body.status !== existing.status) {
          broadcastActivity({ type: body.status, id, title: updated.title, at: Date.now() });
        }
        return json(res, 200, updated);
      }
      if (req.method === 'DELETE') {
        expenses.delete(id);
        return json(res, 204, undefined);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'activity' && req.method === 'GET') {
      return json(res, 200, activityLog);
    }

    // ---- Static (production preview) ---------------------------------------------------------
    if (STATIC_DIR && parts[0] !== 'api') {
      return serveStatic(req, res, url.pathname);
    }

    json(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    json(res, 500, { error: 'server_error', message: String(error?.message ?? error) });
  }
});

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', message: 'connected to expense activity feed' }));
  for (const entry of activityLog.slice(0, 5)) ws.send(JSON.stringify(entry));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${PORT}${STATIC_DIR ? ` (serving ${STATIC_DIR})` : ''}`);
});
