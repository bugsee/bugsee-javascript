import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultShouldReport } from './server-instrument';

/**
 * Property-based tests for the default report policy.
 *
 * This one predicate decides whether a thrown value becomes a bug report. Both failure directions are
 * real costs: reporting every 4xx turns ordinary control flow (a validation failure, a 404) into a stream
 * of noise that buries the genuine crashes, and failing to resolve a 5xx loses the incident the SDK
 * exists to catch.
 *
 * It duck-types four framework shapes — `getStatus()` (Nest), `status` (Koa), `statusCode`
 * (http-errors), `output.statusCode` (Boom) — and mutation testing showed the later two unasserted:
 * each is the ONLY shape some framework uses, so a broken branch silently changes behaviour for exactly
 * that framework's users and no one else's.
 */

/** The four shapes, each carrying the status the same way its framework does. */
const SHAPES: ReadonlyArray<{ name: string; build: (status: number) => unknown }> = [
  { name: 'Nest — getStatus()', build: (status) => ({ getStatus: () => status }) },
  { name: 'Koa — status', build: (status) => ({ status }) },
  { name: 'http-errors — statusCode', build: (status) => ({ statusCode: status }) },
  { name: 'Boom — output.statusCode', build: (status) => ({ output: { statusCode: status } }) },
];

describe('defaultShouldReport (fuzz)', () => {
  it('skips a 4xx and reports a 5xx, in every framework shape', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHAPES),
        fc.integer({ min: 100, max: 599 }),
        (shape, status) => {
          expect(defaultShouldReport(shape.build(status)), `${shape.name} @ ${status}`).toBe(
            status >= 500,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  // The 499/500 boundary is the whole decision, so it is checked directly rather than left to the
  // generator to happen upon.
  it('draws the line exactly at 500', () => {
    for (const shape of SHAPES) {
      expect(defaultShouldReport(shape.build(499)), `${shape.name} 499`).toBe(false);
      expect(defaultShouldReport(shape.build(500)), `${shape.name} 500`).toBe(true);
    }
  });

  /**
   * A value with NO resolvable status is reported. That is the fail-safe direction: a plain `Error` is
   * what an actual bug looks like, and treating "I could not read a status" as "not worth reporting"
   * would silently drop them.
   */
  it('reports anything whose status cannot be resolved', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(new Error('boom')),
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.constant({}),
          fc.constant({ status: 'not-a-number' }),
          fc.constant({ statusCode: null }),
          fc.constant({ output: {} }),
          fc.constant({ getStatus: () => 'nope' }),
          fc.anything(),
        ),
        (value) => {
          const status = (value as { status?: unknown })?.status;
          const statusCode = (value as { statusCode?: unknown })?.statusCode;
          const nested = (value as { output?: { statusCode?: unknown } })?.output?.statusCode;
          // Only assert the fail-safe when the value genuinely carries no numeric status anywhere.
          fc.pre(
            typeof status !== 'number' &&
              typeof statusCode !== 'number' &&
              typeof nested !== 'number' &&
              typeof (value as { getStatus?: unknown })?.getStatus !== 'function',
          );
          expect(defaultShouldReport(value)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * A HOSTILE error must not escape. The thrown value belongs to the application, so its accessors are
   * arbitrary code — a lazily-computed `status` getter that throws is entirely ordinary in an ORM or a
   * proxy-backed error — and this predicate runs inside the server's error path, where a throw would
   * turn an ordinary 400 into a failed request.
   */
  it('never throws, and degrades to "report" when an accessor does', () => {
    const hostile = fc.constantFrom<unknown>(
      {
        get status(): number {
          throw new Error('status getter exploded');
        },
      },
      {
        get statusCode(): number {
          throw new Error('statusCode getter exploded');
        },
      },
      {
        get output(): { statusCode: number } {
          throw new Error('output getter exploded');
        },
      },
      {
        getStatus() {
          throw new Error('getStatus exploded');
        },
      },
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('proxy trap exploded');
          },
        },
      ),
    );
    fc.assert(
      fc.property(hostile, (value) => {
        let reported: boolean | undefined;
        expect(() => {
          reported = defaultShouldReport(value);
        }).not.toThrow();
        // Unresolvable status → reported, the same fail-safe as a plain Error.
        expect(reported).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // Precedence, pinned: the shapes are checked in a fixed order, and a value carrying two of them must
  // resolve deterministically rather than by whichever branch a refactor happens to leave first.
  it('prefers getStatus over status, and status over statusCode', () => {
    expect(defaultShouldReport({ getStatus: () => 404, status: 500 })).toBe(false);
    expect(defaultShouldReport({ status: 404, statusCode: 500 })).toBe(false);
    expect(defaultShouldReport({ statusCode: 404, output: { statusCode: 500 } })).toBe(false);
  });
});
