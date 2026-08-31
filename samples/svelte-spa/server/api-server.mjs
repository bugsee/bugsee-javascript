// A small local API for the Habit tracker — plain node:http, no framework (the framework under test is
// on the client side: @bugsee/svelte / @bugsee/svelte-plugin-component-annotate). Also hosts a handful
// of `/api/scenario/*` routes purpose-built to exercise S7 (network capture) edge cases: a 4xx, a 5xx, a
// response with no Content-Type, a body over maxNetworkBodySize, and an SSE feed — mirrors
// samples/react-spa/server/api-server.mjs so the two samples' network-capture coverage is comparable.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 5334;

// ---------------------------------------------------------------------------------------------
// In-memory habit store, seeded with real data so the app is genuinely useful on first load.
// ---------------------------------------------------------------------------------------------
const habits = new Map();

function todayIso(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function seed() {
  const defs = [
    { id: 'habit-1', name: 'Drink water', category: 'health', color: '#3b82f6', targetPerWeek: 7 },
    { id: 'habit-2', name: 'Read 20 minutes', category: 'mind', color: '#8b5cf6', targetPerWeek: 5 },
    { id: 'habit-3', name: 'Stretch', category: 'health', color: '#10b981', targetPerWeek: 4 },
  ];
  for (const def of defs) {
    const checkins = new Set();
    // A believable recent streak plus a gap further back, so the heat map + stats are not all-zero.
    for (let i = 1; i <= 6; i += 1) checkins.add(todayIso(-i));
    for (let i = 10; i <= 12; i += 1) checkins.add(todayIso(-i));
    habits.set(def.id, { ...def, createdAt: Date.now() - 30 * 86400_000, checkins });
  }
}
seed();

function computeStreak(checkins) {
  let streak = 0;
  for (let i = 0; ; i += 1) {
    if (checkins.has(todayIso(-i))) streak += 1;
    else break;
  }
  let longest = 0;
  let running = 0;
  const sorted = [...checkins].sort();
  let prev;
  for (const day of sorted) {
    if (prev !== undefined) {
      const prevDate = new Date(`${prev}T00:00:00Z`);
      const curDate = new Date(`${day}T00:00:00Z`);
      const diffDays = Math.round((curDate - prevDate) / 86400_000);
      running = diffDays === 1 ? running + 1 : 1;
    } else {
      running = 1;
    }
    longest = Math.max(longest, running);
    prev = day;
  }
  return { current: streak, longest };
}

function serializeHabit(h) {
  const { current, longest } = computeStreak(h.checkins);
  return {
    id: h.id,
    name: h.name,
    category: h.category,
    color: h.color,
    targetPerWeek: h.targetPerWeek,
    createdAt: h.createdAt,
    checkins: [...h.checkins].sort(),
    currentStreak: current,
    longestStreak: longest,
  };
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

let wss; // assigned below, referenced here so REST handlers can broadcast

/** The most recent `/api/scenario/beacon` POST (S7 sendBeacon), read back by `/api/scenario/beacon-log`. */
let lastBeacon = null;

const server = createServer(async (req, res) => {
  // CORS is unnecessary (same-origin via the Vite proxy), but keep the API usable when hit directly.
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  try {
    // ---- S10 EXCLUDE probe -------------------------------------------------------------------
    // Deliberately NOT under `/api/`, and reached CROSS-ORIGIN (the app runs on :5304 and hits this
    // origin, :5334, directly instead of through Vite's `/api` proxy). Both halves matter: the path is
    // the one URL in the sample that `tracePropagationTargets: ['/api/']` does not match, so it is the
    // only place the EXCLUDE half of that allow-list is observable at all.
    //
    // The CORS handling below is not decoration. `traceparent`/`tracestate` are NOT CORS-safelisted
    // request headers, so if the allow-list ever regressed and the SDK stamped them onto this call, the
    // browser would fire a preflight — and without an OPTIONS handler that preflight fails, the fetch
    // rejects, and the check would fail with an opaque network error instead of the evidence ("the
    // traceparent came back") that names the actual defect. Allowing them here means the broken case
    // produces a readable, asserted-on result.
    if (url.pathname === '/trace-exclude-probe') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET,OPTIONS',
          'Access-Control-Allow-Headers': 'traceparent,tracestate,baggage,content-type',
          'Access-Control-Max-Age': '0',
        });
        return res.end();
      }
      if (req.method === 'GET') return json(res, 200, req.headers);
    }

    // ---- Scenario routes (S7 network-capture edge cases) --------------------------------------
    if (parts[0] === 'api' && parts[1] === 'scenario') {
      const which = parts[2];
      if (which === 'get' && req.method === 'GET') {
        return json(res, 200, { ok: true, now: Date.now() });
      }
      if (which === 'echo-headers' && req.method === 'GET') {
        // S10: lets the app confirm a traceparent/tracestate header it cannot read off its own
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
      // S7 `navigator.sendBeacon`. Two routes, because a beacon is fire-and-forget by design: the
      // browser's `sendBeacon()` returns only "the user agent QUEUED this", never "the server got it",
      // so the app cannot prove the payload left the process from its own return value alone. `beacon`
      // absorbs the POST and records it; `beacon-log` hands it back over an ordinary GET, which is what
      // lets the Scenario panel's status line be real round-trip evidence (the same reason the S7 ws
      // control reports only the message carrying its own nonce).
      if (which === 'beacon' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        lastBeacon = {
          tag: url.searchParams.get('tag'),
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: req.headers['content-type'] ?? null,
          at: Date.now(),
        };
        // 204: a beacon's response is discarded by the user agent, so there is nothing useful to send.
        return json(res, 204, undefined);
      }
      if (which === 'beacon-log' && req.method === 'GET') {
        return json(res, 200, { last: lastBeacon });
      }
      if (which === '4xx') {
        return json(res, 404, { error: 'not_found', message: 'scenario 4xx: no such habit' });
      }
      if (which === '5xx') {
        return json(res, 500, { error: 'internal', message: 'scenario 5xx: simulated failure' });
      }
      if (which === 'no-content-type') {
        res.writeHead(200); // deliberately no Content-Type header
        return res.end('no content-type on this response');
      }
      if (which === 'large-body') {
        // Bigger than the sample's maxNetworkBodySize (2048, set in src/bugsee.ts) so the SDK's
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

    // ---- Habit tracker REST API ------------------------------------------------------------------
    if (parts[0] === 'api' && parts[1] === 'habits' && parts.length === 2) {
      if (req.method === 'GET') return json(res, 200, [...habits.values()].map(serializeHabit));
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const habit = {
          id: randomUUID(),
          name: String(body.name ?? 'Untitled habit'),
          category: String(body.category ?? 'general'),
          color: String(body.color ?? '#64748b'),
          targetPerWeek: Number(body.targetPerWeek ?? 7),
          createdAt: Date.now(),
          checkins: new Set(),
        };
        habits.set(habit.id, habit);
        return json(res, 201, serializeHabit(habit));
      }
    }

    if (parts[0] === 'api' && parts[1] === 'habits' && parts.length === 3) {
      const id = parts[2];
      const habit = habits.get(id);
      if (!habit) return json(res, 404, { error: 'not_found' });
      if (req.method === 'GET') return json(res, 200, serializeHabit(habit));
      if (req.method === 'DELETE') {
        habits.delete(id);
        return json(res, 204, undefined);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'habits' && parts[3] === 'toggle' && parts.length === 4) {
      const id = parts[2];
      const habit = habits.get(id);
      if (!habit) return json(res, 404, { error: 'not_found' });
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const date = String(body.date ?? todayIso());
        // Simulate the occasional server-side validation failure so optimistic-update rollback is a
        // real path a user can hit, not just a code path nobody ever runs.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return json(res, 422, { error: 'validation', message: 'date must be YYYY-MM-DD' });
        }
        const now = habit.checkins.has(date);
        if (now) habit.checkins.delete(date);
        else habit.checkins.add(date);
        const serialized = serializeHabit(habit);
        const event = { type: 'checkin', habitId: id, habitName: habit.name, date, checked: !now, at: Date.now() };
        if (wss) {
          for (const client of wss.clients) {
            if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
          }
        }
        return json(res, 200, serialized);
      }
    }

    json(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    json(res, 500, { error: 'server_error', message: String(error?.message ?? error) });
  }
});

wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', message: 'connected to habit activity feed' }));
  ws.on('message', (data) => {
    // Echo + broadcast — lets the client's own manual chat-style S7 WebSocket check round-trip too.
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
