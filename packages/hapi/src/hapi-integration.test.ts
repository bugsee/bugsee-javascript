import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import Hapi from '@hapi/hapi';
import { afterEach, describe, expect, it } from 'vitest';
import { type HapiServerLike, setupHapi } from './index';

// End-to-end over a REAL Hapi server driven via server.inject (the full request lifecycle, in-process) +
// the REAL @bugsee/node SDK. Proves: a 5xx is reported with the context, a 404 (client Boom) is skipped,
// the response is preserved, and concurrent requests stay isolated (enterWith correlates across extensions).

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

function boot(): { server: Hapi.Server; client: Bugsee; bundles: Uint8Array[] } {
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
  const server = Hapi.server({ port: 0 });
  setupHapi(server as unknown as HapiServerLike, {
    user: (req) => {
      const u = (req.headers as Record<string, string | undefined>)['x-user'];
      return typeof u === 'string' ? u : undefined;
    },
  });
  server.route({
    method: 'GET',
    path: '/work',
    handler: async (req) => {
      const user = (req.headers as Record<string, string | undefined>)['x-user'];
      client.log(`processing ${user}`);
      await sleep(Number(req.query.d ?? 0) * 20);
      throw new Error(`work boom for ${user}`);
    },
  });
  server.route({
    method: 'GET',
    path: '/handler-error',
    handler: () => {
      throw new Error('handler boom');
    },
  });
  server.route({ method: 'GET', path: '/ok', handler: () => 'ok' });
  return { server, client, bundles };
}

describe('@bugsee/hapi — real Hapi server (e2e)', () => {
  it('reports a 5xx (http-error), skips a 404 + the ok route', async () => {
    const { server, client, bundles } = boot();
    await server.inject({ method: 'GET', url: '/handler-error' });
    await server.inject({ method: 'GET', url: '/missing' }); // 404 client Boom
    await server.inject({ method: 'GET', url: '/ok' });
    await client.flush(5000);
    expect(bundles).toHaveLength(1);
    expect(parseBundle(bundles[0] as Uint8Array).request.source.mechanism).toBe('http-error');
  });

  it('preserves the original response (404 stays 404, ok stays ok)', async () => {
    const { server, client } = boot();
    expect((await server.inject({ method: 'GET', url: '/missing' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/ok' })).result).toBe('ok');
    await client.flush(5000);
  });

  it('attributes each CONCURRENT request to its own user + contextId with no bleed', async () => {
    const { server, client, bundles } = boot();
    const users = ['alice@x.com', 'bob@x.com', 'carol@x.com'];
    await Promise.all(
      users.map((user, i) =>
        server.inject({
          method: 'GET',
          url: `/work?d=${users.length - 1 - i}`,
          headers: { 'x-user': user },
        }),
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
