import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { onCLS } from './cls';
import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { onINP } from './inp';
import type { Metric } from './metric';

/**
 * Property-based tests for the two web vitals with real algorithms behind them.
 *
 * CLS and INP are REIMPLEMENTATIONS of Google's web-vitals (a design reference, not a dependency), and
 * both are stateful accumulators fed by a stream of browser entries. Example tests fix one entry
 * sequence, so they pin the arithmetic on the sequences a developer thought of — while the browser
 * supplies whatever the page actually did, in whatever batches the observer happens to deliver.
 *
 * So the properties here are MODEL-BASED: each metric is computed a second time by a reference written
 * from the published algorithm rather than from our code, and the two must agree on generated streams.
 * That is what makes the session-window and p98-index rules defensible — the exact rules whose every
 * clause survived mutation because no example distinguished them.
 */

const shift = (startTime: number, value: number, hadRecentInput = false): PerformanceEntryLike =>
  ({ name: '', entryType: 'layout-shift', startTime, duration: 0, value, hadRecentInput }) as never;

const ev = (
  interactionId: number | undefined,
  duration: number,
  entryType = 'event',
): PerformanceEntryLike =>
  ({ name: '', entryType, startTime: 0, duration, interactionId }) as never;

function fakeObservers(supported: string[]) {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = supported;
    readonly cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    observed: { type: string; durationThreshold?: number } | undefined;
    pending: PerformanceEntryLike[] = [];
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe(options: { type: string; durationThreshold?: number }) {
      this.observed = options;
    }
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
  const find = (type: string, threshold?: number) =>
    instances.find(
      (i) =>
        i.observed?.type === type &&
        (threshold === undefined || i.observed?.durationThreshold === threshold),
    );
  return { Ctor: FakePO as never, instances, find };
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// CLS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Shift {
  startTime: number;
  value: number;
  hadRecentInput: boolean;
}

/**
 * The published CLS rule, written from the specification rather than from `cls.ts`:
 *
 *   drop every shift that followed recent input; group the rest into SESSION WINDOWS, where a shift joins
 *   the open window only if it is less than 1s after the PREVIOUS shift AND less than 5s after the FIRST
 *   shift of that window; CLS is the total of the LARGEST window, not of all shifts.
 *
 * Deliberately a different shape from the implementation (build all the windows, then take a max) so that
 * a mistake in the implementation's incremental form cannot be mirrored here.
 */
function referenceCLS(shifts: Shift[]): number {
  const eligible = shifts.filter((s) => !s.hadRecentInput);
  const windows: Shift[][] = [];
  for (const s of eligible) {
    const open = windows[windows.length - 1];
    const first = open?.[0];
    const last = open?.[open.length - 1];
    const joins =
      open !== undefined &&
      first !== undefined &&
      last !== undefined &&
      s.startTime - last.startTime < 1000 &&
      s.startTime - first.startTime < 5000;
    if (joins) {
      open.push(s);
    } else {
      windows.push([s]);
    }
  }
  const totals = windows.map((w) => w.reduce((sum, s) => sum + s.value, 0));
  return totals.length > 0 ? Math.max(...totals) : 0;
}

/** Run onCLS over `batches` of shifts, finalizing on pagehide; returns the last reported metric. */
function runCLS(batches: Shift[][]): Metric | undefined {
  const { Ctor, instances } = fakeObservers(['layout-shift']);
  const win = fakeWindow();
  const env: WebVitalsEnv = {
    PerformanceObserver: Ctor,
    performance: { now: () => 0, getEntriesByType: () => [] },
    queueMicrotask: (cb) => cb(),
    window: win as never,
  };
  const seen: Metric[] = [];
  onCLS(env, (m) => seen.push(m));
  for (const batch of batches) {
    if (batch.length > 0) {
      instances[0]?.emit(batch.map((s) => shift(s.startTime, s.value, s.hadRecentInput)));
    }
  }
  win.emit('pagehide');
  return seen.at(-1);
}

/** Shifts with ASCENDING start times, since the browser delivers layout shifts in time order. */
const shiftStream = fc
  .array(
    fc.record({
      // Straddles the 1000ms session gap, and lands ON it: a uniform range hits an exact boundary too
      // rarely to defend it, and the 5000ms window bound needs cadences that SUM onto it.
      gap: fc.oneof(
        fc.integer({ min: 0, max: 2000 }),
        fc.constantFrom(999, 1000, 1001, 500, 625, 1250, 2500),
      ),
      // A ZERO-value shift is the case that distinguishes "is a window open?" from "does it have
      // entries?" — the two are the same question except when the open window sums to exactly 0.
      value: fc.oneof(fc.double({ min: 0, max: 0.5, noNaN: true }), fc.constantFrom(0, 0, 0.1)),
      hadRecentInput: fc.boolean(),
    }),
    { maxLength: 25 },
  )
  .map((steps) => {
    let t = 0;
    return steps.map((s) => {
      t += s.gap;
      return { startTime: t, value: s.value, hadRecentInput: s.hadRecentInput };
    });
  });

/** Split a list into consecutive batches, modelling however the observer chooses to deliver them. */
const batched = <T>(items: T[], sizes: number[]): T[][] => {
  const out: T[][] = [];
  let i = 0;
  for (const size of sizes) {
    if (i >= items.length) break;
    out.push(items.slice(i, i + Math.max(1, size)));
    i += Math.max(1, size);
  }
  if (i < items.length) out.push(items.slice(i));
  return out;
};

describe('CLS session windowing (fuzz)', () => {
  it('agrees with the published session-window rule on any shift stream', () => {
    fc.assert(
      fc.property(shiftStream, (shifts) => {
        const metric = runCLS([shifts]);
        expect(metric?.value ?? 0, 'CLS disagrees with the reference model').toBeCloseTo(
          referenceCLS(shifts),
          9,
        );
      }),
      { numRuns: 800 },
    );
  });

  /**
   * The observer batches entries however it likes — one callback per frame, or a burst on takeRecords().
   * The metric must not depend on that, or CLS would vary with unrelated timing.
   */
  it('is unaffected by how the observer batches the same entries', () => {
    fc.assert(
      fc.property(
        shiftStream,
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 8 }),
        (shifts, sizes) => {
          const whole = runCLS([shifts])?.value ?? 0;
          const split = runCLS(batched(shifts, sizes))?.value ?? 0;
          expect(split, 'CLS changed when the same entries arrived in batches').toBeCloseTo(
            whole,
            9,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  /**
   * A shift that followed user input is INERT — the page moved because the user asked it to. Inserting
   * such shifts anywhere, at any size, must leave CLS untouched. A differential property: it compares two
   * runs of the real code rather than restating what the filter does.
   */
  it('ignores input-driven shifts however many are spliced in', () => {
    fc.assert(
      fc.property(
        shiftStream,
        fc.array(fc.record({ at: fc.nat(), value: fc.double({ min: 0, max: 5, noNaN: true }) }), {
          maxLength: 8,
        }),
        (shifts, noise) => {
          const baseline = runCLS([shifts])?.value ?? 0;
          const polluted = [...shifts];
          for (const n of noise) {
            const index = shifts.length === 0 ? 0 : n.at % (polluted.length + 1);
            const at = polluted[Math.min(index, polluted.length - 1)]?.startTime ?? 0;
            polluted.splice(index, 0, {
              startTime: at,
              value: n.value,
              hadRecentInput: true,
            });
          }
          expect(runCLS([polluted])?.value ?? 0, 'an input-driven shift changed CLS').toBeCloseTo(
            baseline,
            9,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  /**
   * Bounds that hold whatever the windowing does: CLS is the total of ONE window, so it can never exceed
   * the total of every eligible shift, and never fall below the largest single shift (which always forms
   * at least a window of its own).
   */
  it('lands between the largest single shift and the total of all of them', () => {
    fc.assert(
      fc.property(shiftStream, (shifts) => {
        const eligible = shifts.filter((s) => !s.hadRecentInput).map((s) => s.value);
        const value = runCLS([shifts])?.value ?? 0;
        const total = eligible.reduce((a, b) => a + b, 0);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value, 'CLS exceeded the total of every shift').toBeLessThanOrEqual(total + 1e-9);
        if (eligible.length > 0) {
          expect(value + 1e-9, 'CLS was below the largest single shift').toBeGreaterThanOrEqual(
            Math.max(...eligible),
          );
        }
      }),
      { numRuns: 500 },
    );
  });

  it('reports the metric under its own name, with the contributing entries attached', () => {
    fc.assert(
      fc.property(
        shiftStream.filter((s) => s.some((x) => !x.hadRecentInput && x.value > 0)),
        (shifts) => {
          const metric = runCLS([shifts]);
          expect(metric?.name, 'the metric is not labelled CLS').toBe('CLS');
          // The attached entries ARE the winning window — that is what makes a bad CLS diagnosable.
          expect(metric?.entries.length, 'no entries were attached').toBeGreaterThan(0);
          const attached = (metric?.entries ?? []) as unknown as { value: number }[];
          const sum = attached.reduce((a, e) => a + e.value, 0);
          expect(sum, 'the attached entries do not add up to the reported value').toBeCloseTo(
            metric?.value ?? 0,
            9,
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// INP
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Interaction {
  interactionId: number;
  duration: number;
}

/**
 * The published INP rule, written from the specification:
 *
 *   an interaction's latency is the LONGEST of its entries; keep the 10 worst interactions; INP is the
 *   one at index floor(interactionCount / 50) — the single worst under 50 interactions, and one further
 *   outlier skipped per additional 50. Entries longer than an hour are implausible and dropped.
 */
function referenceINP(entries: Interaction[], interactionCount: number): number | undefined {
  const byId = new Map<number, number>();
  for (const e of entries) {
    if (e.duration > 60_000) continue;
    byId.set(e.interactionId, Math.max(byId.get(e.interactionId) ?? 0, e.duration));
  }
  const worst = [...byId.values()].sort((a, b) => b - a).slice(0, 10);
  if (worst.length === 0) return undefined;
  return worst[Math.min(worst.length - 1, Math.floor(interactionCount / 50))];
}

function runINP(batches: Interaction[][], interactionCount: number): Metric | undefined {
  const { Ctor, find } = fakeObservers(['event', 'first-input']);
  const win = fakeWindow();
  const env: WebVitalsEnv = {
    PerformanceObserver: Ctor,
    performance: { now: () => 0, getEntriesByType: () => [], interactionCount } as never,
    queueMicrotask: (cb) => cb(),
    window: win as never,
  };
  const seen: Metric[] = [];
  onINP(env, (m) => seen.push(m));
  for (const batch of batches) {
    if (batch.length > 0) {
      find('event', 40)?.emit(batch.map((e) => ev(e.interactionId, e.duration)));
    }
  }
  win.emit('pagehide');
  return seen.at(-1);
}

/** Interactions with repeated ids, so the group-by-id/max path is actually exercised. */
const interactionStream = fc.array(
  fc.record({
    // TWO id spaces. A small one forces collisions, since a real interaction emits several entries under
    // one id and the max-across-the-group rule is unreachable without repeats. A wide one produces more
    // than ten DISTINCT interactions, without which the ten-worst cap is never actually applied — the
    // first version of this generator only had the small space, and the cap survived mutation.
    interactionId: fc
      .oneof(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 40 }))
      .map((n) => n * 7),
    duration: fc.oneof(
      fc.integer({ min: 41, max: 2000 }),
      fc.constantFrom(60_000, 60_001, 59_999, 3_600_000), // the implausibility boundary
    ),
  }),
  { maxLength: 60 },
);

describe('INP interaction ranking (fuzz)', () => {
  it('agrees with the published p98 rule on any interaction stream', () => {
    fc.assert(
      fc.property(
        interactionStream,
        fc.integer({ min: 0, max: 400 }),
        (entries, interactionCount) => {
          const metric = runINP([entries], interactionCount);
          expect(metric?.value, 'INP disagrees with the reference model').toBe(
            referenceINP(entries, interactionCount) ?? metric?.value,
          );
          if (referenceINP(entries, interactionCount) === undefined) {
            expect(metric, 'a metric was reported with no eligible interaction').toBeUndefined();
          }
        },
      ),
      { numRuns: 800 },
    );
  });

  it('is unaffected by how the observer batches the same entries', () => {
    fc.assert(
      fc.property(
        interactionStream,
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 400 }),
        (entries, sizes, count) => {
          expect(runINP(batched(entries, sizes), count)?.value).toBe(
            runINP([entries], count)?.value,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  /** Whatever the ranking does, INP is always a latency that was actually observed — never interpolated. */
  it('only ever reports a latency that some interaction actually had', () => {
    fc.assert(
      fc.property(interactionStream, fc.integer({ min: 0, max: 400 }), (entries, count) => {
        const value = runINP([entries], count)?.value;
        if (value === undefined) return;
        const observed = entries.filter((e) => e.duration <= 60_000).map((e) => e.duration);
        expect(observed, `INP ${value} was never observed`).toContain(value);
        expect(value, 'INP exceeded the worst interaction').toBeLessThanOrEqual(
          Math.max(...observed),
        );
      }),
      { numRuns: 500 },
    );
  });

  /** Under 50 interactions the p98 index is 0, so INP is exactly the worst interaction. */
  it('is the worst interaction while under 50 of them', () => {
    fc.assert(
      fc.property(interactionStream, fc.integer({ min: 0, max: 49 }), (entries, count) => {
        const eligible = entries.filter((e) => e.duration <= 60_000);
        if (eligible.length === 0) return;
        expect(runINP([entries], count)?.value, 'INP was not the worst interaction').toBe(
          Math.max(...eligible.map((e) => e.duration)),
        );
      }),
      { numRuns: 500 },
    );
  });

  /**
   * An implausible entry is dropped ENTIRELY — it must not even claim its interaction id, or a real
   * interaction sharing that id would be lost with it.
   */
  it('drops hour-long outliers without losing the rest of their interaction', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 41, max: 5000 }),
        fc.integer({ min: 60_001, max: 7_200_000 }),
        fc.integer({ min: 0, max: 49 }),
        (real, absurd, count) => {
          const value = runINP(
            [
              [
                { interactionId: 7, duration: absurd },
                { interactionId: 7, duration: real },
              ],
            ],
            count,
          )?.value;
          expect(value, 'an implausible duration reached the metric').toBe(real);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('reports the metric under its own name, with the winning interaction’s entries attached', () => {
    fc.assert(
      fc.property(
        interactionStream.filter((e) => e.some((x) => x.duration <= 60_000)),
        fc.integer({ min: 0, max: 49 }),
        (entries, count) => {
          const metric = runINP([entries], count);
          expect(metric?.name, 'the metric is not labelled INP').toBe('INP');
          expect(metric?.entries.length, 'no entries were attached').toBeGreaterThan(0);
          // Every attached entry belongs to the ONE interaction that was reported.
          const ids = new Set(
            (metric?.entries ?? []).map(
              (e) => (e as unknown as { interactionId: number }).interactionId,
            ),
          );
          expect(ids.size, 'entries from more than one interaction were attached').toBe(1);
        },
      ),
      { numRuns: 400 },
    );
  });
});
