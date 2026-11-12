import { type CaptureDataEntry, CaptureDataEntryBase, type Scheduler } from '@bugsee/core';
import type { CpuProfile, CpuProfiler } from './cpu-profiler';

// The rolling CPU-profiling controller (node diagnostics). It runs the V8 sampling profiler
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
  /** Wall-clock ms; injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * How long a segment taken for a hang report stays reusable. A hang escalates fair → medium → severe and the
 * main thread hears all of them at once, when the block ends: only the first would otherwise see the stall in
 * its profile (the collect restarts the segment, so the rest would get an empty one).
 */
const HOLD_MS = 3000;

export interface ProfilingController {
  /** Start sampling + the rolling-restart timer. */
  start(): void;
  /** The pull-at-report snapshot source: collect the current segment as a `profile` capture entry. */
  snapshot(now: number): Promise<CaptureDataEntry[]>;
  /**
   * Collect the current segment for a HANG report and retain it for a few seconds, so the burst of escalation
   * reports (and the profile.json each bundles) all see the stall. Resolves undefined when there is no profile.
   */
  hold(): Promise<CpuProfile | undefined>;
  /** Stop the rolling timer and the profiler. */
  stop(): void;
}

export function createProfilingController(deps: ProfilingControllerDeps): ProfilingController {
  const { profiler, scheduler, rollingIntervalMs } = deps;
  const now = deps.now ?? Date.now;
  let handle: unknown;
  let held: { profile: CpuProfile; at: number } | undefined;

  // Serialize every collect() so the rolling tick and a report never stop+restart the session at once.
  // profiler.collect() resolves (never rejects), so the chain stays settled.
  let chain: Promise<unknown> = Promise.resolve();
  const collect = (retain: boolean): Promise<CpuProfile | undefined> => {
    const next = chain.then(async () => {
      if (held !== undefined && now() - held.at < HOLD_MS) {
        return held.profile;
      }
      held = undefined;
      const profile = await profiler.collect();
      if (retain && profile !== undefined) {
        held = { profile, at: now() };
      }
      return profile;
    });
    chain = next;
    return next;
  };

  return {
    start() {
      void profiler.start();
      handle = scheduler.setInterval(() => {
        held = undefined; // never keep a stale segment for a whole window
        void collect(false); // discard — the rolling tick just caps the segment length
      }, rollingIntervalMs);
    },

    async snapshot(now: number): Promise<CaptureDataEntry[]> {
      const profile = await collect(false);
      return profile ? [new CaptureDataEntryBase('profile', now, profile)] : [];
    },

    hold: () => collect(true),

    stop() {
      held = undefined;
      if (handle !== undefined) {
        scheduler.clearInterval(handle);
        handle = undefined;
      }
      void profiler.stop();
    },
  };
}
