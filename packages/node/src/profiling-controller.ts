import { type CaptureDataEntry, CaptureDataEntryBase, type Scheduler } from '@bugsee/core';
import type { CpuProfile, CpuProfiler } from './cpu-profiler';

// The rolling CPU-profiling controller (node diagnostics, C2). It runs the V8 sampling profiler
// continuously and exposes a pull-at-report SNAPSHOT source that attaches the current segment to the
// incident bundle as `profile.json`. A rolling-restart timer (every recording window) discards the
// accreting segment so a long-lived process never accumulates an unbounded profile; the segment the
// report pulls always ENDS at the report, so the just-occurred incident's frames are in it.
//
// Both the rolling timer and the report snapshot call profiler.collect() (which stop+restarts the
// session), so they MUST be serialized — two concurrent Profiler.stop calls would corrupt the inspector
// session. A single promise chain enforces one-at-a-time ordering.

export interface ProfilingControllerDeps {
  profiler: CpuProfiler;
  scheduler: Scheduler;
  /** Rolling-restart interval (ms) — the cap on a single segment; typically the recording window. */
  rollingIntervalMs: number;
}

export interface ProfilingController {
  /** Start sampling + the rolling-restart timer. */
  start(): void;
  /** The pull-at-report snapshot source: collect the current segment as a `profile` capture entry. */
  snapshot(now: number): Promise<CaptureDataEntry[]>;
  /** Stop the rolling timer and the profiler. */
  stop(): void;
}

export function createProfilingController(deps: ProfilingControllerDeps): ProfilingController {
  const { profiler, scheduler, rollingIntervalMs } = deps;
  let handle: unknown;

  // Serialize every collect() so the rolling tick and a report never stop+restart the session at once.
  // profiler.collect() resolves (never rejects), so the chain stays settled.
  let chain: Promise<unknown> = Promise.resolve();
  const collect = (): Promise<CpuProfile | undefined> => {
    const next = chain.then(() => profiler.collect());
    chain = next;
    return next;
  };

  return {
    start() {
      void profiler.start();
      handle = scheduler.setInterval(() => {
        void collect(); // discard — the rolling tick just caps the segment length
      }, rollingIntervalMs);
    },

    async snapshot(now: number): Promise<CaptureDataEntry[]> {
      const profile = await collect();
      return profile ? [new CaptureDataEntryBase('profile', now, profile)] : [];
    },

    stop() {
      if (handle !== undefined) {
        scheduler.clearInterval(handle);
        handle = undefined;
      }
      void profiler.stop();
    },
  };
}
