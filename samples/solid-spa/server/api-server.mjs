// A small local API for the Bug tracker app — plain node:http, no framework (the framework under
// test is on the client side: @bugsee/solid). Also hosts a handful of `/api/scenario/*` routes
// purpose-built to exercise S7 (network capture) edge cases: a 4xx, a 5xx, a response with no
// Content-Type, a body over maxNetworkBodySize, and an SSE feed.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 5337;

// ---------------------------------------------------------------------------------------------
// In-memory issue tracker store, seeded with real data so the app is genuinely useful on first
// load.
// ---------------------------------------------------------------------------------------------
const issues = new Map();
const comments = new Map();

function seed() {
  const defs = [
    {
      id: 'issue-1',
      title: 'solidErrorHandler swallows the stack on a nested cause',
      description: 'Reported by a customer running @bugsee/solid 0.1.0 — see the repro steps in the comments.',
      status: 'open',
      severity: 'high',
      assignee: 'ava',
      labels: ['sdk', 'error-reporting'],
    },
    {
      id: 'issue-2',
      title: 'Nested /issues/:id/comments route 404s on hard refresh',
      description: 'A hard reload on the comments tab of an issue detail page 404s instead of resolving client-side.',
      status: 'open',
      severity: 'medium',
      assignee: 'ben',
      labels: ['router'],
    },
    {
      id: 'issue-3',
      title: 'createResource fetcher error is not user-visible',
      description: 'When the issue detail resource rejects, the page renders blank instead of an error state.',
      status: 'open',
      severity: 'critical',
      assignee: 'ava',
      labels: ['ux', 'resources'],
    },
    {
      id: 'issue-4',
      title: 'Filter panel does not reset on navigation',
      description: 'Switching boards keeps the previous severity filter applied.',
      status: 'closed',
      severity: 'low',
      assignee: 'cleo',
      labels: ['ux'],
    },
    {
      id: 'issue-5',
      title: 'Route pattern naming reports the concrete URL, not the pattern',
      description: 'Transaction names show /issues/issue-77 instead of /issues/:id.',
      status: 'closed',
      severity: 'medium',
      assignee: 'ben',
      labels: ['performance', 'router'],
    },
  ];
  const now = Date.now();
  defs.forEach((d, i) => issues.set(d.id, { ...d, createdAt: now - (defs.length - i) * 86_400_000 }));

  const commentDefs = [
    { id: 'comment-1', issueId: 'issue-1', author: 'ben', body: 'Can repro on 0.1.0, cause chain is dropped after the 2nd link.' },
    { id: 'comment-2', issueId: 'issue-1', author: 'ava', body: 'Looking into it — likely the mechanism override path.' },
    { id: 'comment-3', issueId: 'issue-3', author: 'cleo', body: 'This is the one blocking the release, please prioritize.' },
  ];
  commentDefs.forEach((c, i) => comments.set(c.id, { ...c, createdAt: now - (commentDefs.length - i) * 3_600_000 }));
}
seed();

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
      if (which === 'veto-body-target' && req.method === 'POST') {
        // F-1 (samples/solid-spa/FINDINGS.md) demo target: a FIXED response, deliberately NOT echoing
        // the request body — so a network filter that vetoes on a REQUEST-BODY marker (only present on
        // the `before` NetworkStage) cannot "accidentally" also veto the response's `complete`
        // stage-entry by the same body-content check. Proves the veto is per-entry, not per-request.
        await readJsonBody(req);
        return json(res, 200, { ok: true, note: 'fixed response, unrelated to the request body' });
      }
      if (which === 'echo-text' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(`echo: ${text}`);
      }
      if (which === '4xx') {
        return json(res, 404, { error: 'not_found', message: 'scenario 4xx: no such issue' });
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

    // ---- Bug tracker REST API ---------------------------------------------------------------
    if (parts[0] === 'api' && parts[1] === 'issues' && parts.length === 2) {
      if (req.method === 'GET') {
        let list = [...issues.values()];
        const status = url.searchParams.get('status');
        const severity = url.searchParams.get('severity');
        const q = url.searchParams.get('q');
        if (status) list = list.filter((i) => i.status === status);
        if (severity) list = list.filter((i) => i.severity === severity);
        if (q) list = list.filter((i) => i.title.toLowerCase().includes(q.toLowerCase()));
        list.sort((a, b) => b.createdAt - a.createdAt);
        return json(res, 200, list);
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const issue = {
          id: randomUUID(),
          title: String(body.title ?? 'Untitled issue'),
          description: String(body.description ?? ''),
          status: 'open',
          severity: ['low', 'medium', 'high', 'critical'].includes(body.severity) ? body.severity : 'medium',
          assignee: String(body.assignee ?? 'unassigned'),
          labels: Array.isArray(body.labels) ? body.labels : [],
          createdAt: Date.now(),
        };
        issues.set(issue.id, issue);

        for (const client of wss.clients) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'issue_created', issue }));
          }
        }
        return json(res, 201, issue);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'issues' && parts.length === 3) {
      const id = parts[2];
      const existing = issues.get(id);
      if (!existing) return json(res, 404, { error: 'not_found', message: `no such issue: ${id}` });
      if (req.method === 'GET') return json(res, 200, existing);
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (body.title === '') {
          return json(res, 422, { error: 'validation', message: 'title cannot be empty' });
        }
        const updated = { ...existing, ...body, id };
        issues.set(id, updated);
        for (const client of wss.clients) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'issue_updated', issue: updated }));
          }
        }
        return json(res, 200, updated);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'issues' && parts.length === 4 && parts[3] === 'comments') {
      const issueId = parts[2];
      if (!issues.has(issueId)) return json(res, 404, { error: 'not_found', message: `no such issue: ${issueId}` });
      if (req.method === 'GET') {
        const list = [...comments.values()]
          .filter((c) => c.issueId === issueId)
          .sort((a, b) => a.createdAt - b.createdAt);
        return json(res, 200, list);
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const comment = {
          id: randomUUID(),
          issueId,
          author: String(body.author ?? 'anonymous'),
          body: String(body.body ?? ''),
          createdAt: Date.now(),
        };
        comments.set(comment.id, comment);
        for (const client of wss.clients) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'comment_added', comment }));
          }
        }
        return json(res, 201, comment);
      }
    }

    json(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    json(res, 500, { error: 'server_error', message: String(error?.message ?? error) });
  }
});

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', message: 'connected to issue activity feed' }));
  ws.on('message', (data) => {
    // Echo + broadcast — a real (if tiny) chat-style feature the tracker's activity panel uses.
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
