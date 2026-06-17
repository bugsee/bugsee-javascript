import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { Elysia } from 'elysia';
import { afterEach, describe, expect, it } from 'vitest';
import { type ElysiaAppLike, setupElysia } from './index';

// End-to-end over a REAL Elysia app driven via app.handle (Elysia's .listen is unsupported on Node, so the
// fetch-handler entry runs the full pipeline in-process) + the REAL @bugsee/node SDK. Proves: a genuine
// error is reported with the context, framework control flow (404) is skipped, the response is preserved,
// and concurrent requests stay isolated (enterWith correlates across Elysia's hooks).

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

function boot(): { app: Elysia; client: Bugsee; bundles: Uint8Array[] } {
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
  const app = new Elysia();
  // Elysia's hook methods are deeply generic; the structural ElysiaAppLike doesn't unify with them, so a
  // cast is needed (the app DOES have onRequest/onError/mapResponse). See the README note.
  setupElysia(app as unknown as ElysiaAppLike, {
    user: (c) => c.request.headers.get('x-user') ?? undefined,
  });
  app
    .get('/work', async (c) => {
      const user = c.request.headers.get('x-user');
      client.log(`processing ${user}`);
      await sleep(Number(new URL(c.request.url).searchParams.get('d') ?? 0) * 20);
      throw new Error(`work boom for ${user}`);
    })
    .get('/handler-error', () => {
      throw new Error('handler boom');
    })
    .get('/ok', () => 'ok');
  return { app, client, bundles };
}

describe('@bugsee/elysia — real Elysia app (e2e)', () => {
  it('reports a genuine error (http-error), skips a 404 + the ok route', async () => {
    const { app, client, bundles } = boot();
    await app.handle(new Request('http://localhost/handler-error')).then((r) => r.text());
    await app.handle(new Request('http://localhost/missing')).then((r) => r.text()); // 404 NOT_FOUND
    await app.handle(new Request('http://localhost/ok')).then((r) => r.text());
    await client.flush(5000);
    expect(bundles).toHaveLength(1);
    expect(parseBundle(bundles[0] as Uint8Array).request.source.mechanism).toBe('http-error');
  });

  it('preserves the original response (404 stays 404, ok stays ok)', async () => {
    const { app, client } = boot();
    expect((await app.handle(new Request('http://localhost/missing'))).status).toBe(404);
    expect(await (await app.handle(new Request('http://localhost/ok'))).text()).toBe('ok');
    await client.flush(5000);
  });

  it('attributes each CONCURRENT request to its own user + contextId with no bleed', async () => {
    const { app, client, bundles } = boot();
    const users = ['alice@x.com', 'bob@x.com', 'carol@x.com'];
    await Promise.all(
      users.map((user, i) =>
        app
          .handle(
            new Request(`http://localhost/work?d=${users.length - 1 - i}`, {
              headers: { 'x-user': user },
            }),
          )
          .then((r) => r.text()),
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
