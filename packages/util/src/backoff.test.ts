import { describe, expect, it } from 'vitest';
import { computeBackoff } from './backoff';

describe('computeBackoff', () => {
  // `random: () => 0.5` cancels jitter (1 + (0.5*2-1)*r = 1), giving the exact base delay.
  it('returns the initial delay for attempt 0 (defaults, no jitter)', () => {
    expect(computeBackoff(0, { random: () => 0.5 })).toBe(5_000);
  });

  it('applies the minimum jitter at random()=0 (default ratio 0.1)', () => {
    expect(computeBackoff(0, { random: () => 0 })).toBe(4_500);
  });

  it('applies the maximum jitter at random()=1 (default ratio 0.1)', () => {
    expect(computeBackoff(0, { random: () => 1 })).toBe(5_500);
  });

  it('uses defaults and Math.random when no options are given (bounded)', () => {
    const delay = computeBackoff(0);
    expect(delay).toBeGreaterThanOrEqual(4_500);
    expect(delay).toBeLessThanOrEqual(5_500);
  });

  it('grows exponentially by the factor', () => {
    expect(computeBackoff(3, { initialDelayMs: 100, factor: 2, random: () => 0.5 })).toBe(800);
  });

  it('caps at maxDelayMs', () => {
    expect(
      computeBackoff(10, {
        initialDelayMs: 1_000,
        factor: 10,
        maxDelayMs: 5_000,
        random: () => 0.5,
      }),
    ).toBe(5_000);
  });

  it('clamps negative attempts to 0', () => {
    expect(computeBackoff(-5, { initialDelayMs: 1_000, factor: 2, random: () => 0.5 })).toBe(1_000);
  });

  it('applies a custom jitter ratio at the low end', () => {
    expect(computeBackoff(0, { initialDelayMs: 1_000, jitterRatio: 0.5, random: () => 0 })).toBe(
      500,
    );
  });

  it('applies a custom jitter ratio at the high end', () => {
    expect(computeBackoff(0, { initialDelayMs: 1_000, jitterRatio: 0.5, random: () => 1 })).toBe(
      1_500,
    );
  });

  it('never returns a negative delay (zero initial delay)', () => {
    expect(computeBackoff(0, { initialDelayMs: 0, random: () => 0.5 })).toBe(0);
  });

  it('never returns a negative delay (negative initial delay is clamped to 0)', () => {
    expect(
      computeBackoff(0, { initialDelayMs: -100, factor: 2, jitterRatio: 0, random: () => 0.5 }),
    ).toBe(0);
  });
});
