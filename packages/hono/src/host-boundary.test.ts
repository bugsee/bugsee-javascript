import { describe, expect, it, vi } from 'vitest';
import * as middlewareMod from './middleware';
import { bugseeHono } from './middleware';
import * as setupMod from './setup';

// Wave 2.1/2.3 — docs/review/backend-hono-hapi-elysia.md SEV1 #1. Hono's `compose` catches whatever a
// middleware throws, assigns it to `c.error` and routes it to `app.onError` — so an SDK fault was laundered
// into an APPLICATION error and returned to the client as 500. Measured against real Hono 4.12.25.
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    req: { header: () => undefined, method: 'GET', path: '/x', routePath: '/x' },
    res: { status: 200 },
    ...over,
  }) as never;

describe('bugseeHono never turns an SDK fault into the response', () => {
  it('runs the next handler when the app-supplied `user` extractor throws', async () => {
    // Needs no SDK bug at all: `(c) => c.req.header('authorization').split(' ')[1]` throws a TypeError on
    // every unauthenticated request, and that used to become a 500.
    const next = vi.fn(async () => {});
    const onError = vi.fn();
    const mw = bugseeHono({
      getClient: () => undefined,
      onError,
      user: () => {
        throw new TypeError('cannot read split of undefined');
      },
    });
    await expect(mw(ctx(), next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });

  it('runs the next handler when reading the request throws', async () => {
    const next = vi.fn(async () => {});
    const mw = bugseeHono({ getClient: () => undefined });
    const hostile = ctx({
      req: {
        get header(): never {
          throw new Error('hostile req');
        },
      },
    });
    await expect(mw(hostile, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not replace the app’s outcome when the finally-body work throws', async () => {
    const next = vi.fn(async () => {});
    const onError = vi.fn();
    const mw = bugseeHono({ getClient: () => undefined, onError });
    // Defined lazily: spreading an object literal that carries a getter would invoke it while BUILDING the
    // fixture, so the throw would never reach the middleware and the test would prove nothing.
    const c = ctx({ req: { header: () => undefined, method: 'GET', path: '/x' } });
    Object.defineProperty(c, 'res', {
      get(): never {
        throw new Error('hostile res');
      },
    });
    await expect(mw(c, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('still propagates the APPLICATION’s own error from next()', async () => {
    const appError = new Error('APP-ERROR');
    const mw = bugseeHono({ getClient: () => undefined });
    const next = vi.fn(async () => {
      throw appError;
    });
    await expect(mw(ctx(), next)).rejects.toThrow(appError);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// WAVE 2.2 — the enforcement half. The tests above cover the per-request middleware; nothing covered
// BOOTSTRAP, where a throw stops the app starting rather than costing one report.
describe('the host-boundary contract (Wave 2.2)', () => {
  const hostileApp = (): never =>
    new Proxy({} as never, {
      get() {
        return () => {
          throw new Error('host app blew up');
        };
      },
    });

  it('setupHono does not throw out of server bootstrap on a hostile app', () => {
    expect(() => setupMod.setupHono(hostileApp(), {})).not.toThrow();
  });

  it('bugseeHono returns usable middleware and does not throw when built', () => {
    expect(() => middlewareMod.bugseeHono({})).not.toThrow();
  });

  it('covers EVERY host-facing export — adding one without a containment test fails here', () => {
    const owned: Record<string, unknown> = { ...middlewareMod, ...setupMod };
    const functions = Object.keys(owned).filter((n) => typeof owned[n] === 'function');
    const covered = new Set(['setupHono', 'bugseeHono', 'defaultShouldReport', 'requestName']);
    expect(functions.filter((n) => !covered.has(n)).sort()).toEqual([]);
  });
});
