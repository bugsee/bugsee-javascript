import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it } from 'vitest';
import { openBugseeRequest } from './index';

// End-to-end over a RAW node http.Server (NO framework) instrumented purely via the generic engine + the
// REAL @bugsee/node SDK — the "any framework" long-tail path. Proves: a handler error is reported with the
// context (http-error), the ok route is silent, and concurrent requests stay isolated (enterWith correlates
// across the handler's async chain).

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBody = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));
const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

const fakeProcess = (): NodeRuntime => {
  const proc: NodeRuntime = { on: () => proc, off: () => proc, exit: () => undefined };
  return proc;
};

function recordingTransport() {
  const bundles: Uint8Array[] = [];
  let issue = 0;
  const transport = async (url: string, options: { body?: Uint8Array } = {}) => {
    if (url.endsWith('/v2/sessions'))
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'a' }) };
    if (url.endsWith('/v2/issues')) {
      issue += 1;
      return {
        status: 200,
        headers: {},
        body: jsonBody({
          endpoint: `https://put.test/${issue}`,
          issueId: `i${issue}`,
          recordingId: `r${issue}`,
        }),
      };
    }
    if (url.startsWith('https://put.test/')) {
      if (options.body) bundles.push(options.body);
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
    return { status: 200, headers: {}, body: new Uint8Array() };
  };
  return { transport, bundles };
}

interface ParsedBundle {
  request: { email?: string; context_id?: string; source: { mechanism: string } };
  logs: Array<{ message: string; context_id?: string }>;
}
const parseBundle = (zip: Uint8Array): ParsedBundle => {
  const files = unzipSync(zip) as Record<string, Uint8Array>;
  const logsFile = files['logs.json'];
  return {
    request: JSON.parse(strFromU8(files['request.json'] as Uint8Array)),
    logs: logsFile !== undefined ? JSON.parse(strFromU8(logsFile)) : [],
  };
};

const clients: Bugsee[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

function boot(): { url: string; client: Bugsee; bundles: Uint8Array[] } {
  const { transport, bundles } = recordingTransport();
  const client = launch('tok', {
    endpoint: 'https://api.test',
    transport: transport as never,
    process: fakeProcess(),
    detectHangs: false,
    captureNetwork: false,
    recover: false,
  });
  clients.push(client);
  // A raw http server — no framework. The handler instruments itself with the generic engine.
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const user = str(req.headers['x-user']);
    const span = openBugseeRequest({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      traceparent: str(req.headers.traceparent),
      user,
    });
    void (async () => {
      try {
        if (u.pathname === '/work') {
          client.log(`processing ${user}`);
          await sleep(Number(u.searchParams.get('d') ?? 0) * 20);
          throw new Error(`work boom for ${user}`);
        }
        res.statusCode = 200;
        res.end('ok');
        span.finish(200);
      } catch (err) {
        span.captureError(err);
        res.statusCode = 500;
        res.end('error');
        span.finish(500);
      }
    })();
  });
  servers.push(server.listen(0));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, client, bundles };
}

describe('@bugsee/server-adapters — raw http.Server (e2e)', () => {
  it('reports a handler error (http-error) and stays silent on the ok route', async () => {
    const { url, client, bundles } = boot();
    await fetch(`${url}/work`, { headers: { 'x-user': 'a@x.com' } }).then((r) => r.text());
    await fetch(`${url}/ok`).then((r) => r.text());
    await client.flush(5000);
    expect(bundles).toHaveLength(1);
    expect(parseBundle(bundles[0] as Uint8Array).request.source.mechanism).toBe('http-error');
  });

  it('attributes each CONCURRENT request to its own user + contextId with no bleed', async () => {
    const { url, client, bundles } = boot();
    const users = ['alice@x.com', 'bob@x.com', 'carol@x.com'];
    await Promise.all(
      users.map((user, i) =>
        fetch(`${url}/work?d=${users.length - 1 - i}`, { headers: { 'x-user': user } }).then((r) =>
          r.text(),
        ),
      ),
    );
    await client.flush(5000);

    const parsed = bundles.map(parseBundle);
    expect(parsed).toHaveLength(3);
    expect(new Set(parsed.map((p) => p.request.context_id)).size).toBe(3);
    expect([...new Set(parsed.map((p) => p.request.email))].sort()).toEqual([...users].sort());
    for (const p of parsed) {
      const own = p.logs.find((l) => l.context_id === p.request.context_id);
      expect(own?.message).toBe(`processing ${p.request.email}`);
    }
  });
});
