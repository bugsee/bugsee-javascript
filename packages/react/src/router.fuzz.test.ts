import type { Bugsee } from '@bugsee/browser';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  instrumentReactRouter,
  instrumentRouterMatches,
  type RouteMatchLike,
  routePatternFromMatches,
} from './router';

// PROPERTY tests for the react-router pattern JOIN — the one genuinely algorithmic piece in this package,
// and one fed entirely by EXTERNAL input (whatever the app's `matchRoutes()` returns). The example tests in
// router.test.ts pin a handful of shapes; a mutation audit showed the join's slash normalization survived
// four different regex mutations, because no example ever carried a slash anywhere except at a path's very
// start or end. These properties reach the whole shape space instead.

/** An INDEPENDENT model of the join: a character scan, not a regex — trim slash runs off each path's ends,
 *  drop what is left empty, join with single slashes. Differential, so an implementation change that alters
 *  the result has to be a deliberate change to BOTH. */
const trimSlashEnds = (path: string): string => {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start += 1;
  while (end > start && path[end - 1] === '/') end -= 1;
  return path.slice(start, end);
};

const modelPattern = (matches: readonly RouteMatchLike[]): string | undefined => {
  const paths = matches.map((m) => m.route?.path).filter((p): p is string => typeof p === 'string');
  const segments = paths.map(trimSlashEnds).filter((s) => s !== '');
  if (segments.length > 0) return `/${segments.join('/')}`;
  return paths.filter((p) => p === '/').length > 0 ? '/' : undefined;
};

/** Route-path-shaped strings: one or more `users` / `:id` / `*` tokens joined by a SINGLE slash, wrapped in
 *  an arbitrary-length run of leading and trailing slashes. Internal single slashes are the case the example
 *  tests never produced; multi-slash ends are what separates `\/+` from `\/`. */
const token = fc.constantFrom('users', ':id', 'teams', '*', 'a', ':orderId', '2');
const routePath = fc
  .tuple(
    fc.nat({ max: 3 }), // leading slash run
    fc.array(token, { minLength: 0, maxLength: 3 }),
    fc.nat({ max: 3 }), // trailing slash run
  )
  .map(([lead, tokens, trail]) => '/'.repeat(lead) + tokens.join('/') + '/'.repeat(trail));

const matchArb = fc.oneof(
  routePath.map((path) => ({ route: { path } }) as RouteMatchLike),
  fc.constant({ route: {} } as RouteMatchLike), // pathless / layout route
  fc.constant({} as RouteMatchLike), // a match with no `route` at all
);

describe('routePatternFromMatches (properties)', () => {
  it('matches an independent character-scan model of the join', () => {
    fc.assert(
      fc.property(fc.array(matchArb, { maxLength: 5 }), (matches) => {
        expect(routePatternFromMatches(matches)).toBe(modelPattern(matches));
      }),
      { numRuns: 2000 },
    );
  });

  it('never emits a doubled slash and always starts with exactly one', () => {
    // The invariant a route NAME has to satisfy to group correctly in APM: `//users` and `/users` must not
    // be two different transaction names for the same route.
    fc.assert(
      fc.property(fc.array(matchArb, { maxLength: 5 }), (matches) => {
        const pattern = routePatternFromMatches(matches);
        if (pattern === undefined) return;
        expect(pattern.startsWith('/')).toBe(true);
        expect(pattern.startsWith('//')).toBe(false);
        expect(pattern.includes('//')).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });

  it('preserves segment ORDER and content — every token survives the join, in sequence', () => {
    fc.assert(
      fc.property(fc.array(routePath, { minLength: 1, maxLength: 5 }), (paths) => {
        const pattern = routePatternFromMatches(paths.map((path) => ({ route: { path } })));
        const expected = paths.flatMap((p) => p.split('/').filter((s) => s !== ''));
        const actual = pattern === undefined ? [] : pattern.split('/').filter((s) => s !== '');
        expect(actual).toEqual(expected);
      }),
      { numRuns: 2000 },
    );
  });
});

// A match object whose property reads THROW — the shape a proxied / exotic router state produces. This is
// the containment half: `instrumentRouterMatches` is documented as "call on each navigation", so it runs
// inside the app's own navigation effect. A throw there is the SDK breaking the host's route change, which
// the binding rule forbids. The sibling adapters (@bugsee/solid, @bugsee/vue) already contain the identical
// extraction; react's did not.
const hostileMatch = (): RouteMatchLike =>
  new Proxy({} as RouteMatchLike, {
    get() {
      throw new Error('exotic match');
    },
  });

const hostileMatches = (): readonly RouteMatchLike[] =>
  new Proxy([hostileMatch()] as RouteMatchLike[], {
    get(target, prop) {
      if (prop === 'length') return 1;
      if (prop === 'some' || prop === Symbol.iterator) {
        throw new Error('exotic matches array');
      }
      return Reflect.get(target, prop);
    },
  });

describe('routePatternFromMatches contains a HOSTILE matches object', () => {
  it('never throws for a match whose properties throw', () => {
    expect(() => routePatternFromMatches([hostileMatch()])).not.toThrow();
    expect(routePatternFromMatches([hostileMatch()])).toBeUndefined();
  });

  it('never throws for a matches ARRAY whose iteration throws', () => {
    expect(() => routePatternFromMatches(hostileMatches())).not.toThrow();
  });

  it('instrumentRouterMatches never throws into the app’s navigation code', () => {
    const setRouteNameSpy = vi.fn();
    const client = { ext: () => ({ setRouteName: setRouteNameSpy }) } as unknown as Bugsee;
    expect(() =>
      instrumentRouterMatches([hostileMatch()], { getClient: () => client }),
    ).not.toThrow();
    expect(setRouteNameSpy).not.toHaveBeenCalled();
  });

  it('never throws for ANY generated input, however exotic', () => {
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        expect(() => routePatternFromMatches(anything as never)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });
});

describe('instrumentReactRouter contains a hostile router STATE', () => {
  it('does not report an SDK failure when the router notifies with no state at all', () => {
    // react-router hands the listener its state; a wrapper/test double may hand `undefined`. Reading
    // `.matches` off it unguarded turns a benign notification into a contained-but-reported SDK failure,
    // which surfaces to the app through `onError`.
    const onError = vi.fn();
    const setRouteNameSpy = vi.fn();
    let listener: ((state: unknown) => void) | undefined;
    instrumentReactRouter(
      {
        state: { matches: [{ route: { path: 'home' } }] },
        subscribe: (fn: (state: unknown) => void) => {
          listener = fn;
          return () => {};
        },
      } as never,
      {
        getClient: () => ({ ext: () => ({ setRouteName: setRouteNameSpy }) }) as unknown as Bugsee,
        onError,
      },
    );
    setRouteNameSpy.mockClear();
    expect(() => listener?.(undefined)).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
    expect(setRouteNameSpy).not.toHaveBeenCalled();
  });
});
