import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bugseeHono } from './middleware';

// Review finding (verification audit): a real-Hono suite existed but passed 3/3 with the guard removed —
// the "APP-OK became 500" regression had no real-framework test. This is that test.
const brokenClient = () =>
  ({
    getServiceProvider: () => ({
      getImmediate: () => {
        throw new Error('SDK-INTERNAL-BOOM');
      },
    }),
  }) as never;

describe('@bugsee/hono against real hono', () => {
  it('returns the app’s 200 when the SDK engine throws', async () => {
    const app = new Hono();
    app.use('*', bugseeHono({ getClient: brokenClient }) as never);
    app.get('/', (c) => c.text('APP-OK'));
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('APP-OK');
  });

  it('returns the app’s 200 when the app-supplied `user` extractor throws', async () => {
    const app = new Hono();
    app.use(
      '*',
      bugseeHono({
        getClient: () => undefined,
        user: () => {
          throw new TypeError('cannot read split of undefined');
        },
      }) as never,
    );
    app.get('/', (c) => c.text('APP-OK'));
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('APP-OK');
  });

  it('leaves the app’s own onError owning a genuine app error', async () => {
    const app = new Hono();
    const seen: string[] = [];
    app.use('*', bugseeHono({ getClient: brokenClient }) as never);
    app.get('/', () => {
      throw new Error('APP-ERROR');
    });
    app.onError((err, c) => {
      seen.push(err.message);
      return c.text('APP-ONERROR', 500);
    });
    const res = await app.request('/');
    expect(seen).toEqual(['APP-ERROR']); // not the SDK's internal error
    expect(await res.text()).toBe('APP-ONERROR');
  });
});
