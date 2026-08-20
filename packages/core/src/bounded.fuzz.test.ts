import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import { createRateLimiter } from './rate-limiter';
import { createRingBuffer } from './ring-buffer';

/**
 * Property-based tests for the two structures that bound what the SDK costs its host.
 *
 * Both are self-protection (design §7.7): the ring buffer caps retained capture, and the rate limiter
 * caps admissions during an error storm. Their guarantees are the kind that hold "for any sequence of
 * operations", which is exactly what an example test cannot say — so both are checked against a MODEL
 * rather than against remembered outputs.
 */

describe('RingBuffer (fuzz)', () => {
  /** The whole specification, as five lines of obviously-correct code to differentiate against. */
  const model = <T>(items: readonly T[], capacity: number): T[] =>
    items.slice(Math.max(0, items.length - capacity));

  it('holds exactly the last `capacity` items, oldest-first, however many are pushed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        // minLength deliberately exceeds the max capacity, so eviction is actually exercised rather
        // than left to chance on a small generated array.
        fc.array(fc.integer(), { minLength: 20, maxLength: 60 }),
        (capacity, items) => {
          const buffer = createRingBuffer<number>(capacity);
          for (const item of items) {
            buffer.push(item);
          }
          expect(buffer.size).toBe(Math.min(items.length, capacity));
          expect(buffer.size).toBeLessThanOrEqual(capacity);
          expect(buffer.toArray()).toEqual(model(items, capacity));
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * Interleaved operations, not just a push run.
   *
   * The head/count arithmetic wraps modulo capacity and `clear` deliberately does NOT reset `head` — a
   * documented decision — so the states worth testing are the ones reached by mixing pushes with clears
   * and drains, where a stale head would surface as items coming back in the wrong order.
   */
  it('matches the model under arbitrary interleavings of push / drain / clear', () => {
    type Op = { kind: 'push'; value: number } | { kind: 'drain' } | { kind: 'clear' };
    const op: fc.Arbitrary<Op> = fc.oneof(
      { weight: 6, arbitrary: fc.integer().map((value) => ({ kind: 'push' as const, value })) },
      { weight: 1, arbitrary: fc.constant({ kind: 'drain' as const }) },
      { weight: 1, arbitrary: fc.constant({ kind: 'clear' as const }) },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(op, { minLength: 1, maxLength: 80 }),
        (capacity, ops) => {
          const buffer = createRingBuffer<number>(capacity);
          let expected: number[] = [];
          for (const o of ops) {
            if (o.kind === 'push') {
              expected = model([...expected, o.value], capacity);
              buffer.push(o.value);
            } else if (o.kind === 'clear') {
              expected = [];
              buffer.clear();
            } else {
              expect(buffer.drain()).toEqual(expected);
              expected = [];
            }
            expect(buffer.toArray()).toEqual(expected);
            expect(buffer.size).toBe(expected.length);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('drain empties the buffer and returns what toArray would have', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.integer(), { maxLength: 40 }),
        (capacity, items) => {
          const buffer = createRingBuffer<number>(capacity);
          for (const item of items) {
            buffer.push(item);
          }
          const snapshot = buffer.toArray();
          expect(buffer.drain()).toEqual(snapshot);
          expect(buffer.size).toBe(0);
          expect(buffer.toArray()).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses a capacity that is not a positive integer', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ max: 0 }), fc.double({ min: 0.1, max: 5, noInteger: true })),
        (bad) => {
          expect(() => createRingBuffer(bad)).toThrow(RangeError);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('RateLimiter (fuzz)', () => {
  /** A clock the test drives, so the window is exercised deterministically rather than by waiting. */
  const clockAt = (read: () => number): Clock =>
    ({ monotonicNow: read, now: read, wallNow: read }) as unknown as Clock;

  /**
   * THE safety property, checked against the definition rather than against a remembered count: at every
   * admission, the number of admissions inside the preceding rolling window never exceeds the limit.
   *
   * This is what stops a sustained error storm turning into a sustained upload storm, so it has to hold
   * for every arrival pattern — bursts, long gaps, and arrivals that straddle a window edge.
   */
  it('never admits more than `limit` inside any rolling window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 10, max: 1000 }),
        // Deltas biased toward zero so bursts (many arrivals at the same instant) are common — that is
        // the shape an error storm actually has.
        fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 400 })), {
          minLength: 20,
          maxLength: 120,
        }),
        (limit, windowMs, deltas) => {
          let now = 0;
          const limiter = createRateLimiter(
            clockAt(() => now),
            { limit, windowMs },
          );
          const admitted: number[] = [];
          for (const delta of deltas) {
            now += delta;
            if (limiter.tryAcquire()) {
              admitted.push(now);
            }
          }
          for (const at of admitted) {
            const inWindow = admitted.filter((t) => t > at - windowMs && t <= at).length;
            expect(
              inWindow,
              `window ending at ${at} admitted ${inWindow} > ${limit}`,
            ).toBeLessThanOrEqual(limit);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  // The liveness half. A limiter that always refused would satisfy the safety property above and silently
  // discard every report the SDK exists to deliver.
  it('admits again once the window has passed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 10, max: 500 }),
        (limit, windowMs) => {
          let now = 0;
          const limiter = createRateLimiter(
            clockAt(() => now),
            { limit, windowMs },
          );
          for (let i = 0; i < limit; i += 1) {
            expect(limiter.tryAcquire(), `admission ${i} of ${limit} was refused`).toBe(true);
          }
          expect(limiter.tryAcquire(), 'the limit was not enforced').toBe(false);
          now += windowMs + 1;
          expect(limiter.tryAcquire(), 'the window never reopened').toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  // A monotonic clock cannot go backwards, but it CAN stand still — and a limiter that divided by the
  // elapsed time, or assumed strict increase, would misbehave exactly during a burst.
  it('holds the limit when every arrival shares one instant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 12, max: 60 }),
        (limit, arrivals) => {
          const limiter = createRateLimiter(
            clockAt(() => 1000),
            { limit, windowMs: 60_000 },
          );
          let admitted = 0;
          for (let i = 0; i < arrivals; i += 1) {
            if (limiter.tryAcquire()) {
              admitted += 1;
            }
          }
          expect(admitted).toBe(Math.min(limit, arrivals));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses invalid configuration rather than silently disabling itself', () => {
    fc.assert(
      fc.property(fc.integer({ max: 0 }), (bad) => {
        expect(() =>
          createRateLimiter(
            clockAt(() => 0),
            { limit: bad },
          ),
        ).toThrow(RangeError);
        expect(() =>
          createRateLimiter(
            clockAt(() => 0),
            { windowMs: bad },
          ),
        ).toThrow(RangeError);
      }),
      { numRuns: 200 },
    );
  });
});
