import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { requestHandler } from './middleware';

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

// Review finding (host-boundary reviewer, SEV1 #2): express builds its request `info` — including the
// APPLICATION-supplied `user` callback — OUTSIDE runServerRequest, so the engine guard added in c90a06a
// could not see it. Measured on real express before the fix: `500`, the app's own error middleware handed a
// Bugsee-internal TypeError, and the route handler never ran.
//
// Driven against the REAL framework, because the previous round's claim of "measured against real express"
// rested on the reviewer's probe rather than on any committed test.
const listen = async (app: express.Express) => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise((r) => server.close(() => r(undefined))) };
};

describe('@bugsee/express against real express', () => {
  it('serves the route when the app-supplied `user` extractor throws', async () => {
    const app = express();
    const errors: unknown[] = [];
    app.use(
      requestHandler({
        getClient: () => undefined,
        onError: (e) => errors.push(e),
        user: () => {
          throw new TypeError('cannot read split of undefined');
        },
      }),
    );
    app.get('/', (_req, res) => {
      res.send('APP-OK');
    });
    const { port, close } = await listen(app);
    const res = await fetchWithDeadline(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('APP-OK');
    expect(errors).toHaveLength(1);
    await close();
  });

  it('still lets the app’s own error middleware own a genuine app error', async () => {
    const app = express();
    app.use(requestHandler({ getClient: () => undefined }));
    app.get('/', () => {
      throw new Error('APP-ERROR');
    });
    app.use(((err: Error, _req: unknown, res: express.Response, _next: unknown) => {
      res.status(500).send(`APP-ERRMW saw: ${err.message}`);
    }) as express.ErrorRequestHandler);
    const { port, close } = await listen(app);
    const res = await fetchWithDeadline(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('APP-ERRMW saw: APP-ERROR');
    await close();
  });
});
