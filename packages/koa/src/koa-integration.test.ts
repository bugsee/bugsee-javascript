import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import Koa from 'koa';
import { afterEach, describe, expect, it } from 'vitest';
import { type KoaApp, setupKoa } from './index';

// End-to-end over a REAL Koa app (a real http.Server via app.callback) + the REAL @bugsee/node SDK. Proves:
// a thrown error is reported with the context (http-error), a 4xx is skipped, the response is preserved,
// and concurrent requests stay isolated (store.run correlates across the middleware chain).

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBody = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));
const hdr = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

const fakeProcess = (): NodeRuntime => {
  const proc: NodeRuntime = { on: () => proc, off: () => proc, exit: () => undefined };
  return proc;
};

function recordingTransport() {
  const bundles: Uint8Array[] = [];
  let issue = 0;
  const transport = async (url: string, options: { body?: Uint8Array } = {}) => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'a' }) };
    }
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
      if (options.body !== undefined) bundles.push(options.body);
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
  const app = new Koa();
  app.on('error', () => undefined); // silence Koa's default error logging
  setupKoa(app as unknown as KoaApp, { user: (ctx) => hdr(ctx.headers['x-user']) });
  app.use(async (ctx) => {
    if (ctx.path === '/work') {
      const user = hdr(ctx.headers['x-user']);
      client.log(`processing ${user}`);
      await sleep(Number(ctx.query.d ?? 0) * 20);
      throw new Error(`work boom for ${user}`);
    }
    if (ctx.path === '/handler-error') {
      throw new Error('handler boom');
    }
    if (ctx.path === '/client-error') {
      ctx.throw(400, 'bad request'); // a THROWN 4xx → expected control flow, must be skipped
    }
    if (ctx.path === '/ok') {
      ctx.body = 'ok';
    }
  });
  const server = http.createServer(app.callback()).listen(0);
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, client, bundles };
}

describe('@bugsee/koa — real Koa server (e2e)', () => {
  it('reports a handler error (http-error), skips the ok + 404 routes', async () => {
    const { url, client, bundles } = boot();
    await fetch(`${url}/handler-error`).then((r) => r.text());
    await fetch(`${url}/missing`).then((r) => r.text()); // Koa default 404 (no throw)
    await fetch(`${url}/client-error`).then((r) => r.text()); // thrown 400 → skipped
    await fetch(`${url}/ok`).then((r) => r.text());
    await client.flush(5000);
    expect(bundles).toHaveLength(1); // only the genuine handler error
    expect(parseBundle(bundles[0] as Uint8Array).request.source.mechanism).toBe('http-error');
  });

  it('preserves the original response (404 stays 404, ok stays ok)', async () => {
    const { url, client } = boot();
    expect((await fetch(`${url}/missing`)).status).toBe(404);
    expect(await (await fetch(`${url}/ok`)).text()).toBe('ok');
    await client.flush(5000);
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
