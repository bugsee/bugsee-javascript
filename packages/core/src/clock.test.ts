import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemClock } from './clock';

// Save/restore the real performance so stubbing it can't leak between tests.
// `globalThis.performance` is untyped here (core uses no DOM/Node lib), so access via a cast.
const realPerformance = (globalThis as { performance?: unknown }).performance;
function setPerformance(value: unknown): void {
  (globalThis as { performance?: unknown }).performance = value;
}

afterEach(() => {
  setPerformance(realPerformance);
  vi.restoreAllMocks();
});

describe('createSystemClock', () => {
  it('wallNow returns Date.now()', () => {
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    expect(clock.wallNow()).toBe(1_700_000_000_000);
  });

  it('monotonicNow returns performance.now() + performance.timeOrigin', () => {
    setPerformance({ now: () => 5, timeOrigin: 1000 });
    const clock = createSystemClock();
    expect(clock.monotonicNow()).toBe(1005);
  });

  it('monotonicNow reflects the live performance.now() reading on each call', () => {
    let t = 1;
    setPerformance({ now: () => t, timeOrigin: 100 });
    const clock = createSystemClock();
    expect(clock.monotonicNow()).toBe(101);
    t = 4;
    expect(clock.monotonicNow()).toBe(104);
  });

  it('falls back to Date.now() when performance is absent', () => {
    setPerformance(undefined);
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(777);
    expect(clock.monotonicNow()).toBe(777);
  });

  it('falls back to Date.now() when performance.now is not a function', () => {
    setPerformance({ now: 123, timeOrigin: 1000 });
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(888);
    expect(clock.monotonicNow()).toBe(888);
  });

  it('falls back to Date.now() when performance.timeOrigin is not a number', () => {
    setPerformance({ now: () => 5, timeOrigin: 'nope' });
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(999);
    expect(clock.monotonicNow()).toBe(999);
  });

  it('falls back to Date.now() when performance.timeOrigin is NaN (typeof NaN === "number")', () => {
    setPerformance({ now: () => 5, timeOrigin: NaN });
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    // The bug this pins: `typeof perf.timeOrigin === 'number'` is TRUE for NaN, so the old guard let a
    // NaN timeOrigin through, poisoning every monotonicNow() reading into NaN — a non-monotonic clock
    // silently corrupting internal ordering/duration math. `Number.isFinite` must reject it instead.
    expect(clock.monotonicNow()).toBe(1234);
    expect(Number.isNaN(clock.monotonicNow())).toBe(false);
  });

  it('falls back to Date.now() when performance.timeOrigin is Infinity', () => {
    setPerformance({ now: () => 5, timeOrigin: Infinity });
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(4321);
    expect(clock.monotonicNow()).toBe(4321);
  });

  it('treats a LITERAL 0 timeOrigin as usable, unlike an epoch-anchored wire timestamp would', () => {
    // Deliberately the opposite policy from the browser UI-breadcrumb source's `timeOrigin === 0` rejection
    // (packages/browser/src/ui-breadcrumb-source.ts): monotonicNow() is consumed ONLY as a difference of
    // two readings (RateLimiter interval math, Span duration math) — never surfaced as an absolute wire
    // timestamp — so a constant 0 offset cancels exactly in every real consumer and is fully usable.
    setPerformance({ now: () => 7, timeOrigin: 0 });
    const clock = createSystemClock();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(999_999);
    expect(clock.monotonicNow()).toBe(7); // NOT the Date.now() fallback
    expect(dateNowSpy).not.toHaveBeenCalled();
  });

  it('wallNow and monotonicNow are independent sources', () => {
    setPerformance({ now: () => 50, timeOrigin: 1000 });
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(42);
    expect(clock.wallNow()).toBe(42);
    expect(clock.monotonicNow()).toBe(1050);
  });
});
