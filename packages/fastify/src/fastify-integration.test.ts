import type { AddressInfo } from 'node:net';
import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { setupFastify } from './index';

/**
 * `fetch` with a deadline.
 *
 * Node's fetch has NO default timeout, so a request that stalls hangs until the test timeout fires and
 * reports only "Test timed out" — naming neither the request nor the phase. A `@bugsee/koa` integration
 * test did exactly that during a parallel `turbo run test:coverage` across 55 packages while passing 5/5
 * in isolation, which is the shape a load-dependent stall takes. The deadline does not prevent a stall;
 * it makes the next one fail in seconds and say which URL it was waiting on.
 */
// Typed off `fetch` itself rather than naming `Response`/`RequestInit`: a framework's own `Response`
// type shadows the global one in these files (express's, notably), and this stays correct regardless.
const fetchWithDeadline = (
  url: string,
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

// End-to-end over a REAL Fastify server + the REAL @bugsee/node SDK. Proves the foundation reuses across
// the Fastify HOOK model (not middleware): the context opened with store.enterWith() in onRequest both
// (a) propagates to the route handler (so a log there is tagged with the request's contextId) and (b)
// stays ISOLATED across concurrent, interleaved requests — each error report carries its own user +
// contextId, no bleed.

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
      if (options.body !== undefined) {
        bundles.push(options.body);
      }
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

describe('fastify adapter — real-server concurrency isolation (e2e)', () => {
  it('attributes each concurrent request to its own user + contextId with no bleed', async () => {
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

    const app = Fastify({ logger: false });
    // One call at the top — the hooks cover every route.
    setupFastify(app, {
      user: (req) => {
        const u = req.headers['x-user'];
        return typeof u === 'string' ? u : undefined;
      },
    });
    app.get('/work', async (req) => {
      const user = req.headers['x-user'];
      // Runs in the route handler — must inherit the context enterWith() set in onRequest.
      client.log(`processing for ${user}`);
      await sleep(Number((req.query as { d?: string }).d ?? 0) * 25);
      throw new Error(`boom for ${user}`);
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as AddressInfo).port;
      const users = ['alice@x.com', 'bob@x.com', 'carol@x.com'];
      await Promise.all(
        users.map((user, i) =>
          fetchWithDeadline(`http://127.0.0.1:${port}/work?d=${users.length - 1 - i}`, {
            headers: { 'x-user': user },
          }).then((r) => r.text()),
        ),
      );
      await client.flush(5000);

      const parsed = bundles.map(parseBundle);
      expect(parsed).toHaveLength(3);

      const ids = parsed.map((p) => p.request.context_id);
      expect(new Set(ids).size).toBe(3); // distinct context per request
      expect([...new Set(parsed.map((p) => p.request.email))].sort()).toEqual([...users].sort());

      // The isolation proof: each report's own log line (matched by context_id) is THIS request's user.
      for (const p of parsed) {
        expect(p.request.source.mechanism).toBe('http-error');
        const ownLine = p.logs.find((l) => l.context_id === p.request.context_id);
        expect(ownLine?.message).toBe(`processing for ${p.request.email}`);
      }
    } finally {
      await app.close();
    }
  });
});
