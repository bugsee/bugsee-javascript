import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { TraceSample } from '@bugsee/capture';
import { createNodeSystemMetricsSampler, type NodeSystemMetricsDeps } from './system-metrics';

// A guarded system-metrics sampler for node-family runtimes with PARTIAL perf_hooks (Bun, Deno). Process
// memory/CPU and OS memory reads work identically to Node, so this reuses createNodeSystemMetricsSampler
// verbatim — EXCEPT the event-loop metrics, which lean on perf_hooks APIs (monitorEventLoopDelay /
// eventLoopUtilization) that Bun and Deno support only partially. Those two primitives are injected (default
// node:perf_hooks) and GUARDED: if either is absent or throws (at construction OR per-read), its metric
// degrades to zero instead of breaking the whole sampler. On Node (full perf_hooks) the guard is a harmless
// pass-through.

type EventLoopSample = { meanMs: number; maxMs: number; p99Ms: number };

/** The slice of an event-loop-delay histogram the lag metrics read. */
interface DelayHistogram {
  enable(): void;
  reset(): void;
  readonly mean: number;
  readonly max: number;
  percentile(p: number): number;
}
interface Elu {
  utilization: number;
}
/** The two perf_hooks primitives the event-loop metrics need (partial on Bun/Deno → injected). */
export interface PerfHooks {
  monitorEventLoopDelay: () => DelayHistogram;
  eventLoopUtilization: (a?: Elu, b?: Elu) => Elu;
}

const realPerfHooks: PerfHooks = {
  monitorEventLoopDelay: () => monitorEventLoopDelay(),
  eventLoopUtilization: (a, b) =>
    (performance.eventLoopUtilization as (a?: Elu, b?: Elu) => Elu)(a, b),
};

/** ns → ms; 0 when non-finite (e.g. NaN before the first tick). */
const lagMs = (ns: number): number => (Number.isFinite(ns) ? ns / 1e6 : 0);
const zeroLoop = (): EventLoopSample => ({ meanMs: 0, maxMs: 0, p99Ms: 0 });

// Build a lag reader from the histogram primitive; if it throws at construction, degrade to a zero reader.
function guardedEventLoop(monitor: () => DelayHistogram): () => EventLoopSample {
  let histogram: DelayHistogram;
  try {
    histogram = monitor();
    histogram.enable();
  } catch {
    return zeroLoop;
  }
  return () => {
    // Guard the READS too, not just construction: the system-traces provider runs its first sample
    // synchronously inside client.launch(), so a partial-runtime read-time throw must degrade to zero
    // rather than abort SDK startup.
    try {
      const out = {
        meanMs: lagMs(histogram.mean),
        maxMs: lagMs(histogram.max),
        p99Ms: lagMs(histogram.percentile(99)),
      };
      histogram.reset();
      return out;
    } catch {
      return zeroLoop();
    }
  };
}

// Build a utilization reader (delta 0..1) from the ELU primitive; if it throws at construction → zero.
function guardedElu(elu: PerfHooks['eventLoopUtilization']): () => number {
  let prev: Elu;
  try {
    prev = elu();
  } catch {
    return () => 0;
  }
  return () => {
    try {
      const current = elu();
      const delta = elu(current, prev);
      prev = current;
      return delta.utilization;
    } catch {
      return 0;
    }
  };
}

export interface GuardedSystemMetricsDeps extends NodeSystemMetricsDeps {
  /** perf_hooks primitives for the event-loop metrics (partial on Bun/Deno). Default node:perf_hooks. */
  perfHooks?: PerfHooks;
}

export function createGuardedSystemMetricsSampler(
  deps: GuardedSystemMetricsDeps = {},
): () => TraceSample[] {
  const { perfHooks, ...nodeDeps } = deps;
  const perf = perfHooks ?? realPerfHooks;
  return createNodeSystemMetricsSampler({
    eventLoop: guardedEventLoop(perf.monitorEventLoopDelay),
    eventLoopUtilization: guardedElu(perf.eventLoopUtilization),
    ...nodeDeps, // an explicit caller-supplied reader wins over the guarded default
  });
}
