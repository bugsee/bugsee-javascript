// A small local API for the Kanban app — plain node:http, no framework (the framework under test is
// on the client side: @bugsee/react / @bugsee/vite-plugin / @bugsee/babel-plugin-component-annotate).
// Also hosts a handful of `/api/scenario/*` routes purpose-built to exercise S7 (network capture) edge
// cases: a 4xx, a 5xx, a response with no Content-Type, a body over maxNetworkBodySize, and an SSE feed.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 5330;

// ---------------------------------------------------------------------------------------------
// In-memory Kanban store, seeded with real data so the app is genuinely useful on first load.
// ---------------------------------------------------------------------------------------------
const boards = new Map();
const lists = new Map();
const cards = new Map();

function seed() {
  const board = { id: 'board-1', title: 'Kanbugsee Launch', createdAt: Date.now() };
  boards.set(board.id, board);
  const listDefs = [
    { id: 'list-1', title: 'Backlog', order: 0 },
    { id: 'list-2', title: 'In Progress', order: 1 },
    { id: 'list-3', title: 'Done', order: 2 },
  ];
  for (const l of listDefs) lists.set(l.id, { ...l, boardId: board.id });
  const cardDefs = [
    { id: 'card-1', listId: 'list-1', title: 'Wire BugseeErrorBoundary', order: 0 },
    { id: 'card-2', listId: 'list-1', title: 'Instrument React Router', order: 1 },
    { id: 'card-3', listId: 'list-2', title: 'Add BugseeProfiler to card list', order: 0 },
    { id: 'card-4', listId: 'list-3', title: 'Scaffold the sample', order: 0 },
  ];
  for (const c of cardDefs) {
    cards.set(c.id, {
      ...c,
      boardId: board.id,
      description: '',
      labels: [],
      createdAt: Date.now(),
    });
  }

  const board2 = { id: 'board-2', title: 'Personal errands', createdAt: Date.now() };
  boards.set(board2.id, board2);
  const l2 = { id: 'list-4', boardId: board2.id, title: 'To do', order: 0 };
  lists.set(l2.id, l2);
  cards.set('card-5', {
    id: 'card-5',
    listId: l2.id,
    boardId: board2.id,
    title: 'Buy coffee',
    description: '',
    labels: [],
    order: 0,
    createdAt: Date.now(),
  });
}
seed();

function boardDetail(id) {
  const board = boards.get(id);
  if (!board) return undefined;
  const boardLists = [...lists.values()]
    .filter((l) => l.boardId === id)
    .sort((a, b) => a.order - b.order);
  const boardCards = [...cards.values()].filter((c) => c.boardId === id);
  return { ...board, lists: boardLists, cards: boardCards };
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
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

const server = createServer(async (req, res) => {
  // CORS is unnecessary (same-origin via the Vite proxy), but keep the API usable when hit directly.
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  try {
    // ---- Scenario routes (S7 network-capture edge cases) --------------------------------------
    if (parts[0] === 'api' && parts[1] === 'scenario') {
      const which = parts[2];
      if (which === 'get' && req.method === 'GET') {
        return json(res, 200, { ok: true, now: Date.now() });
      }
      if (which === 'echo-headers' && req.method === 'GET') {
        // S10: lets the browser confirm a traceparent/tracestate header it cannot read off its own
        // outgoing fetch actually left the process — the server echoes back what it received.
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
        return json(res, 404, { error: 'not_found', message: 'scenario 4xx: no such card' });
      }
      if (which === '5xx') {
        return json(res, 500, { error: 'internal', message: 'scenario 5xx: simulated failure' });
      }
      if (which === 'no-content-type') {
        res.writeHead(200); // deliberately no Content-Type header
        return res.end('no content-type on this response');
      }
      if (which === 'large-body') {
        // Bigger than the sample's maxNetworkBodySize (set to 2048 in src/bugsee.ts) so the SDK's
        // bounded-read must truncate rather than buffer the whole thing.
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

    // ---- Kanban REST API ------------------------------------------------------------------------
    if (parts[0] === 'api' && parts[1] === 'boards' && parts.length === 2) {
      if (req.method === 'GET') return json(res, 200, [...boards.values()]);
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const board = { id: randomUUID(), title: String(body.title ?? 'Untitled'), createdAt: Date.now() };
        boards.set(board.id, board);
        return json(res, 201, board);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'boards' && parts.length === 3) {
      const id = parts[2];
      if (req.method === 'GET') {
        const detail = boardDetail(id);
        if (!detail) return json(res, 404, { error: 'not_found' });
        return json(res, 200, detail);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'lists' && parts.length === 2 && req.method === 'POST') {
      const body = await readJsonBody(req);
      const boardLists = [...lists.values()].filter((l) => l.boardId === body.boardId);
      const list = {
        id: randomUUID(),
        boardId: body.boardId,
        title: String(body.title ?? 'Untitled list'),
        order: boardLists.length,
      };
      lists.set(list.id, list);
      return json(res, 201, list);
    }

    if (parts[0] === 'api' && parts[1] === 'cards' && parts.length === 2 && req.method === 'POST') {
      const body = await readJsonBody(req);
      const listCards = [...cards.values()].filter((c) => c.listId === body.listId);
      const card = {
        id: randomUUID(),
        listId: body.listId,
        boardId: body.boardId,
        title: String(body.title ?? 'Untitled card'),
        description: String(body.description ?? ''),
        labels: Array.isArray(body.labels) ? body.labels : [],
        order: listCards.length,
        createdAt: Date.now(),
      };
      cards.set(card.id, card);
      return json(res, 201, card);
    }

    if (parts[0] === 'api' && parts[1] === 'cards' && parts.length === 3) {
      const id = parts[2];
      const existing = cards.get(id);
      if (!existing) return json(res, 404, { error: 'not_found' });
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        // Simulate the occasional server-side validation failure so optimistic-update rollback is a
        // real path a user can hit, not just a code path nobody ever runs.
        if (body.title === '') {
          return json(res, 422, { error: 'validation', message: 'title cannot be empty' });
        }
        const updated = { ...existing, ...body, id, boardId: existing.boardId };
        cards.set(id, updated);
        return json(res, 200, updated);
      }
      if (req.method === 'DELETE') {
        cards.delete(id);
        return json(res, 204, undefined);
      }
      if (req.method === 'GET') return json(res, 200, existing);
    }

    json(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    json(res, 500, { error: 'server_error', message: String(error?.message ?? error) });
  }
});

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', message: 'connected to board activity feed' }));
  ws.on('message', (data) => {
    // Echo + broadcast — a real (if tiny) chat-style feature the board's activity panel uses.
    const text = data.toString();
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(text);
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${PORT}`);
});
