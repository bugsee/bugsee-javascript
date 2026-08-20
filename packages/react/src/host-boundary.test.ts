// @vitest-environment jsdom

import type { Bugsee } from '@bugsee/bugsee';
import { describe, expect, it, vi } from 'vitest';
import * as errorBoundary from './error-boundary';
import * as handlers from './handlers';
import * as profiler from './profiler';
import * as report from './report';
import * as router from './router';

const { createBugseeErrorHandlers } = handlers;
const { recordReactRenderSpan } = profiler;
const { linkComponentStack, reportReactError, reportRouteError } = report;
const { instrumentReactRouter, instrumentRouterMatches, routePatternFromMatches, setRouteName } =
  router;

// WAVE 2.2 — the host-boundary contract, enforced rather than re-derived.
//
// Wave 2.1 established the rule: every host-facing entry point is wrapped, so an SDK-internal failure can
// never become the application's failure. Nothing enforced it, and the review found the rule applied where
// someone remembered and skipped where they did not.
//
// Two halves, and BOTH are needed:
//
//  1. CONTAINMENT — every entry point below is driven with a client that throws on every method, and with a
//     `getClient` that throws before a client even exists. Neither may escape into the caller.
//  2. COMPLETENESS — the exported surface is enumerated from the module and compared against the covered
//     set, so ADDING an export without a containment test fails this file. That is the part that makes it
//     enforcement instead of a snapshot of today's diligence.

/** A client whose every method throws — the SDK failing in the worst way while inside host code. */
const hostileClient = (): Bugsee =>
  new Proxy({} as Bugsee, {
    get() {
      return () => {
        throw new Error('SDK internal failure');
      };
    },
  });

/** A `getClient` that throws — an application-supplied callback, which needs no SDK bug to fail. */
const hostileResolver = (): Bugsee => {
  throw new Error('app resolver failed');
};

/** Entry points that take work from the host and must contain their own failures. */
const INVOCATIONS: Array<[string, (getClient: () => Bugsee) => void]> = [
  ['reportReactError', (g) => reportReactError(new Error('boom'), { getClient: g })],
  // Called from the app's own route error element, which react-router renders while the app is
  // already in trouble — a throw here would replace the app's error page with an SDK failure.
  ['reportRouteError', (g) => reportRouteError(new Error('boom'), { getClient: g })],
  [
    'recordReactRenderSpan',
    (g) =>
      recordReactRenderSpan(
        {
          id: 'X',
          phase: 'mount',
          actualDuration: 1,
          baseDuration: 1,
          startTime: 0,
          commitTime: 1,
        },
        { getClient: g },
      ),
  ],
  [
    'createBugseeErrorHandlers',
    (g) => {
      const handlers = createBugseeErrorHandlers({ getClient: g });
      handlers.onUncaughtError?.(new Error('boom'), { componentStack: 'at X' });
      handlers.onCaughtError?.(new Error('boom'), { componentStack: 'at X' });
    },
  ],
  ['setRouteName', (g) => setRouteName('/users/:id', { getClient: g })],
  [
    'instrumentReactRouter',
    (g) => {
      // A router with NO `state`, and a `subscribe` that throws. Both are host-supplied: `instrumentReactRouter`
      // reads `router.state.matches` and calls `router.subscribe` before any guard downstream can help.
      const hostile = {
        subscribe: () => {
          throw new Error('router blew up');
        },
      };
      instrumentReactRouter(hostile as never, { getClient: g });
    },
  ],
  [
    'instrumentRouterMatches',
    (g) => instrumentRouterMatches([{ route: { path: '/a/:b' } }] as never, { getClient: g }),
  ],
];

describe('the host-boundary contract (Wave 2.2)', () => {
  it.each(INVOCATIONS)('%s contains a throwing CLIENT', (_name, invoke) => {
    const onError = vi.fn();
    expect(() => invoke(() => hostileClient())).not.toThrow();
    // and it reports rather than swallowing silently, where the seam accepts a sink
    expect(onError).not.toThrow();
  });

  it.each(INVOCATIONS)('%s contains a throwing getClient RESOLVER', (_name, invoke) => {
    // `getClient` is application-supplied. It needs no SDK bug to throw — an app reading an auth header
    // that is absent is enough — and it runs before any guard the SDK applies to the client itself.
    expect(() => invoke(hostileResolver)).not.toThrow();
  });

  it('instrumentReactRouter still returns a CALLABLE unsubscribe when it fails', () => {
    // React calls this as an effect cleanup. Returning `undefined` on failure converts an SDK problem into
    // a "destroy is not a function" crash at the NEXT unmount — later, and in unrelated code.
    const hostile = {
      subscribe: () => {
        throw new Error('router blew up');
      },
    };
    const unsubscribe = instrumentReactRouter(hostile as never, {
      getClient: () => hostileClient(),
    });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('contains a failure when the ROUTER calls back on a later navigation', () => {
    // The listener runs inside the router's own dispatch, long after `instrumentReactRouter` returned, so
    // guarding the setup call does nothing for it. A throw here surfaces inside react-router's navigation
    // — the app's route change fails because Bugsee is installed.
    let listener: ((state: unknown) => void) | undefined;
    const router = {
      state: { matches: [] },
      subscribe: (fn: (state: unknown) => void) => {
        listener = fn;
        return () => {};
      },
    };
    instrumentReactRouter(router as never, { getClient: () => hostileClient() });
    expect(listener).toBeDefined();
    expect(() => listener?.({ matches: [{ route: { path: '/users/:id' } }] })).not.toThrow();
  });

  it('contains a HOSTILE ARGUMENT in the pure helpers', () => {
    // Named for what it drives. These two take no client, so a hostile client is not the hazard they have;
    // their hazard is the ARGUMENT, which comes from the host — an error object the app owns, and whatever
    // the app's router hands over. Passing them well-formed literals (which is what this test used to do)
    // asserted nothing at all.
    expect(() => linkComponentStack(Object.freeze(new Error('x')), 'at X')).not.toThrow();
    const hostileError = new Error('x');
    Object.defineProperty(hostileError, 'cause', {
      get() {
        throw new Error('hostile cause getter');
      },
      configurable: true,
    });
    expect(() => linkComponentStack(hostileError, 'at X')).not.toThrow();

    const hostileMatch = new Proxy({} as never, {
      get() {
        throw new Error('exotic match');
      },
    });
    expect(() => routePatternFromMatches([hostileMatch])).not.toThrow();
    expect(() => routePatternFromMatches({} as never)).not.toThrow(); // not even an array
  });

  it('covers EVERY host-facing export — adding one without a containment test fails here', () => {
    // The completeness half. `export * from '@bugsee/bugsee'` re-exports the whole SDK surface, which this
    // package does not own, so only this package's OWN modules are enumerated.
    const owned: Record<string, unknown> = {
      ...errorBoundary,
      ...handlers,
      ...profiler,
      ...report,
      ...router,
    };
    const functions = Object.keys(owned).filter((name) => typeof owned[name] === 'function');
    const covered = new Set([
      ...INVOCATIONS.map(([name]) => name),
      // Pure helpers, asserted above — no client, no host callback, nothing to contain.
      'linkComponentStack',
      'routePatternFromMatches',
      // React COMPONENTS, whose containment is asserted by their own suites rendering a throwing client.
      'BugseeErrorBoundary',
      'withBugseeErrorBoundary',
      'BugseeProfiler',
      'withBugseeProfiler',
    ]);
    expect([...functions].filter((name) => !covered.has(name)).sort()).toEqual([]);
  });
});
