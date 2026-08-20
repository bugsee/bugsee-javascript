import { describe, expect, it } from 'vitest';
import { onCLS } from './cls';
import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import type { Metric } from './metric';

const shift = (startTime: number, value: number, hadRecentInput = false): PerformanceEntryLike =>
  ({ name: '', entryType: 'layout-shift', startTime, duration: 0, value, hadRecentInput }) as never;

function fakeShiftObserver() {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = ['layout-shift'];
    readonly cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    pending: PerformanceEntryLike[] = [];
    observe() {}
    disconnect() {}
    takeRecords(): PerformanceEntryLike[] {
      const p = this.pending;
      this.pending = [];
      return p;
    }
    emit(entries: PerformanceEntryLike[]) {
      this.cb({ getEntries: () => entries });
    }
  }
  return { Ctor: FakePO as never, instances };
}

function fakeWindow() {
  const listeners = new Map<string, (() => void)[]>();
  return {
    addEventListener: (type: string, l: () => void) => {
      (listeners.get(type) ?? listeners.set(type, []).get(type))?.push(l);
    },
    emit: (type: string) => {
      for (const l of listeners.get(type) ?? []) l();
    },
  };
}

// Emit the shifts, then finalize via pagehide; return the single reported CLS value.
function clsOf(shifts: PerformanceEntryLike[]): number | undefined {
  const { Ctor, instances } = fakeShiftObserver();
  const win = fakeWindow();
  const env: WebVitalsEnv = {
    PerformanceObserver: Ctor,
    performance: { now: () => 0, getEntriesByType: () => [] },
    queueMicrotask: (cb) => cb(),
    window: win as never,
  };
  const seen: Metric[] = [];
  onCLS(env, (m) => seen.push(m));
  if (shifts.length > 0) instances[0]?.emit(shifts);
  win.emit('pagehide');
  return seen.at(-1)?.value;
}

describe('onCLS', () => {
  it('sums shifts within one session window (≤1s gap, ≤5s total)', () => {
    // gaps 500 + 400 (<1s), window 900 (<5s) → one session of 0.3
    expect(clsOf([shift(0, 0.1), shift(500, 0.1), shift(900, 0.1)])).toBeCloseTo(0.3);
  });

  it('drops shifts that followed recent input (hadRecentInput)', () => {
    expect(clsOf([shift(0, 0.1), shift(100, 0.5, true), shift(200, 0.1)])).toBeCloseTo(0.2);
  });

  it('starts a NEW window when the gap is >= 1s, taking the LARGEST window (not the sum)', () => {
    // session A = 0.1+0.1 = 0.2; then a 2s gap → session B = 0.1. CLS = max(0.2, 0.1) = 0.2 (total 0.4).
    expect(clsOf([shift(0, 0.1), shift(500, 0.1), shift(2500, 0.1)])).toBeCloseTo(0.2);
  });

  it('splits at a gap of EXACTLY 1s (the gap boundary is strict <1000)', () => {
    // gap 0→1000 is exactly 1000ms → NOT < 1000 → a new window → CLS = max(0.1, 0.1) = 0.1, not 0.2.
    expect(clsOf([shift(0, 0.1), shift(1000, 0.1)])).toBeCloseTo(0.1);
  });

  it('splits at a window age of EXACTLY 5s (the window boundary is strict <5000)', () => {
    // shifts every 900ms (gaps <1s); at t=5000 the window-from-first is exactly 5000 → NOT < 5000 → new
    // window. window 1 = t0..t4500 (6 shifts → 0.6); t5000 opens a new window (0.1) → CLS = 0.6, not 0.7.
    const shifts = [0, 900, 1800, 2700, 3600, 4500, 5000].map((t) => shift(t, 0.1));
    expect(clsOf(shifts)).toBeCloseTo(0.6);
  });

  /**
   * A ZERO-valued shift does not open a session window.
   *
   * `sessionValue` doubles as the "is a window open?" flag, and the two questions only come apart when an
   * open window sums to exactly 0 — which a `value: 0` layout-shift entry produces. The distinction is
   * invisible in the reported value (0 + v == v either way); it shows up in WHERE THE 5s CLOCK STARTS,
   * because a window that never really opened must not age from the zero shift. web-vitals guards this
   * the same way, so this is also the parity check with the reference implementation.
   */
  it('does not open a session window on a zero-valued shift', () => {
    // t=0 value 0 (opens nothing) → the real window starts at t=500 and is 4500ms old at t=5000, so every
    // shift joins: 6 x 0.1 = 0.6. Aging from t=0 instead would hit exactly 5000 at the last shift, split
    // the window, and report 0.5.
    const shifts = [shift(0, 0), ...[500, 1400, 2300, 3200, 4100, 5000].map((t) => shift(t, 0.1))];
    expect(clsOf(shifts)).toBeCloseTo(0.6);
  });

  it('keeps the largest window when a later window is bigger', () => {
    // A = 0.2 ; gap ; B = 0.5  → CLS = 0.5
    expect(clsOf([shift(0, 0.1), shift(500, 0.1), shift(3000, 0.3), shift(3500, 0.2)])).toBeCloseTo(
      0.5,
    );
  });

  it('does not double-report when the page hides twice (bindReporter delta-dedup)', () => {
    const { Ctor, instances } = fakeShiftObserver();
    const win = fakeWindow();
    const env: WebVitalsEnv = {
      PerformanceObserver: Ctor,
      performance: { now: () => 0, getEntriesByType: () => [] },
      queueMicrotask: (cb) => cb(),
      window: win as never,
    };
    const seen: Metric[] = [];
    onCLS(env, (m) => seen.push(m));
    instances[0]?.emit([shift(0, 0.1)]);
    win.emit('pagehide'); // first finalize → exactly one report
    win.emit('pagehide'); // second hidden: value unchanged → delta 0 → callback suppressed
    expect(seen).toHaveLength(1);
    expect(seen[0]?.value).toBeCloseTo(0.1);
  });

  it('reports a CLS of 0 for a shift-free page (CLS initializes to 0)', () => {
    expect(clsOf([])).toBe(0);
  });

  it('drains pending shifts via takeRecords() on finalize', () => {
    const { Ctor, instances } = fakeShiftObserver();
    const win = fakeWindow();
    const env: WebVitalsEnv = {
      PerformanceObserver: Ctor,
      performance: { now: () => 0, getEntriesByType: () => [] },
      queueMicrotask: (cb) => cb(),
      window: win as never,
    };
    const seen: Metric[] = [];
    onCLS(env, (m) => seen.push(m));
    instances[0]?.emit([shift(0, 0.1)]);
    if (instances[0]) instances[0].pending = [shift(200, 0.2)]; // delivered only via takeRecords()
    win.emit('pagehide');
    expect(seen.at(-1)?.value).toBeCloseTo(0.3); // 0.1 + the drained 0.2 (same window)
  });

  it('does nothing (no throw) without a PerformanceObserver', () => {
    const seen: Metric[] = [];
    expect(() => onCLS({ window: fakeWindow() as never }, (m) => seen.push(m))).not.toThrow();
    expect(seen).toEqual([]);
  });
});
