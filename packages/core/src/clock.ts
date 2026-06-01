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
  const usable = !!perf && typeof perf.now === 'function' && typeof perf.timeOrigin === 'number';
  const monotonicNow = usable
    ? () => (perf as PerfLike).now() + (perf as PerfLike).timeOrigin
    : () => Date.now();

  return {
    wallNow: () => Date.now(),
    monotonicNow,
  };
}
