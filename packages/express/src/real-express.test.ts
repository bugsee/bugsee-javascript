import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { requestHandler } from './middleware';

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
    const res = await fetch(`http://127.0.0.1:${port}/`);
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
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('APP-ERRMW saw: APP-ERROR');
    await close();
  });
});
