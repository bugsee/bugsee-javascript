import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTimeOrigin } from './time-origin';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveTimeOrigin', () => {
  it('returns a finite non-zero timeOrigin unchanged', () => {
    expect(resolveTimeOrigin({ timeOrigin: 1_700_000_000_000, now: () => 5 })).toBe(
      1_700_000_000_000,
    );
  });

  it('returns a finite non-zero NEGATIVE timeOrigin unchanged (finiteness, not sign, is what matters)', () => {
    expect(resolveTimeOrigin({ timeOrigin: -5, now: () => 5 })).toBe(-5);
  });

  it('falls back when timeOrigin is NaN, reconstructing from Date.now() - perf.now()', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin({ timeOrigin: NaN, now: () => 40 })).toBe(999_960);
  });

  it('falls back when timeOrigin is Infinity', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin({ timeOrigin: Infinity, now: () => 40 })).toBe(999_960);
  });

  it('falls back when timeOrigin is -Infinity', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin({ timeOrigin: -Infinity, now: () => 40 })).toBe(999_960);
  });

  it('falls back when timeOrigin is a non-number arriving through an unchecked cast', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const hostile = { timeOrigin: 'nope' as unknown as number, now: () => 40 };
    expect(resolveTimeOrigin(hostile)).toBe(999_960);
  });

  it('treats a literal 0 as unusable (no spec-compliant host anchors at the Unix epoch)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin({ timeOrigin: 0, now: () => 40 })).toBe(999_960);
  });

  it('falls back to Date.now() alone when timeOrigin is unusable and now is missing', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin({ timeOrigin: NaN })).toBe(1_000_000);
  });

  it('falls back to Date.now() alone when now is not a function (unchecked cast)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const hostile = { timeOrigin: undefined, now: 'nope' as unknown as () => number };
    expect(resolveTimeOrigin(hostile)).toBe(1_000_000);
  });

  it('falls back to Date.now() alone when now() itself returns a non-number', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const hostile = { timeOrigin: undefined, now: () => 'nope' as unknown as number };
    expect(resolveTimeOrigin(hostile)).toBe(1_000_000);
  });

  it('falls back to Date.now() alone when now() returns NaN', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin({ timeOrigin: undefined, now: () => NaN })).toBe(1_000_000);
  });

  it('falls back to Date.now() when perf itself is undefined', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin(undefined)).toBe(1_000_000);
  });

  it('falls back to Date.now() when timeOrigin is missing entirely (undefined)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(resolveTimeOrigin({ now: () => 25 })).toBe(999_975);
  });

  it('calls now() as a method on perf (correct `this` binding)', () => {
    const perf = {
      timeOrigin: NaN,
      base: 1_000,
      now(this: { base: number }): number {
        return this.base;
      },
    };
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    expect(resolveTimeOrigin(perf)).toBe(1_000); // 2000 - perf.base(1000), proves `this` was `perf`
  });
});
