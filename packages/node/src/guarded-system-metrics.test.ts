import type { TraceSample } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import { createGuardedSystemMetricsSampler } from './guarded-system-metrics';

// A controllable event-loop delay histogram (readings in ns).
function fakeHistogram(readings: { mean: number; max: number; p99: number }) {
  const state = { enabled: false, resets: 0 };
  return {
    state,
    histogram: {
      enable() {
        state.enabled = true;
      },
      reset() {
        state.resets += 1;
      },
      get mean() {
        return readings.mean;
      },
      get max() {
        return readings.max;
      },
      percentile() {
        return readings.p99;
      },
    },
  };
}

// An ELU stub: 0-arg returns a snapshot, 2-arg returns a fixed delta utilization.
const fakeElu =
  (delta: number) =>
  (a?: { utilization: number }): { utilization: number } =>
    a === undefined ? { utilization: 0 } : { utilization: delta };

const metricValue = (samples: TraceSample[], name: string): number | undefined =>
  samples.find((s) => s.name === name)?.value as number | undefined;

describe('createGuardedSystemMetricsSampler', () => {
  it('reads event-loop lag (ns→ms) + utilization from perf_hooks when supported', () => {
    const { histogram, state } = fakeHistogram({ mean: 5e6, max: 9e6, p99: 7e6 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: fakeElu(0.42) },
    })();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(5);
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBe(9);
    expect(metricValue(sample, 'event_loop_lag_p99_ms')).toBe(7);
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0.42);
    expect(state.enabled).toBe(true); // the histogram was enabled at construction
    expect(state.resets).toBe(1); // and reset after the read
  });

  it('degrades event-loop LAG to zero when monitorEventLoopDelay throws (partial perf_hooks)', () => {
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: {
        monitorEventLoopDelay: () => {
          throw new Error('unsupported on this runtime');
        },
        eventLoopUtilization: fakeElu(0.3),
      },
    })();
    // OMITTED, not zeroed: "0 ms of event-loop lag" is what a perfectly healthy process reports.
    expect(metricValue(sample, 'event_loop_lag_ms')).toBeUndefined();
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBeUndefined();
    expect(metricValue(sample, 'event_loop_lag_p99_ms')).toBeUndefined();
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0.3); // ELU still works → unaffected
  });

  it('OMITS utilization when eventLoopUtilization throws', () => {
    const { histogram } = fakeHistogram({ mean: 2e6, max: 2e6, p99: 2e6 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: {
        monitorEventLoopDelay: () => histogram,
        eventLoopUtilization: () => {
          throw new Error('unsupported');
        },
      },
    })();
    // OMITTED, not zero. Reporting 0 for a primitive that could not be read is a confident wrong
    // answer: a support engineer reads "0% event-loop utilization" as a healthy idle process.
    expect(metricValue(sample, 'event_loop_utilization')).toBeUndefined();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(2); // lag still works → unaffected
  });

  it('treats a non-finite histogram reading as zero lag', () => {
    const { histogram } = fakeHistogram({ mean: Number.NaN, max: 5e6, p99: 5e6 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: fakeElu(0) },
    })();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(0); // NaN → 0
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBe(5);
  });

  it('degrades event-loop lag to zero if a histogram READ throws (not just construction)', () => {
    // Construction (enable) succeeds, but reading `.mean` throws — a partial-runtime sample-time failure.
    const throwingHistogram = {
      enable() {},
      reset() {},
      get mean(): number {
        throw new Error('read failed');
      },
      get max() {
        return 0;
      },
      percentile() {
        return 0;
      },
    };
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: {
        monitorEventLoopDelay: () => throwingHistogram,
        eventLoopUtilization: fakeElu(0),
      },
    })();
    // The reader must NOT throw out of the sampler (it runs synchronously in launch()'s first sample),
    // and it must not invent a reading either.
    expect(metricValue(sample, 'event_loop_lag_ms')).toBeUndefined();
  });

  it('OMITS utilization if the ELU delta READ throws (not just init)', () => {
    // 0-arg init succeeds; the 2-arg delta form throws (a partial-runtime sample-time failure).
    const elu = (a?: { utilization: number }): { utilization: number } => {
      if (a !== undefined) {
        throw new Error('delta failed');
      }
      return { utilization: 0 };
    };
    const { histogram } = fakeHistogram({ mean: 1e6, max: 1e6, p99: 1e6 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: elu },
    })();
    expect(metricValue(sample, 'event_loop_utilization')).toBeUndefined();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(1); // lag unaffected
  });

  it('defaults to real node:perf_hooks when no perfHooks are injected (the runtime supports them)', () => {
    const sample = createGuardedSystemMetricsSampler()();
    // The default path uses the live perf_hooks; the entries exist and are finite numbers.
    expect(Number.isFinite(metricValue(sample, 'event_loop_lag_ms') ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(metricValue(sample, 'event_loop_utilization') ?? Number.NaN)).toBe(true);
  });

  it('lets caller-supplied node deps override the guarded event-loop reader', () => {
    const { histogram } = fakeHistogram({ mean: 99e6, max: 99e6, p99: 99e6 });
    const sample = createGuardedSystemMetricsSampler({
      eventLoop: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }),
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: fakeElu(0) },
    })();
    // The explicit dep wins over the guarded perf_hooks reader (1, not 99).
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(1);
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBe(2);
  });
});

describe('createGuardedSystemMetricsSampler — a runtime that ANSWERS but does not implement ELU', () => {
  it('omits event_loop_utilization on the Bun/Deno shape instead of reporting a plausible 0%', () => {
    // Measured 2026-09-01 on real runtimes, after a 120ms CPU burn and a 60ms sleep:
    //   node  delta={"idle":61.0,"active":0.118,"utilization":0.0019}
    //   bun   delta={"idle":0,"active":0,"utilization":0}
    //   deno  delta={"idle":0,"active":0,"utilization":0}
    // The call SUCCEEDS on Bun and Deno, so the throw-guard never fires and the SDK shipped a confident
    // 0% forever — indistinguishable, to whoever reads the report, from a perfectly healthy idle loop.
    // `idle` is the discriminator: on any honest implementation it accumulates wall-clock time between
    // samples, so at a 1s cadence it cannot be zero.
    const flat = () => ({ idle: 0, active: 0, utilization: 0 });
    const { histogram } = fakeHistogram({ mean: 2e6, max: 2e6, p99: 2e6 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: flat },
    })();
    expect(metricValue(sample, 'event_loop_utilization')).toBeUndefined();
    // …and everything the runtime CAN answer is still reported.
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(2);
  });

  it('still reports a genuine zero when the runtime says idle time actually passed', () => {
    // The positive control, and the reason `utilization === 0` alone is not the test: a real process
    // that did nothing at all reports utilization 0 with a NON-zero idle, and that reading is true.
    const idleButReal = () => ({ idle: 1000, active: 0, utilization: 0 });
    const { histogram } = fakeHistogram({ mean: 2e6, max: 2e6, p99: 2e6 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: idleButReal },
    })();
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0);
  });
});

describe('createGuardedSystemMetricsSampler — a runtime whose histogram cannot SEE a blocked loop', () => {
  it('omits the lag traces when the runtime is declared unable to measure them', () => {
    // Measured 2026-09-01 with the histogram sampling an idle loop first, then a real 150ms synchronous
    // block:
    //   node  idle floor 11.067ms -> 160.956ms   (sees it)
    //   bun   idle floor  1.016ms -> 146.634ms   (sees it)
    //   deno  idle floor  0.022ms ->   0.065ms   (BLIND)
    // Deno's `monitorEventLoopDelay` answers, and does not throw, so there is no passive tell the way
    // there is for ELU — it simply never registers a stall. Reporting 0.065ms through a 150ms freeze is
    // the same lie as a 0% utilization, so the runtime that knows it cannot measure says so.
    const { histogram } = fakeHistogram({ mean: 22_000, max: 65_000, p99: 40_000 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: fakeElu(0.4) },
      measuresEventLoopDelay: false,
    })();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBeUndefined();
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBeUndefined();
    expect(metricValue(sample, 'event_loop_lag_p99_ms')).toBeUndefined();
    // …and everything the runtime CAN answer is still reported.
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0.4);
    expect(metricValue(sample, 'process_memory_rss')).toBeGreaterThan(0);
  });

  it('reports the lag traces by default — the positive control', () => {
    const { histogram } = fakeHistogram({ mean: 2e6, max: 2e6, p99: 2e6 });
    const sample = createGuardedSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: fakeElu(0.4) },
    })();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(2);
  });
});
