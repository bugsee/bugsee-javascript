import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it } from 'vitest';
import { setupHono } from './index';

// End-to-end over a REAL Hono app (driven via app.request — the full middleware/handler/onError pipeline,
// in-process) + the REAL @bugsee/node SDK. Proves: a handled error is reported with the context (mechanism
// http-error), HTTPExceptions are skipped, the response is preserved, and concurrent requests stay isolated.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBody = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));

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
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

function boot(): { app: Hono; client: Bugsee; bundles: Uint8Array[] } {
  const { transport, bundles } = recordingTransport();
  const client = launch('tok', {
    endpoint: 'https://api.test',
    transport: transport as never,
    process: fakeProcess(),
    detectHangs: false,
    captureNetwork: false,
    capturedDataStore: 'memory',
    recover: false,
  });
  clients.push(client);
  const app = new Hono();
  setupHono(app, { user: (c) => c.req.header('x-user') });
  app.get('/work', async (c) => {
    const user = c.req.header('x-user');
    client.log(`processing ${user}`);
    await sleep(Number(c.req.query('d') ?? 0) * 20); // stagger → real interleaving
    throw new Error(`work boom for ${user}`);
  });
  app.get('/handler-error', () => {
    throw new Error('handler boom');
  });
  app.get('/http-404', () => {
    throw new HTTPException(404, { message: 'nope' });
  });
  app.get('/ok', (c) => c.text('ok'));
  return { app, client, bundles };
}

describe('@bugsee/hono — real Hono app (e2e)', () => {
  it('reports a handler error (mechanism http-error), skips the HTTPException + ok route', async () => {
    const { app, client, bundles } = boot();
    for (const path of ['/handler-error', '/http-404', '/ok']) {
      await app.request(path);
    }
    await client.flush(5000);
    expect(bundles).toHaveLength(1);
    expect(parseBundle(bundles[0] as Uint8Array).request.source.mechanism).toBe('http-error');
  });

  it('preserves the original response (404 stays 404, ok stays ok)', async () => {
    const { app, client } = boot();
    expect((await app.request('/http-404')).status).toBe(404);
    expect(await (await app.request('/ok')).text()).toBe('ok');
    await client.flush(5000);
  });

  it('attributes each CONCURRENT request to its own user + contextId with no bleed', async () => {
    const { app, client, bundles } = boot();
    const users = ['alice@x.com', 'bob@x.com', 'carol@x.com'];
    await Promise.all(
      // reversed delays: carol finishes first, alice last — interleaved
      users.map((user, i) =>
        app.request(`/work?d=${users.length - 1 - i}`, { headers: { 'x-user': user } }),
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
