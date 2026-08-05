import type { Bugsee } from '@bugsee/bugsee';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as errorMod from './error';
import { solidErrorHandler } from './error';
import * as routerMod from './router';

// Wave 2.1/2.3 — this handler is wired into `<ErrorBoundary>` / `catchError`, so a throw escapes the very
// boundary meant to contain the customer's error and takes the fallback UI down with it.
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('solid error handler is a contained host boundary', () => {
  it('does not throw out of the ErrorBoundary when the SDK throws', () => {
    const onError = vi.fn();
    const handler = solidErrorHandler({
      getClient: () =>
        ({
          logException: () => {
            throw new Error('SDK BOOM');
          },
        }) as never,
      onError,
    });
    expect(() => handler(new Error('customer'))).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});

// WAVE 2.2 — the enforcement half. The test above covers `solidErrorHandler`, the seam the review named.
describe('the host-boundary contract (Wave 2.2)', () => {
  const hostileClient = (): Bugsee =>
    new Proxy({} as Bugsee, {
      get() {
        return () => {
          throw new Error('SDK internal failure');
        };
      },
    });
  const hostileResolver = (): Bugsee => {
    throw new Error('app resolver failed');
  };

  it.each([
    ['hostile client', () => hostileClient()],
    ['hostile resolver', hostileResolver],
  ])('contains every other host seam under a %s', (_label, getClient) => {
    expect(() => errorMod.reportSolidError(new Error('boom'), { getClient })).not.toThrow();
    expect(() =>
      routerMod.setRouteNameFromSolidMatches([{ route: { pattern: '/a/:b' } }] as never, {
        getClient,
      }),
    ).not.toThrow();
  });

  it('contains a hostile matches array in the pure reader', () => {
    const hostile = new Proxy([{}], {
      get() {
        throw new Error('hostile matches');
      },
    });
    expect(() => routerMod.routePatternFromSolidMatches(hostile as never)).not.toThrow();
  });

  it('covers EVERY host-facing export — adding one without a containment test fails here', () => {
    const owned: Record<string, unknown> = { ...errorMod, ...routerMod };
    const functions = Object.keys(owned).filter((n) => typeof owned[n] === 'function');
    const covered = new Set([
      'solidErrorHandler',
      'reportSolidError',
      'setRouteNameFromSolidMatches',
      'routePatternFromSolidMatches',
      'setRouteName',
    ]);
    expect(functions.filter((n) => !covered.has(n)).sort()).toEqual([]);
  });
});
