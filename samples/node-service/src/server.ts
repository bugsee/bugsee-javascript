// The "Link shortener" service — plain node:http, no framework, so @bugsee/node is the subject under
// test. Real endpoints (create/resolve/stats/dashboard) live alongside a "scenario panel" of HTTP
// routes (§3 convention: a server sample exposes the panel as routes, not a UI) that exercise every
// catalog scenario in docs/samples/PLAN.md §4. See scenarios.md for the full id -> route mapping.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestContextStoreToken } from '@bugsee/node';
import { WebSocketServer } from 'ws';
import { initBugsee } from './bugsee-client.ts';
import { startExpireJob } from './expire-job.ts';
import { LinkStore } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const PORT = Number(process.env.PORT ?? 5305);

let otelSpanProcessorRef: import('@bugsee/opentelemetry').BugseeSpanProcessor | undefined;
const { client, profile, appBuild } = initBugsee(undefined, {
  onOtelSpanProcessor: (sp) => {
    otelSpanProcessorRef = sp;
  },
});
client.launch();
// eslint-disable-next-line no-console
console.log(`[bugsee] launched — profile=${profile} appBuild=${appBuild} isLaunched=${client.isLaunched()}`);

const store = new LinkStore(process.env.LINKS_FILE ?? join(root, 'data', 'links.json'));
const stopExpireJob = startExpireJob(store, client);

const dashboardHtml = readFileSync(join(root, 'public', 'dashboard.html'), 'utf8');

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------------------------------
// Real application endpoints
// ---------------------------------------------------------------------------------------------------

async function handleCreateLink(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: { url?: string; ttlMs?: number | null };
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    json(res, 400, { error: 'invalid JSON body' });
    return;
  }
  if (!parsed.url || typeof parsed.url !== 'string') {
    json(res, 400, { error: 'url is required' });
    return;
  }
  const record = store.create(parsed.url, parsed.ttlMs ?? null);
  client.event('link.created', { code: record.code, hasTtl: record.expiresAt !== null });
  json(res, 201, record);
}

function handleResolve(code: string, res: import('node:http').ServerResponse): void {
  const record = store.resolve(code);
  if (record === undefined) {
    json(res, 404, { error: 'not found or expired' });
    return;
  }
  res.writeHead(302, { location: record.url });
  res.end();
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S1 launch/lifecycle
// ---------------------------------------------------------------------------------------------------

async function scenarioS1(action: string, res: import('node:http').ServerResponse): Promise<void> {
  switch (action) {
    case 'isLaunched':
      json(res, 200, { isLaunched: client.isLaunched() });
      return;
    case 'relaunch-ignored': {
      const before = client.isLaunched();
      client.launch(); // second launch while already launched — must be a no-op, not a duplicate
      json(res, 200, { before, after: client.isLaunched(), note: 'second launch() must be idempotent' });
      return;
    }
    case 'flush': {
      const ok = await client.flush(5000);
      json(res, 200, { flushed: ok });
      return;
    }
    default:
      json(res, 400, { error: `unknown S1 action ${action}` });
  }
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S2 identity & attributes
// ---------------------------------------------------------------------------------------------------

function scenarioS2(marker: string, res: import('node:http').ServerResponse): void {
  client.setAttribute('s2.string', `str-${marker}`);
  client.setAttribute('s2.number', 42);
  client.setAttribute('s2.boolean', true);
  client.setAttribute('s2.stringArray', ['a', 'b', marker]);
  const before = client.getAllAttributes();
  client.setUserIdentifier(`s2-user-${marker}`);
  const user = client.getUserIdentifier();
  void client
    .logException(new Error(`S2 identity+attributes marker=${marker}`), {
      mechanism: 'programmatic',
      labels: ['scenario:s2', `marker:${marker}`],
    })
    .then(() => {
      // Set an attribute AFTER the triggering event too (catalog requirement: before AND after).
      client.setAttribute('s2.afterEvent', marker);
    })
    .catch(() => {});
  client.setUserIdentifier('sample-user@bugsee.dev'); // restore the sample-wide identity
  json(res, 200, { before, user, marker });
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S3 manual telemetry
// ---------------------------------------------------------------------------------------------------

function scenarioS3(marker: string, res: import('node:http').ServerResponse): void {
  client.log(`verbose log ${marker}`, 'verbose');
  client.log(`debug log ${marker}`, 'debug');
  client.log(`info log ${marker}`, 'info');
  client.log(`warning log ${marker}`, 'warning');
  client.log(`error log ${marker}`, 'error');
  client.event('scenario.s3.no_params', undefined);
  client.event('scenario.s3.with_params', { marker, count: 3 });
  client.trace('scenario.s3.trace', { marker, value: Math.random() });
  client.addBreadcrumb({
    type: 'navigation',
    category: 'scenario',
    message: `breadcrumb ${marker}`,
    level: 'info',
    data: { marker, every: 'field' },
  });
  void client.logException(new Error(`S3 telemetry marker=${marker}`), { labels: ['scenario:s3'] }).catch(() => {});
  json(res, 200, { marker });
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S4 exceptions
// ---------------------------------------------------------------------------------------------------

// The upload always fails on this staging app-type (see FINDINGS.md — the javascript app-type gate),
// so every logException() runs its FULL internal retry+backoff cycle (tens of seconds) before its
// promise settles. Scenario endpoints therefore fire-and-forget by default (report accepted=true
// immediately — matches real "don't block the request on telemetry" usage); pass `?sync=1` to await
// the local result instead (used sparingly, e.g. to inspect the dedupe/veto/rate-limit outcomes).
async function scenarioS4(
  kind: string,
  marker: string,
  sync: boolean,
  res: import('node:http').ServerResponse,
): Promise<void> {
  switch (kind) {
    case 'error': {
      const p = client.logException(new Error(`S4 error marker=${marker}`)).catch(() => ({ ok: false as const }));
      const r = sync ? await p : undefined;
      json(res, 200, { kind, marker, accepted: true, ...(r !== undefined ? { result: r } : {}) });
      return;
    }
    case 'string': {
      const p = client.logException(`S4 string throwable marker=${marker}`).catch(() => ({ ok: false as const }));
      const r = sync ? await p : undefined;
      json(res, 200, { kind, marker, accepted: true, ...(r !== undefined ? { result: r } : {}) });
      return;
    }
    case 'object': {
      const p = client.logException({ code: 'S4_OBJECT', marker }).catch(() => ({ ok: false as const }));
      const r = sync ? await p : undefined;
      json(res, 200, { kind, marker, accepted: true, ...(r !== undefined ? { result: r } : {}) });
      return;
    }
    case 'null': {
      const p = client.logException(null).catch(() => ({ ok: false as const }));
      const r = sync ? await p : undefined;
      json(res, 200, { kind, marker, accepted: true, ...(r !== undefined ? { result: r } : {}) });
      return;
    }
    case 'cause': {
      const inner = new Error(`S4 inner cause marker=${marker}`);
      const outer = new Error(`S4 outer marker=${marker}`, { cause: inner });
      const p = client
        .logException(outer, { mechanism: 'programmatic', severity: 'high', labels: ['scenario:s4', 'cause-chain'] })
        .catch(() => ({ ok: false as const }));
      const r = sync ? await p : undefined;
      json(res, 200, { kind, marker, accepted: true, ...(r !== undefined ? { result: r } : {}) });
      return;
    }
    case 'dedupe': {
      const err = new Error(`S4 dedupe marker=${marker}`);
      const p1 = client.logException(err).catch(() => ({ ok: false as const })); // fire both back-to-back —
      const p2 = client.logException(err).catch(() => ({ ok: false as const })); // dedup check runs sync, before either awaits
      const [r1, r2] = sync ? await Promise.all([p1, p2]) : [undefined, undefined];
      json(res, 200, { kind, marker, accepted: true, ...(r1 !== undefined ? { first: r1, second: r2 } : {}) });
      return;
    }
    case 'storm': {
      // Fire all 200 without awaiting any of them: the rate-limiter's accept/reject decision is
      // synchronous (before any network I/O), so what we're really timing here is LOCAL survival —
      // the app must stay responsive through 200 synchronous logException() calls in one tick.
      const start = process.hrtime.bigint();
      for (let i = 0; i < 200; i += 1) {
        client.logException(new Error(`S4 storm ${i} marker=${marker}`)).catch(() => {});
      }
      const localMs = Number(process.hrtime.bigint() - start) / 1e6;
      json(res, 200, { kind, marker, count: 200, localMs, note: 'must rate-limit, not crash the app' });
      return;
    }
    default:
      json(res, 400, { error: `unknown S4 kind ${kind}` });
  }
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S6 console capture
// ---------------------------------------------------------------------------------------------------

function scenarioS6(marker: string, res: import('node:http').ServerResponse): void {
  console.log('S6 console.log', marker, { nested: { a: 1 } });
  console.info('S6 console.info', marker);
  console.warn('S6 console.warn', marker);
  console.error('S6 console.error', marker);
  console.debug('S6 console.debug', marker);
  console.trace('S6 console.trace', marker);
  const circular: Record<string, unknown> = { marker };
  circular.self = circular;
  console.log('S6 circular object', circular);
  json(res, 200, { marker });
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S7 network capture (loopback echo endpoints so the sample needs no internet access)
// ---------------------------------------------------------------------------------------------------

async function scenarioS7(kind: string, marker: string, res: import('node:http').ServerResponse): Promise<void> {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    switch (kind) {
      case 'get': {
        const r = await fetch(`${base}/echo/json?marker=${marker}`);
        const body = await r.json();
        json(res, 200, { kind, status: r.status, body });
        return;
      }
      case 'post': {
        const r = await fetch(`${base}/echo/json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ marker, hello: 'world' }),
        });
        const body = await r.json();
        json(res, 200, { kind, status: r.status, body });
        return;
      }
      case 'post-text': {
        const r = await fetch(`${base}/echo/text`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: `text body ${marker}`,
        });
        const body = await r.text();
        json(res, 200, { kind, status: r.status, body });
        return;
      }
      case '4xx': {
        const r = await fetch(`${base}/echo/4xx?marker=${marker}`);
        json(res, 200, { kind, status: r.status });
        return;
      }
      case '5xx': {
        const r = await fetch(`${base}/echo/5xx?marker=${marker}`);
        json(res, 200, { kind, status: r.status });
        return;
      }
      case 'fail': {
        try {
          await fetch('http://127.0.0.1:1/unreachable');
          json(res, 200, { kind, note: 'expected a connection failure, got a response' });
        } catch (error) {
          json(res, 200, { kind, failed: true, message: (error as Error).message });
        }
        return;
      }
      case 'bigbody': {
        const r = await fetch(`${base}/echo/big`);
        const text = await r.text();
        json(res, 200, { kind, status: r.status, length: text.length });
        return;
      }
      case 'notype': {
        const r = await fetch(`${base}/echo/notype`);
        const text = await r.text();
        json(res, 200, { kind, status: r.status, contentType: r.headers.get('content-type'), text });
        return;
      }
      case 'ws': {
        const result = await new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
          ws.addEventListener('open', () => ws.send(`ping ${marker}`));
          ws.addEventListener('message', (ev: MessageEvent) => {
            ws.close();
            resolve(ev.data);
          });
          ws.addEventListener('error', (ev) => reject(ev));
        });
        json(res, 200, { kind, echoed: result });
        return;
      }
      default:
        json(res, 400, { error: `unknown S7 kind ${kind}` });
    }
  } catch (error) {
    json(res, 500, { kind, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S8 filters & redaction (demonstrated on a dedicated route so the default filters
// used by the rest of the scenario panel stay unaffected)
// ---------------------------------------------------------------------------------------------------

function scenarioS8(marker: string, res: import('node:http').ServerResponse): void {
  client.setNetworkEventFilter((event) => {
    if (event.custom?.headers) {
      const { authorization, ...rest } = event.custom.headers;
      void authorization;
      event.custom.headers = rest;
    }
    if (event.custom?.body) {
      event.custom.body = event.custom.body.replace(/"secret":"[^"]*"/, '"secret":"[REDACTED]"');
    }
    if (event.url.includes('veto-me')) return null; // veto entirely
    return event;
  });
  client.setLogEventFilter((event) => {
    if (event.message.includes('DROP_ME')) return null;
    if (event.message.includes('REDACT_ME')) {
      return { ...event, message: event.message.replace(/token=\S+/, 'token=[REDACTED]') };
    }
    return event;
  });
  client.setBreadcrumbFilter((crumb) => (crumb.message?.includes('DROP_CRUMB') ? null : crumb));
  client.setReportHandler({
    before: (request) => {
      if (request.report.summary?.includes('VETO_REPORT')) return null;
      return request;
    },
  });

  // Exercise every filter.
  client.log(`token=SUPER-SECRET-${marker} REDACT_ME`, 'info');
  client.log(`this should never arrive DROP_ME ${marker}`, 'info');
  client.addBreadcrumb({ message: `should be dropped DROP_CRUMB ${marker}`, level: 'info', category: 'test' });
  void client.logException(new Error(`S8 VETO_REPORT should be vetoed ${marker}`)).catch(() => {});
  void client
    .logException(new Error(`S8 redaction target marker=${marker}`), {
      labels: ['scenario:s8'],
    })
    .catch(() => {});
  void fetch(`http://127.0.0.1:${PORT}/echo/json?veto-me=1&marker=${marker}`).catch(() => {});
  void fetch(`http://127.0.0.1:${PORT}/echo/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret-token' },
    body: JSON.stringify({ secret: `should-be-redacted-${marker}`, marker }),
  }).catch(() => {});

  json(res, 200, { marker, note: 'filters installed + exercised; assert redacted values are absent on the backend' });
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S9 performance / APM
// ---------------------------------------------------------------------------------------------------

function scenarioS9(marker: string, res: import('node:http').ServerResponse): void {
  const perf = client.ext('performance');
  const txn = perf.startTransaction({ name: `manual.s9.${marker}`, operation: 'test' });
  const child1 = txn.startChildSpan('child.ok', 'first child');
  child1.finish('OK');
  const child2 = txn.startChildSpan('child.error', 'second child');
  child2.setStatus('ERROR');
  child2.finish();
  const child3 = txn.startChildSpan('child.cancelled');
  child3.finish('CANCELLED');
  const child4 = txn.startChildSpan('child.timeout');
  child4.finish('TIMEOUT');
  const child5 = txn.startChildSpan('child.deadline');
  child5.finish('DEADLINE_EXCEEDED');
  perf.setRouteName(`/manual/${marker}`);
  txn.finish('OK');
  json(res, 200, { marker, transaction: txn.getName() });
}

// ---------------------------------------------------------------------------------------------------
// Scenario panel — S13 OpenTelemetry consume (a hand-rolled ReadableSpanLike, since the produce
// direction is the umbrella's otelExportUrl option, exercised via the otel-produce profile instead)
// ---------------------------------------------------------------------------------------------------

function scenarioS13Consume(marker: string, res: import('node:http').ServerResponse): void {
  if (otelSpanProcessorRef === undefined) {
    json(res, 400, { error: 'otelConsume is not enabled on this profile (see config/launch.default.json)' });
    return;
  }
  const traceId = randomUUID().replace(/-/g, '');
  const rootSpanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const childSpanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();
  const toHr = (ms: number): [number, number] => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];
  otelSpanProcessorRef.onEnd({
    spanContext: () => ({ traceId, spanId: childSpanId }),
    parentSpanId: rootSpanId,
    name: `external-otel.child.${marker}`,
    startTime: toHr(now),
    endTime: toHr(now + 5),
    status: { code: 1 },
    attributes: { marker },
  });
  otelSpanProcessorRef.onEnd({
    spanContext: () => ({ traceId, spanId: rootSpanId }),
    name: `external-otel.root.${marker}`,
    startTime: toHr(now),
    endTime: toHr(now + 10),
    status: { code: 1 },
    attributes: { marker, 'external.sdk': true },
  });
  json(res, 200, { marker, traceId, note: 'a fake external OTel SDK root+child span was fed to onOtelSpanProcessor' });
}

// ---------------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------------

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const marker = url.searchParams.get('marker') ?? randomUUID();
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(dashboardHtml);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, isLaunched: client.isLaunched(), profile, appBuild });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/links') {
        json(res, 200, store.list());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        json(res, 200, store.stats());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/links') {
        await handleCreateLink(req, res);
        return;
      }

      // ---- admin -------------------------------------------------------------------------------
      if (url.pathname === '/admin/flush') {
        const ok = await client.flush(Number(url.searchParams.get('timeout') ?? 5000));
        json(res, 200, { flushed: ok });
        return;
      }
      if (url.pathname === '/admin/context-check') {
        const store2 = client.getService(RequestContextStoreToken);
        const current = store2.getCurrent();
        json(res, 200, { hasContext: current !== undefined, contextId: current?.contextId ?? null });
        return;
      }
      // Per-request context under concurrency (§5.13): the auto-instrumentation (instrumentIncomingRequests)
      // already opened a per-request context for THIS request before the handler ran; stamp a
      // caller-supplied attribute onto it and fire a report so the report's merged attributes prove
      // isolation across N concurrent requests (no cross-contamination between async call-chains).
      if (url.pathname === '/scenario/s-concurrency') {
        const id = url.searchParams.get('id') ?? 'unknown';
        const store2 = client.getService(RequestContextStoreToken);
        store2.setAttribute('request.concurrency_id', id);
        const contextId = store2.getCurrent()?.contextId ?? null;
        client
          .logException(new Error(`concurrency scenario id=${id}`), { labels: ['scenario:s-concurrency', `id:${id}`] })
          .catch(() => {});
        json(res, 200, { id, contextId });
        return;
      }

      // ---- demanding scenarios: profiling + hang detection --------------------------------------
      if (url.pathname === '/burn') {
        const ms = Number(url.searchParams.get('ms') ?? 2000);
        const end = Date.now() + ms;
        let x = 0;
        while (Date.now() < end) {
          x += Math.sqrt(x + 1) * Math.random(); // CPU-bound spin — samples for profile.json
        }
        json(res, 200, { burned_ms: ms, x });
        return;
      }
      if (url.pathname === '/block') {
        const ms = Number(url.searchParams.get('ms') ?? 3000);
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, ms); // synchronous event-loop block (ANR)
        json(res, 200, { blocked_ms: ms });
        return;
      }

      // ---- echo endpoints for S7 -----------------------------------------------------------------
      if (url.pathname === '/echo/json') {
        const body = req.method === 'POST' ? await readBody(req) : '{}';
        json(res, 200, {
          method: req.method,
          query: Object.fromEntries(url.searchParams),
          body: body ? JSON.parse(body) : null,
          // S10 evidence: echo back trace-propagation headers so a caller (curl, verify.ts, a human)
          // can see whether propagateTrace + tracePropagationTargets actually decorated this request.
          traceparent: req.headers['traceparent'] ?? null,
          tracestate: req.headers['tracestate'] ?? null,
        });
        return;
      }
      if (url.pathname === '/echo/text') {
        const body = await readBody(req);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`echo: ${body}`);
        return;
      }
      if (url.pathname === '/echo/4xx') {
        json(res, 404, { error: 'not found (intentional 4xx for S7)' });
        return;
      }
      if (url.pathname === '/echo/5xx') {
        json(res, 500, { error: 'internal error (intentional 5xx for S7)' });
        return;
      }
      if (url.pathname === '/echo/big') {
        const text = 'x'.repeat(30_000); // over the default maxNetworkBodySize (20480)
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text) });
        res.end(text);
        return;
      }
      if (url.pathname === '/echo/notype') {
        res.writeHead(200, {});
        res.end('no content-type here');
        return;
      }

      // ---- scenario panel --------------------------------------------------------------------------
      const m = url.pathname.match(/^\/scenario\/(s\d+[a-z0-9-]*)(?:\/([a-zA-Z0-9-]+))?$/);
      if (m) {
        const [, id, sub] = m;
        if (id === 's1') return void (await scenarioS1(sub ?? 'isLaunched', res));
        if (id === 's2') return void scenarioS2(marker, res);
        if (id === 's3') return void scenarioS3(marker, res);
        if (id === 's4')
          return void (await scenarioS4(sub ?? 'error', marker, url.searchParams.get('sync') === '1', res));
        if (id === 's6') return void scenarioS6(marker, res);
        if (id === 's7') return void (await scenarioS7(sub ?? 'get', marker, res));
        if (id === 's8') return void scenarioS8(marker, res);
        if (id === 's9') return void scenarioS9(marker, res);
        if (id === 's13-consume') return void scenarioS13Consume(marker, res);
        json(res, 404, { error: `unknown scenario ${id}` });
        return;
      }

      // ---- link resolution (catch-all short code) ----------------------------------------------
      const codeMatch = url.pathname.match(/^\/([a-z0-9]{8})$/);
      if (req.method === 'GET' && codeMatch) {
        handleResolve(codeMatch[1], res);
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      // A route THROWING synchronously/asynchronously is itself S5/adapter-error-surface coverage: let
      // it become an uncaught exception path by rethrowing on the next tick would kill the request
      // instead; log + report explicitly here so the HTTP response is still well-formed.
      void client
        .logException(error, { mechanism: 'programmatic', labels: ['route-handler-error'] })
        .catch(() => {});
      json(res, 500, { error: (error as Error).message ?? String(error) });
    }
  })();
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.on('message', (data) => ws.send(data.toString()));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[node-service] listening on http://127.0.0.1:${PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[node-service] received ${signal}, shutting down`);
  stopExpireJob();
  server.close();
  await client.stop(Number(process.env.BUGSEE_SHUTDOWN_TIMEOUT_MS ?? 3000));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
