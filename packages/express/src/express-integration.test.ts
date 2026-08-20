import type { AddressInfo } from 'node:net';
import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { errorHandler, requestHandler, setupExpress } from './index';

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

// End-to-end integration over a REAL express server + the REAL @bugsee/node SDK + real AsyncLocalStorage.
// The headline this proves (the whole point of the foundation): under CONCURRENT, interleaved requests on
// one process + one SDK, each error report carries ITS OWN user + contextId, and the capture entries
// recorded during a request are tagged with that request's contextId — no cross-request bleed.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBody = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));

// A fake process so launch installs no real signal/uncaught handlers on the test runner.
const fakeProcess = (): NodeRuntime => {
  const proc: NodeRuntime = {
    on: () => proc,
    off: () => proc,
    exit: () => undefined,
  };
  return proc;
};

// A transport that satisfies session → issue → signed PUT and records each uploaded bundle (the zip).
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
  request: { email?: string; context_id?: string; type: string; source: { mechanism: string } };
  logs: Array<{ message: string; context_id?: string }>;
}
const parseBundle = (zip: Uint8Array): ParsedBundle => {
  const files = unzipSync(zip) as Record<string, Uint8Array>;
  const logsFile = files['logs.json'];
  return {
    request: JSON.parse(strFromU8(files['request.json'] as Uint8Array)),
    logs: logsFile !== undefined ? JSON.parse(strFromU8(logsFile)) : [], // a route may log nothing
  };
};

const clients: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('express adapter — real-server concurrency isolation (e2e)', () => {
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

    const app = express();
    app.use(
      requestHandler({
        user: (req) => {
          const u = req.headers['x-user'];
          return typeof u === 'string' ? u : undefined;
        },
      }),
    );
    app.get('/work', async (req: Request, _res: Response, next: NextFunction) => {
      try {
        const user = req.headers['x-user'];
        // A capture entry recorded INSIDE the request — must be tagged with this request's contextId.
        client.log(`processing for ${user}`);
        // Stagger so the requests finish OUT OF ORDER (forces real interleaving on the event loop).
        await sleep(Number(req.query.d ?? 0) * 25);
        throw new Error(`boom for ${user}`);
      } catch (err) {
        next(err);
      }
    });
    app.use(errorHandler());
    // The app's own final error handler (sends the response).
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ ok: false });
    });

    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const users = ['alice@x.com', 'bob@x.com', 'carol@x.com'];
      await Promise.all(
        users.map((user, i) =>
          // Reversed delays: carol finishes first, alice last — interleaved.
          fetchWithDeadline(`http://127.0.0.1:${port}/work?d=${users.length - 1 - i}`, {
            headers: { 'x-user': user },
          }).then((r) => r.text()),
        ),
      );
      await client.flush(5000);

      const parsed = bundles.map(parseBundle);
      expect(parsed).toHaveLength(3);

      // Every report is a programmatic error carrying a distinct context_id.
      const ids = parsed.map((p) => p.request.context_id);
      expect(new Set(ids).size).toBe(3);
      expect([...new Set(parsed.map((p) => p.request.email))].sort()).toEqual([...users].sort());

      // THE isolation proof: for each report, the log entry tagged with its OWN context_id is THIS
      // request's line — a leaked context would put the wrong user's line under the report's context_id.
      for (const p of parsed) {
        expect(p.request.source.mechanism).toBe('http-error');
        const ownLine = p.logs.find((l) => l.context_id === p.request.context_id);
        expect(ownLine?.message).toBe(`processing for ${p.request.email}`);
      }
    } finally {
      server.close();
    }
  });

  it('setupExpress(app) installs both middlewares — the auto error handler catches a route error', async () => {
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

    const app = express();
    // The whole setup is a single call — the error handler is auto-appended after the routes.
    setupExpress(app, {
      user: (req) => {
        const u = req.headers['x-user'];
        return typeof u === 'string' ? u : undefined;
      },
    });
    app.get('/boom', async (_req: Request, _res: Response, next: NextFunction) => {
      try {
        throw new Error('kaboom');
      } catch (err) {
        next(err);
      }
    });

    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      // The FIRST request must already be covered by the auto-appended error handler.
      const res = await fetchWithDeadline(`http://127.0.0.1:${port}/boom`, {
        headers: { 'x-user': 'dave@x.com' },
      });
      await res.text();
      await client.flush(5000);

      expect(bundles).toHaveLength(1);
      const bundle = parseBundle(bundles[0] as Uint8Array);
      expect(bundle.request.source.mechanism).toBe('http-error');
      expect(bundle.request.email).toBe('dave@x.com');
      expect(bundle.request.context_id).toBeDefined();
    } finally {
      server.close();
    }
  });
});
