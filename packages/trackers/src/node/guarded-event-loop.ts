import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// Guarded, LAZY event-loop sources for node-family runtimes with PARTIAL perf_hooks (Bun, Deno). Nothing is
// constructed or enabled until start(): a source that is never started costs nothing, and a runtime whose
// monitorEventLoopDelay throws degrades to "lag omitted" rather than aborting SDK startup.

export interface EventLoopSource {
  /**
   * Mean/max/p99 lag (ms) since the previous read, or undefined when the runtime cannot measure it. A field the
   * histogram reports as non-finite is OMITTED from the result (never zeroed); when none is usable the read is undefined.
   */
  read(): { meanMs?: number; maxMs?: number; p99Ms?: number } | undefined;
  start(): void;
  stop(): void;
}

/** The slice of an event-loop-delay histogram the lag metrics read. */
export interface DelayHistogram {
  enable(): void;
  disable?(): void;
  reset(): void;
  /** Samples taken since the last reset (Node). Absent on runtimes that do not expose it. */
  readonly count?: number;
  readonly mean: number;
  readonly max: number;
  percentile(p: number): number;
}
export interface Elu {
  utilization: number;
  /** Present on a real implementation; used to tell "not implemented" from "idle" — see `eluUnavailable`. */
  idle?: number;
  active?: number;
}
/** The two perf_hooks primitives the event-loop metrics need (partial on Bun/Deno, so injected). */
export interface PerfHooks {
  monitorEventLoopDelay: () => DelayHistogram;
  eventLoopUtilization: (a?: Elu, b?: Elu) => Elu;
}

export const realPerfHooks: PerfHooks = {
  monitorEventLoopDelay: () => monitorEventLoopDelay(),
  eventLoopUtilization: (a, b) =>
    (performance.eventLoopUtilization as (a?: Elu, b?: Elu) => Elu)(a, b),
};

/**
 * Does this delta mean "the runtime does not implement ELU" rather than "the loop was idle"?
 *
 * `performance.eventLoopUtilization()` exists on Bun and Deno and does not throw — it simply answers
 * `{idle:0, active:0, utilization:0}` for ever. Measured 2026-09-01, after a 120ms CPU burn and a 60ms
 * sleep: node reported `{idle:61.0, active:0.118}` while Bun and Deno both reported zeros. A throw-guard
 * cannot see that, so the SDK shipped a confident 0% utilization — which reads, to whoever opens the
 * report, exactly like a perfectly healthy idle process.
 *
 * `idle` is the discriminator, not `utilization`: on any honest implementation idle accumulates
 * wall-clock time between samples, so at a 1s cadence it cannot be zero. A process that genuinely did
 * nothing reports utilization 0 with a non-zero idle, and that reading is true and worth keeping.
 */
export const eluUnavailable = (delta: { idle?: number; active?: number }): boolean =>
  delta.idle === 0 && delta.active === 0;

/** ns → ms; undefined (omit, never zero) when a sampled histogram still reports a non-finite field. */
const lagMs = (ns: number): number | undefined => (Number.isFinite(ns) ? ns / 1e6 : undefined);

/**
 * Has the histogram taken no sample yet? Right after enable()+reset() its mean is NaN and max/p99 are ~0 —
 * reading it then would fabricate a "healthy loop" baseline. `count` is authoritative when the runtime
 * exposes it; otherwise a non-finite mean is the tell.
 */
const isEmpty = (h: DelayHistogram): boolean =>
  typeof h.count === 'number' ? h.count === 0 : !Number.isFinite(h.mean);

export function createGuardedEventLoopSource(monitor: () => DelayHistogram): EventLoopSource {
  let histogram: DelayHistogram | undefined;
  let unusable = false;
  return {
    start() {
      if (unusable) return;
      try {
        histogram ??= monitor();
        histogram.enable();
        histogram.reset();
      } catch {
        unusable = true; // a partial runtime must not abort SDK startup
        try {
          histogram?.disable?.(); // enable() may have succeeded: never leave a dropped histogram running
        } catch {
          /* best-effort */
        }
        histogram = undefined;
      }
    },
    stop() {
      try {
        histogram?.disable?.();
      } catch {
        /* best-effort */
      }
    },
    read() {
      if (histogram === undefined) return undefined; // not started: omit, never zero
      try {
        if (isEmpty(histogram)) return undefined; // nothing measured yet: omit, never a fake zero
        const meanMs = lagMs(histogram.mean);
        const maxMs = lagMs(histogram.max);
        const p99Ms = lagMs(histogram.percentile(99));
        histogram.reset();
        if (meanMs === undefined && maxMs === undefined && p99Ms === undefined) return undefined;
        return {
          ...(meanMs !== undefined ? { meanMs } : {}),
          ...(maxMs !== undefined ? { maxMs } : {}),
          ...(p99Ms !== undefined ? { p99Ms } : {}),
        };
      } catch {
        return undefined;
      }
    },
  };
}

// A utilization reader (delta 0..1). `undefined` — NOT zero — whenever the runtime cannot give a real
// reading: it threw, or it answered the Bun/Deno way (idle and active both zero for ever).
export function createGuardedElu(elu: PerfHooks['eventLoopUtilization']): () => number | undefined {
  let prev: Elu;
  try {
    prev = elu();
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      const current = elu();
      const delta = elu(current, prev);
      prev = current;
      return eluUnavailable(delta) ? undefined : delta.utilization;
    } catch {
      return undefined;
    }
  };
}
