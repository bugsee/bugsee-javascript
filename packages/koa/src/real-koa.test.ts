import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import { describe, expect, it } from 'vitest';
import { bugseeKoa } from './middleware';

// Review finding (host-boundary reviewer, SEV1 #2): same defect as express — `info` is built outside
// runServerRequest, so a throwing app-supplied `user` extractor 500'd the request on real koa.
describe('@bugsee/koa against real koa', () => {
  it('serves the route when the app-supplied `user` extractor throws', async () => {
    const app = new Koa();
    const errors: unknown[] = [];
    app.use(
      bugseeKoa({
        getClient: () => undefined,
        onError: (e: unknown) => errors.push(e),
        user: () => {
          throw new TypeError('cannot read split of undefined');
        },
      }) as never,
    );
    app.use(((ctx: { body: string }) => {
      ctx.body = 'APP-OK';
    }) as never);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('APP-OK');
    expect(errors).toHaveLength(1);
    await new Promise((r) => server.close(() => r(undefined)));
  });
});
