import { serviceToken } from '@bugsee/service';

// Clock model (design §7.7). Two distinct time sources, injectable so downstream components can use
// a deterministic fake in tests:
//   - wallNow():      Date.now() unix-ms, for wire `timestamp` fields (matches mobile).
//   - monotonicNow(): performance.now() + performance.timeOrigin, for INTERNAL ordering & durations
//                     (monotonic, unaffected by wall-clock adjustments). Falls back to Date.now()
//                     on runtimes without a usable `performance` (best-effort; not strictly monotonic).

export interface Clock {
  /** Wall-clock unix-ms for wire `timestamp` fields. */
  wallNow(): number;
  /** High-resolution timestamp (ms) for internal ordering and duration math. */
  monotonicNow(): number;
}

/** Service token for the clock; the client registers the resolved clock (injected or createSystemClock). */
export const ClockToken = serviceToken<Clock>('clock');

interface PerfLike {
  now(): number;
  timeOrigin: number;
}

export function createSystemClock(): Clock {
  const perf = (globalThis as { performance?: Partial<PerfLike> }).performance;
  // `Number.isFinite`, not `typeof … === 'number'`: `typeof NaN === 'number'` is TRUE, so the old check
  // let a NaN timeOrigin through and poisoned every monotonicNow() reading into NaN — a non-monotonic
  // clock silently corrupting internal ordering/duration math far more broadly than a single capture
  // source. `Number.isFinite` also rejects Infinity/-Infinity (same poisoning) and, being false for any
  // non-number, a non-number arriving through this unchecked `globalThis` cast.
  //
  // Unlike the browser UI-breadcrumb source (and the render-timing helpers below the core tier), a literal
  // `0` is NOT special-cased here: monotonicNow() is consumed only as a DIFFERENCE of two readings
  // (RateLimiter interval math, Span duration math — see `docs/design/sdk-design.md` §7.7) and never
  // surfaced as an absolute wire timestamp, so a constant `0` offset cancels exactly and is fully usable.
  const usable = !!perf && typeof perf.now === 'function' && Number.isFinite(perf.timeOrigin);
  const monotonicNow = usable
    ? () => (perf as PerfLike).now() + (perf as PerfLike).timeOrigin
    : () => Date.now();

  return {
    wallNow: () => Date.now(),
    monotonicNow,
  };
}
