import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { TraceSample } from '@bugsee/capture';
import {
  createNodeSystemMetricsSampler,
  eluUnavailable,
  type NodeSystemMetricsDeps,
} from './system-metrics';

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
  /** Present on a real implementation; used to tell "not implemented" from "idle" — see `eluUnavailable`. */
  idle?: number;
  active?: number;
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
const unavailableLoop = (): undefined => undefined;

// Build a lag reader from the histogram primitive. Answers `undefined` — never zero — when the runtime
// cannot give a real reading: "0 ms of event-loop lag" is exactly what a perfectly healthy process
// reports, so a fabricated zero is indistinguishable from good news.
function guardedEventLoop(monitor: () => DelayHistogram): () => EventLoopSample | undefined {
  let histogram: DelayHistogram;
  try {
    histogram = monitor();
    histogram.enable();
  } catch {
    return unavailableLoop;
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
      return undefined;
    }
  };
}

// Build a utilization reader (delta 0..1) from the ELU primitive. Answers `undefined` — NOT zero —
// whenever the runtime cannot give a real reading: it threw, or it answered the way Bun and Deno do,
// with a delta whose idle and active are both zero for ever (see `eluUnavailable`). Zero was a
// confident wrong answer; absence is an honest one.
function guardedElu(elu: PerfHooks['eventLoopUtilization']): () => number | undefined {
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

export interface GuardedSystemMetricsDeps extends NodeSystemMetricsDeps {
  /** perf_hooks primitives for the event-loop metrics (partial on Bun/Deno). Default node:perf_hooks. */
  perfHooks?: PerfHooks;
  /**
   * Does this runtime's `monitorEventLoopDelay` actually observe a BLOCKED loop? Default `true`.
   *
   * Deno's does not. It answers, it never throws, and it never registers a stall — measured against a
   * real 150 ms synchronous block: node 160.956 ms, bun 146.634 ms, deno 0.065 ms. There is no passive
   * tell the way there is for ELU (where a zero `idle` gives it away), so the composition root that
   * knows which runtime it is on passes `false` and the lag traces are omitted rather than reporting a
   * healthy loop through a freeze. `@bugsee/deno` sets this; node and bun leave it alone.
   */
  measuresEventLoopDelay?: boolean;
}

export function createGuardedSystemMetricsSampler(
  deps: GuardedSystemMetricsDeps = {},
): () => TraceSample[] {
  const { perfHooks, measuresEventLoopDelay = true, ...nodeDeps } = deps;
  const perf = perfHooks ?? realPerfHooks;
  return createNodeSystemMetricsSampler({
    eventLoop: measuresEventLoopDelay
      ? guardedEventLoop(perf.monitorEventLoopDelay)
      : unavailableLoop,
    eventLoopUtilization: guardedElu(perf.eventLoopUtilization),
    ...nodeDeps, // an explicit caller-supplied reader wins over the guarded default
  });
}
