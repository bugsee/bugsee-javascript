import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { eluUnavailable } from '../system-metrics';
import type { EventLoopSource } from './process-stats-tracker';

// Guarded, LAZY event-loop sources for node-family runtimes with PARTIAL perf_hooks (Bun, Deno). Nothing is
// constructed or enabled until start(): a source that is never started costs nothing, and a runtime whose
// monitorEventLoopDelay throws degrades to "lag omitted" rather than aborting SDK startup.

/** The slice of an event-loop-delay histogram the lag metrics read. */
export interface DelayHistogram {
  enable(): void;
  disable?(): void;
  reset(): void;
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

export { eluUnavailable };

/** ns → ms; 0 when non-finite (e.g. NaN before the first tick). */
const lagMs = (ns: number): number => (Number.isFinite(ns) ? ns / 1e6 : 0);

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
        const out = {
          meanMs: lagMs(histogram.mean),
          maxMs: lagMs(histogram.max),
          p99Ms: lagMs(histogram.percentile(99)),
        };
        histogram.reset();
        return out;
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
