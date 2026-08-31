// A small local API for the Markdown Notes app — plain node:http, no framework (the package under
// test is the webpack SOURCE-MAP plugin, on the client build side). Serves:
//   - a genuine feature: GET /api/prompt (a random writing-prompt suggestion for a new note) and
//     POST /api/backup (a fake "backup my notes" sync target the app's Backup button posts to);
//   - a handful of /api/scenario/* routes purpose-built to exercise S7 (network capture) edge cases:
//     a 4xx, a 5xx, a response with no Content-Type, a body over maxNetworkBodySize, a connection
//     failure target, and an SSE feed;
//   - a WebSocket "presence" channel (S7 WS coverage) — a trivial broadcast of "someone is editing".
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 5346;

const PROMPTS = [
  'Describe a tool you use every day as if explaining it to someone from 200 years ago.',
  'Write down the last dream you remember, in present tense.',
  'What is the smallest decision you made today that you are proud of?',
  'List three things that are true right now, in this room.',
  'Draft the opening line of a book you will never finish.',
];

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
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/api/prompt' && req.method === 'GET') {
    const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    json(res, 200, { prompt });
    return;
  }

  if (url.pathname === '/api/backup' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const count = Array.isArray(body.notes) ? body.notes.length : 0;
    json(res, 200, { ok: true, count, backedUpAt: new Date().toISOString(), id: randomUUID() });
    return;
  }

  // ---- S7 network-capture edge cases -----------------------------------------------------------
  if (url.pathname === '/api/scenario/echo' && req.method === 'POST') {
    const body = await readJsonBody(req);
    json(res, 200, { received: body });
    return;
  }

  if (url.pathname === '/api/scenario/text' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('plain text response for S7 GET/text-body coverage');
    return;
  }

  if (url.pathname === '/api/scenario/4xx') {
    json(res, 404, { error: 'not_found', message: 'S7: deliberate 404' });
    return;
  }

  if (url.pathname === '/api/scenario/5xx') {
    json(res, 500, { error: 'internal', message: 'S7: deliberate 500' });
    return;
  }

  if (url.pathname === '/api/scenario/no-content-type') {
    res.writeHead(200, {});
    res.end('{"ok":true,"note":"no Content-Type header on purpose"}');
    return;
  }

  if (url.pathname === '/api/scenario/large-body') {
    const big = 'x'.repeat(64 * 1024);
    json(res, 200, { big });
    return;
  }

  if (url.pathname === '/api/scenario/echo-headers') {
    json(res, 200, { headers: req.headers });
    return;
  }

  if (url.pathname === '/api/scenario/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let i = 0;
    const iv = setInterval(() => {
      i += 1;
      res.write(`data: ${JSON.stringify({ tick: i, at: Date.now() })}\n\n`);
      if (i >= 5) {
        clearInterval(iv);
        res.end();
      }
    }, 150);
    req.on('close', () => clearInterval(iv));
    return;
  }

  json(res, 404, { error: 'not_found' });
});

const wss = new WebSocketServer({ server, path: '/api/presence' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', message: 'connected to presence channel' }));
  ws.on('message', (data) => {
    const text = data.toString();
    // Broadcast to every OTHER connected client — a minimal "someone is editing" indicator.
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === client.OPEN) {
        client.send(text);
      }
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${PORT}`);
});
