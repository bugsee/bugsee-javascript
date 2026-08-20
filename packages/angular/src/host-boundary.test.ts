import type { Bugsee } from '@bugsee/bugsee';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as errorMod from './error';
import { BugseeErrorHandler, createAngularErrorHandler } from './error';
import * as renderTracker from './render-tracker';
import * as routerMod from './router';

// Wave 2.1/2.3 — docs/review/frontend-adapters-vue-angular-svelte-solid.md SEV1 #1 + #2.
const throwingClient = () =>
  ({
    logException: () => {
      throw new Error('SDK BOOM');
    },
  }) as never;

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  vi.restoreAllMocks();
});

describe('angular error handler is a contained host boundary', () => {
  it('does not throw into Angular, and STILL delegates, when the SDK throws', () => {
    const delegate = { handleError: vi.fn() };
    const onError = vi.fn();
    const handler = createAngularErrorHandler({ getClient: throwingClient, delegate, onError });
    const err = new Error('customer error');
    expect(() => handler.handleError(err)).not.toThrow();
    expect(delegate.handleError).toHaveBeenCalledWith(err);
    expect(onError).toHaveBeenCalled();
  });
});

describe('angular unwrapping is inside the guard too', () => {
  it('does not throw when unwrapping a hostile error object — AND still reports it', () => {
    // `originalError()` reads `ngOriginalError` off the thrown value BEFORE the report, so a throwing
    // getter there escapes unless the seam itself is contained. Asserting only "did not throw" was not
    // enough: the unwrap shared ONE guard with the report, so a hostile value did not merely lose the
    // UNWRAP — the customer's uncaught Angular error was never reported at all, and this test passed.
    const logException = vi.fn((_error: unknown, _options?: unknown) => Promise.resolve());
    const delegate = { handleError: vi.fn() };
    const handler = createAngularErrorHandler({
      getClient: () => ({ logException }) as never,
      delegate,
    });
    const hostile = {
      get ngOriginalError(): unknown {
        throw new Error('hostile getter');
      },
    };
    expect(() => handler.handleError(hostile)).not.toThrow();
    // Identity, not deep equality: a deep compare would itself read the throwing getter.
    expect(delegate.handleError.mock.calls[0]?.[0]).toBe(hostile);
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(hostile); // the raw value, since the unwrap failed
  });

  it('reportAngularError does not throw out of the PUBLIC export on a hostile thrown value', () => {
    // `createAngularErrorHandler` guards its call, but `reportAngularError` is exported directly for apps
    // that report from their own handler — and the unwrap ran outside every guard, so this threw.
    const hostileProxy = new Proxy(
      {},
      {
        has() {
          throw new Error('hostile `in` trap');
        },
        get() {
          throw new Error('hostile get trap');
        },
      },
    );
    const logException = vi.fn((_error: unknown, _options?: unknown) => Promise.resolve());
    expect(() =>
      errorMod.reportAngularError(hostileProxy, { getClient: () => ({ logException }) as never }),
    ).not.toThrow();
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(hostileProxy);
  });
});

describe('BugseeErrorHandler does not silently delete the app’s error surfacing', () => {
  it('chains to Angular’s DEFAULT behaviour, so the documented one-liner adds rather than removes', () => {
    // `{ provide: ErrorHandler, useClass: BugseeErrorHandler }` REPLACES whatever handler the app had. With
    // nothing chained it printed zero console.error calls where Angular's own default prints one — measured
    // against real @angular/core — so uncaught errors stopped surfacing at all.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('uncaught');
    new BugseeErrorHandler().handleError(err);
    expect(consoleError).toHaveBeenCalledWith('ERROR', err);
  });

  it('still surfaces the error when the SDK throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = {
      client: {
        logException: () => {
          throw new Error('SDK BOOM');
        },
      },
    };
    expect(() => new BugseeErrorHandler().handleError(new Error('e'))).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
  });
});

// WAVE 2.2 — the enforcement half. The tests above cover the ErrorHandler seam the review named; nothing
// covered the rest, and nothing failed when a new export arrived without a containment test.
describe('the host-boundary contract (Wave 2.2)', () => {
  const hostileClient = (): Bugsee =>
    new Proxy({} as Bugsee, {
      get() {
        return () => {
          throw new Error('SDK internal failure');
        };
      },
    });
  // APPLICATION-supplied, and it runs before any guard the SDK applies to the client itself.
  const hostileResolver = (): Bugsee => {
    throw new Error('app resolver failed');
  };

  it.each([
    ['hostile client', () => hostileClient()],
    ['hostile resolver', hostileResolver],
  ])('contains every other host seam under a %s', (_label, getClient) => {
    expect(() => errorMod.reportAngularError(new Error('boom'), { getClient })).not.toThrow();

    // Angular's Router is host-supplied; this reads a snapshot tree straight off it.
    expect(() =>
      routerMod.setRouteNameFromRouter(
        {
          routerState: {
            snapshot: { root: { routeConfig: { path: 'users/:id' }, firstChild: null } },
          },
        } as never,
        { getClient },
      ),
    ).not.toThrow();

    // start()/end() are called from component lifecycle hooks — a throw there takes the view down.
    expect(() => {
      const tracker = renderTracker.createBugseeRenderTracker('UserProfile', { getClient });
      tracker.start();
      tracker.end();
    }).not.toThrow();
  });

  it('contains a hostile Router object entirely', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile router');
        },
      },
    );
    expect(() => routerMod.setRouteNameFromRouter(hostile as never, {})).not.toThrow();
  });

  it('contains a hostile snapshot tree in the pure reader', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile snapshot');
        },
      },
    );
    expect(() => routerMod.routePatternFromSnapshot(hostile as never)).not.toThrow();
  });

  it('covers EVERY host-facing export — adding one without a containment test fails here', () => {
    const owned: Record<string, unknown> = { ...errorMod, ...renderTracker, ...routerMod };
    const functions = Object.keys(owned).filter((n) => typeof owned[n] === 'function');
    const covered = new Set([
      'createAngularErrorHandler',
      'BugseeErrorHandler',
      'reportAngularError',
      'setRouteNameFromRouter',
      'routePatternFromSnapshot',
      'createBugseeRenderTracker',
      'setRouteName',
    ]);
    expect(functions.filter((n) => !covered.has(n)).sort()).toEqual([]);
  });
});
