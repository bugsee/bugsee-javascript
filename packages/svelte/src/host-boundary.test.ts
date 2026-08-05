import type { Bugsee } from '@bugsee/bugsee';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as errorMod from './error';
import { handleErrorWithBugsee } from './error';
import * as renderSpan from './render-span';
import * as routerMod from './router';

// Wave 2.1/2.3 — SvelteKit renders its error page from what `handleError` RETURNS, so an SDK throw here does
// not merely lose a report: it takes the app's error page with it.
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('svelte handleError is a contained host boundary', () => {
  it('does not throw, and STILL returns the app’s own hook result, when the SDK throws', () => {
    const appHandler = vi.fn(() => ({ message: 'app error page' }));
    const onError = vi.fn();
    const hook = handleErrorWithBugsee(appHandler, {
      getClient: () =>
        ({
          logException: () => {
            throw new Error('SDK BOOM');
          },
        }) as never,
      onError,
    });
    const input = { error: new Error('customer'), event: { route: { id: '/x' } } };
    expect(hook(input as never)).toEqual({ message: 'app error page' });
    expect(appHandler).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('does not throw when reading the route off a hostile event', () => {
    const appHandler = vi.fn(() => ({ message: 'ok' }));
    const hook = handleErrorWithBugsee(appHandler, {
      getClient: () => ({ logException: () => Promise.resolve() }) as never,
    });
    const input = {
      error: new Error('e'),
      get event() {
        throw new Error('hostile event');
      },
    };
    expect(hook(input as never)).toEqual({ message: 'ok' });
  });
});

// WAVE 2.2 — the enforcement half. The tests above cover `handleErrorWithBugsee`, the seam the review named.
// Nothing covered the rest, and nothing failed when a new export arrived without a containment test.
describe('the host-boundary contract (Wave 2.2)', () => {
  const hostileClient = (): Bugsee =>
    new Proxy({} as Bugsee, {
      get() {
        return () => {
          throw new Error('SDK internal failure');
        };
      },
    });
  // `getClient` is APPLICATION-supplied — it needs no SDK bug to throw, and it runs before any guard the
  // SDK applies to the client itself.
  const hostileResolver = (): Bugsee => {
    throw new Error('app resolver failed');
  };

  it.each([
    ['hostile client', () => hostileClient()],
    ['hostile resolver', hostileResolver],
  ])('contains every other host seam under a %s', (_label, getClient) => {
    expect(() => errorMod.reportSvelteError(new Error('boom'), { getClient })).not.toThrow();

    // SvelteKit invokes this on EVERY navigation, long after setup returned.
    expect(() => {
      const onNavigate = routerMod.instrumentSvelteKitNavigation({ getClient });
      onNavigate({ to: { route: { id: '/users/[id]' } } } as never);
    }).not.toThrow();

    // Returns a stop() the component calls on destroy — it must stay callable even when the SDK failed.
    expect(() => {
      const stop = renderSpan.startSvelteRenderSpan('Widget', { getClient });
      expect(typeof stop).toBe('function');
      stop();
    }).not.toThrow();
  });

  it('contains a hostile navigation object in the pure reader', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile navigation');
        },
      },
    );
    expect(() => routerMod.routeIdFromNavigation(hostile as never)).not.toThrow();
  });

  it('covers EVERY host-facing export — adding one without a containment test fails here', () => {
    const owned: Record<string, unknown> = { ...errorMod, ...renderSpan, ...routerMod };
    const functions = Object.keys(owned).filter((n) => typeof owned[n] === 'function');
    const covered = new Set([
      'handleErrorWithBugsee',
      'handleError',
      'reportSvelteError',
      'instrumentSvelteKitNavigation',
      'startSvelteRenderSpan',
      'routeIdFromNavigation',
      'setRouteName',
    ]);
    expect(functions.filter((n) => !covered.has(n)).sort()).toEqual([]);
  });
});
