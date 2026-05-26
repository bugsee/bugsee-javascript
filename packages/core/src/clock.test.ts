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

  it('wallNow and monotonicNow are independent sources', () => {
    setPerformance({ now: () => 50, timeOrigin: 1000 });
    const clock = createSystemClock();
    vi.spyOn(Date, 'now').mockReturnValue(42);
    expect(clock.wallNow()).toBe(42);
    expect(clock.monotonicNow()).toBe(1050);
  });
});
