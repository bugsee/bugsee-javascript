// A tiny, deliberately NOT Bugsee-instrumented "third-party service" — stands in for an alerting
// webhook the Metrics API calls when an ingested value crosses a threshold, and doubles as a
// controllable target for the outbound network-capture scenarios (S7) and distributed-tracing
// scenarios (S10). Plain node:http, no framework, so nothing here masks what the SDK's outbound
// interceptor actually sends/receives.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const LARGE_BODY = 'x'.repeat(20_000); // > maxNetworkBodySize (4096) configured in src/bugsee.ts

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export function startThirdPartyService(port: number): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(port);
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const path = url.pathname;

  if (path === '/alert' && req.method === 'POST') {
    const body = await readBody(req);
    let metricName = 'unknown';
    try {
      metricName = (JSON.parse(body) as { name?: string }).name ?? metricName;
    } catch {
      // ignore malformed body — alert dispatch degrades to a default label
    }
    json(res, 200, {
      delivered: true,
      metricName,
      traceparentSeen: req.headers.traceparent ?? null,
    });
    return;
  }
  if (path === '/ok') {
    json(res, 200, { ok: true, receivedAt: Date.now() });
    return;
  }
  if (path === '/not-found') {
    json(res, 404, { error: 'not found' });
    return;
  }
  if (path === '/boom') {
    json(res, 500, { error: 'internal error in third party' });
    return;
  }
  if (path === '/slow') {
    const ms = Number(url.searchParams.get('ms') ?? '50');
    await new Promise((resolve) => setTimeout(resolve, ms));
    json(res, 200, { slept: ms });
    return;
  }
  if (path === '/large') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(LARGE_BODY);
    return;
  }
  if (path === '/no-content-type') {
    res.writeHead(200, {});
    res.end('no content type here');
    return;
  }
  if (path === '/echo-headers') {
    json(res, 200, { headers: req.headers });
    return;
  }
  json(res, 404, { error: 'unknown third-party route' });
}
