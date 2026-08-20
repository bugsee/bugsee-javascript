import type { Bugsee } from '@bugsee/browser';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { handleErrorWithBugsee, reportSvelteError } from './error';
import { instrumentSvelteKitNavigation, routeIdFromNavigation } from './router';

/**
 * Property-based tests for the two @bugsee/svelte surfaces fed by HOST-supplied objects: SvelteKit's
 * `handleError` input and its `afterNavigate` argument. Both are read structurally (this adapter never
 * imports `@sveltejs/kit`), so "whatever the framework hands us" is the real input domain — exactly what
 * an example test can only sample.
 *
 * Two invariants, both stated as the app owner would state them:
 *   1. THE APP'S ERROR HANDLING IS UNTOUCHED — for any input and any client, the hook returns exactly what
 *      the app's own `handleError` returned, and the app's handler always runs. (The binding project
 *      principle: an interceptor must never alter host behaviour.)
 *   2. THE ERROR IS ALWAYS REPORTED when a client is available, whatever the route shape degrades to.
 *      A malformed `event` may cost the route LABEL; it must never cost the REPORT.
 */

/** Every navigation/event route shape SvelteKit (or a hostile object) can present. */
const routeShapes = [
  () => ({}),
  () => ({ route: null }),
  () => ({ route: undefined }),
  () => ({ route: {} }),
  () => ({ route: { id: null } }),
  () => ({ route: { id: undefined } }),
  () => ({ route: { id: '' } }),
  () => ({ route: { id: '/users/[id]' } }),
  () => ({ route: { id: '/' } }),
  () => ({ route: { id: 42 } }), // not a string — must not become the label `svelte.route:42`
  () =>
    new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile event');
        },
      },
    ),
  () => ({
    get route(): unknown {
      throw new Error('hostile route');
    },
  }),
  () => ({
    route: {
      get id(): unknown {
        throw new Error('hostile id');
      },
    },
  }),
];

/** The route id a CORRECT reader would extract: a non-empty string, else nothing. */
function expectedRouteId(shape: unknown): string | undefined {
  try {
    const id = (shape as { route?: { id?: unknown } } | undefined)?.route?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined; // an unreadable shape has no route id
  }
}

const eventShape = fc.oneof(
  ...routeShapes.map((f) => fc.constant(f)),
  fc.constant(() => undefined),
);

function trackingClient() {
  const logException = vi.fn((_error: unknown, _options?: unknown) => Promise.resolve());
  const setRouteName = vi.fn();
  const client = {
    logException,
    ext: () => ({ setRouteName, getActiveSpan: () => undefined }),
  } as unknown as Bugsee;
  return { client, logException, setRouteName };
}

describe('handleErrorWithBugsee (fuzz)', () => {
  it('always runs the app handler and forwards its EXACT return, whatever the input', () => {
    fc.assert(
      fc.property(eventShape, fc.anything(), fc.anything(), (makeEvent, thrown, appResult) => {
        const appHandler = vi.fn((_input: unknown) => appResult);
        const { client } = trackingClient();
        const hook = handleErrorWithBugsee(appHandler, { getClient: () => client });
        const input = { error: thrown, event: makeEvent() } as never;
        let returned: unknown;
        expect(() => {
          returned = hook(input);
        }).not.toThrow();
        expect(appHandler).toHaveBeenCalledTimes(1);
        // Identity, not deep equality — a deep compare would itself read the hostile getters/proxies.
        expect(appHandler.mock.calls[0]?.[0]).toBe(input); // the app sees the input UNMODIFIED
        expect(returned).toBe(appResult); // …and SvelteKit renders from exactly its return
      }),
    );
  });

  it('reports the error EXACTLY ONCE for every route shape — a bad event costs the label, not the report', () => {
    fc.assert(
      fc.property(eventShape, fc.anything(), (makeEvent, thrown) => {
        const { client, logException } = trackingClient();
        const hook = handleErrorWithBugsee(undefined, { getClient: () => client });
        hook({ error: thrown, event: makeEvent() } as never);

        expect(logException).toHaveBeenCalledTimes(1);
        expect(logException.mock.calls[0]?.[0]).toBe(thrown); // forwarded unchanged

        // The label is present iff a usable (non-empty string) route id was readable — and never says
        // `svelte.route:` with nothing after the colon, nor stringifies a null/numeric id.
        const opts = (logException.mock.calls[0] as unknown[])[1] as { labels?: string[] };
        const id = expectedRouteId(makeEvent());
        if (id === undefined) {
          expect('labels' in (opts ?? {})).toBe(false);
        } else {
          expect(opts.labels).toStrictEqual([`svelte.route:${id}`]);
        }
      }),
    );
  });

  it('reports NO SDK-internal error for an ORDINARY degraded event (missing event / route / id)', () => {
    // A SvelteKit `event` with no `route`, or no event at all, is a normal shape — not an SDK failure.
    // The route read has its own `neverThrow(…, options.onError)` sink, so dropping either `?.` in
    // `input.event?.route?.id` turns each of those ordinary shapes into a TypeError routed to the host's
    // `onError` on EVERY handled error. `onError` staying silent is what separates "no route id" from
    // "the SDK broke"; only a genuinely unreadable (throwing/proxied) event may fire it.
    const ordinaryEvent = fc.oneof(
      fc.constant(() => undefined),
      fc.constant(() => ({})),
      fc.constant(() => ({ route: undefined })),
      fc.constant(() => ({ route: null })),
      fc.constant(() => ({ route: {} })),
      fc.constant(() => ({ route: { id: null } })),
      fc.constant(() => ({ route: { id: '' } })),
      fc.constant(() => ({ route: { id: '/users/[id]' } })),
    );
    fc.assert(
      fc.property(ordinaryEvent, fc.anything(), (makeEvent, thrown) => {
        const onError = vi.fn();
        const { client, logException } = trackingClient();
        const hook = handleErrorWithBugsee(undefined, { getClient: () => client, onError });
        hook({ error: thrown, event: makeEvent() } as never);
        expect(logException).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
      }),
    );
  });

  it('never throws into SvelteKit, for any error value and any broken client', () => {
    const brokenClient = fc.oneof(
      fc.constant(() => undefined),
      fc.constant(() => {
        throw new Error('resolver failed');
      }),
      fc.constant(
        () =>
          new Proxy({} as Bugsee, {
            get: () => () => {
              throw new Error('SDK internal failure');
            },
          }),
      ),
    );
    fc.assert(
      fc.property(eventShape, fc.anything(), brokenClient, (makeEvent, thrown, getClient) => {
        const appHandler = vi.fn(() => 'app page');
        const hook = handleErrorWithBugsee(appHandler, { getClient });
        expect(hook({ error: thrown, event: makeEvent() } as never)).toBe('app page');
        expect(appHandler).toHaveBeenCalledTimes(1);
      }),
    );
  });
});

describe('reportSvelteError label construction (fuzz)', () => {
  it('labels with `svelte.route:<id>` verbatim — SvelteKit bracket syntax is never normalized', () => {
    fc.assert(
      fc.property(fc.string(), (routeId) => {
        const { client, logException } = trackingClient();
        reportSvelteError(new Error('x'), { routeId, getClient: () => client });
        const opts = (logException.mock.calls[0] as unknown[])[1] as { labels?: string[] };
        // `reportSvelteError` takes the id it is GIVEN at face value (the emptiness filter lives in the
        // hook), so the label is always exactly one prefixed entry.
        expect(opts.labels).toStrictEqual([`svelte.route:${routeId}`]);
      }),
    );
  });
});

describe('routeIdFromNavigation (fuzz)', () => {
  /**
   * NOTE for a future auditor: Stryker reports two OptionalChaining survivors on `navigation.to?.route?.id`
   * (router.ts:26). Both are PROVEN EQUIVALENT, not gaps — the read sits inside `neverThrow` with NO
   * `onError` sink, so a TypeError from a dropped `?.` and a legitimately-absent id produce the identical
   * observable result (`undefined`, nothing named, nothing thrown). Verified by differentially running
   * both mutants against the clean source over all the shapes below: byte-identical outcomes. The
   * properties here pin the CONTRACT rather than chase them.
   */
  const navShape = fc.oneof(
    fc.constant(() => ({})),
    fc.constant(() => ({ to: null })),
    fc.constant(() => ({ to: undefined })),
    ...routeShapes.map((f) => fc.constant(() => ({ to: f() }))),
    fc.constant(
      () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error('hostile nav');
            },
          },
        ),
    ),
    fc.constant(() => ({
      get to(): unknown {
        throw new Error('hostile to');
      },
    })),
  );

  /** What a correct reader extracts from a NAVIGATION (one level up from `expectedRouteId`'s event). */
  const expectedNavRouteId = (nav: unknown): string | undefined => {
    try {
      return expectedRouteId((nav as { to?: unknown } | undefined)?.to);
    } catch {
      return undefined; // an unreadable `to` has no route id
    }
  };

  it('yields a non-empty string or undefined — never an empty / non-string id, never a throw', () => {
    fc.assert(
      fc.property(navShape, (makeNav) => {
        const nav = makeNav();
        let id: string | undefined;
        expect(() => {
          id = routeIdFromNavigation(nav as never);
        }).not.toThrow();
        expect(id).toBe(expectedNavRouteId(nav)); // differential against the model reader
        if (id !== undefined) {
          expect(typeof id).toBe('string');
          expect(id).not.toBe('');
        }
      }),
    );
  });

  it('names the transaction exactly when a usable route id exists, and never otherwise', () => {
    fc.assert(
      fc.property(navShape, (makeNav) => {
        const nav = makeNav();
        const { client, setRouteName } = trackingClient();
        expect(() =>
          instrumentSvelteKitNavigation({ getClient: () => client })(nav as never),
        ).not.toThrow();
        const id = routeIdFromNavigation(nav as never);
        if (id === undefined) expect(setRouteName).not.toHaveBeenCalled();
        else expect(setRouteName).toHaveBeenCalledExactlyOnceWith(id);
      }),
    );
  });
});
