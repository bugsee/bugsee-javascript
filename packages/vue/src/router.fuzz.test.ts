import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { routePatternFromVueRoute, type VueRouteLike } from './router';

// PROPERTY tests for the vue-router pattern read. The value is HOST-supplied: `matched` comes off a
// vue-router location, which is a reactive PROXY, and this public export is also callable with whatever an
// app hands it. The example tests pin the well-formed shapes; these pin what must hold for every shape,
// including the ones a router version bump or a wrapper library could produce.

const arbPath = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.string(),
  fc.constantFrom('/', '/users', '/users/:id', '/a/:b/:c'),
  fc.anything(), // a NON-STRING path — the case no example covered
);
const arbRecord = fc.oneof(
  fc.constant({}),
  fc.record({ path: arbPath }, { requiredKeys: [] }),
) as fc.Arbitrary<{ path?: string }>;
const arbRoute: fc.Arbitrary<VueRouteLike> = fc.oneof(
  fc.constant({} as VueRouteLike),
  fc.array(arbRecord, { maxLength: 4 }).map((matched) => ({ matched }) as VueRouteLike),
);

describe('routePatternFromVueRoute (properties)', () => {
  it('only ever returns a NON-EMPTY STRING or undefined — never a foreign value', () => {
    // The result is handed straight to `setRouteName`, which becomes an APM transaction name. A number, an
    // object or an empty string arriving there does not fail loudly; it silently produces a transaction
    // named `[object Object]` or `''` that groups every route in the app together.
    fc.assert(
      fc.property(arbRoute, (route) => {
        const pattern = routePatternFromVueRoute(route);
        if (pattern === undefined) return;
        expect(typeof pattern).toBe('string');
        expect(pattern).not.toBe('');
      }),
      { numRuns: 3000 },
    );
  });

  it('returns the DEEPEST record’s path whenever that path is a usable string', () => {
    fc.assert(
      fc.property(arbRoute, (route) => {
        const matched = route.matched ?? [];
        const deepest = matched.length > 0 ? matched[matched.length - 1]?.path : undefined;
        const expected = typeof deepest === 'string' && deepest !== '' ? deepest : undefined;
        expect(routePatternFromVueRoute(route)).toBe(expected);
      }),
      { numRuns: 3000 },
    );
  });

  it('never throws, for any input at all', () => {
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        expect(() => routePatternFromVueRoute(anything as never)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });
});

describe('routePatternFromVueRoute rejects a non-string path', () => {
  it.each([
    ['a number', 42],
    ['an object', { toString: () => '/users' }],
    ['an array', ['/users']],
    ['a boolean', true],
    ['null', null],
  ])('ignores %s in the deepest matched record', (_label, path) => {
    expect(routePatternFromVueRoute({ matched: [{ path: path as never }] })).toBeUndefined();
  });
});
