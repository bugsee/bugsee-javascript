import type { Bugsee } from '@bugsee/browser';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  routePatternFromSolidMatches,
  type SolidRouteMatchLike,
  setRouteNameFromSolidMatches,
} from './router';

// PROPERTY tests for the Solid Router pattern read. The argument is HOST-supplied — `useCurrentMatches()`'s
// value, read inside a reactive effect the APP owns — so this runs on every navigation of every app, on a
// value shaped by whichever @solidjs/router version the app installed. The example tests pin the well-formed
// shapes; these pin what has to hold for all of them.

const arbPattern = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.constantFrom('/', '/users', '/users/:id', '/*rest'),
  fc.string(),
  fc.anything(), // a NON-STRING pattern — the case no example covered
);
const arbMatch = fc.oneof(
  fc.constant({} as SolidRouteMatchLike),
  fc.record(
    {
      route: fc.oneof(
        fc.constant(undefined),
        fc.record({ pattern: arbPattern }, { requiredKeys: [] }),
      ),
    },
    { requiredKeys: [] },
  ),
) as fc.Arbitrary<SolidRouteMatchLike>;
const arbMatches = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.array(arbMatch, { maxLength: 4 }),
) as fc.Arbitrary<readonly SolidRouteMatchLike[] | null | undefined>;

describe('routePatternFromSolidMatches (properties)', () => {
  it('only ever returns a NON-EMPTY STRING or undefined — never a foreign value', () => {
    // The result is handed straight to `setRouteName`, which becomes an APM transaction name. A number or
    // an object arriving there does not fail loudly; it produces a transaction named `[object Object]`,
    // and an empty string produces one that silently groups every route in the app together.
    fc.assert(
      fc.property(arbMatches, (matches) => {
        const pattern = routePatternFromSolidMatches(matches);
        if (pattern === undefined) return;
        expect(typeof pattern).toBe('string');
        expect(pattern).not.toBe('');
      }),
      { numRuns: 3000 },
    );
  });

  it('returns the DEEPEST match’s pattern whenever that pattern is a usable string', () => {
    fc.assert(
      fc.property(arbMatches, (matches) => {
        const list = matches ?? [];
        const deepest = list.length > 0 ? list[list.length - 1]?.route?.pattern : undefined;
        const expected = typeof deepest === 'string' && deepest !== '' ? deepest : undefined;
        expect(routePatternFromSolidMatches(matches)).toBe(expected);
      }),
      { numRuns: 3000 },
    );
  });

  it('never throws, for any input at all', () => {
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        expect(() => routePatternFromSolidMatches(anything as never)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });

  it('never names a transaction with a foreign value, end to end', () => {
    // The property that actually matters to a customer: whatever comes out of the router, `setRouteName`
    // either receives a usable pattern string or is not called at all.
    fc.assert(
      fc.property(arbMatches, (matches) => {
        const spy = vi.fn();
        const client = { ext: () => ({ setRouteName: spy }) } as unknown as Bugsee;
        setRouteNameFromSolidMatches(matches, { getClient: () => client });
        for (const [name] of spy.mock.calls) {
          expect(typeof name).toBe('string');
          expect(name).not.toBe('');
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('routePatternFromSolidMatches rejects a non-string pattern', () => {
  it.each([
    ['a number', 42],
    ['an object with toString', { toString: () => '/users' }],
    ['an array', ['/users']],
    ['a boolean', true],
    ['null', null],
  ])('ignores %s on the deepest match', (_label, pattern) => {
    expect(
      routePatternFromSolidMatches([{ route: { pattern: pattern as never } }]),
    ).toBeUndefined();
  });
});
