import type { TraceSample } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import { createBunSystemMetricsSampler } from './system-metrics';

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

describe('createBunSystemMetricsSampler', () => {
  it('reads event-loop lag (ns→ms) + utilization from perf_hooks when supported', () => {
    const { histogram, state } = fakeHistogram({ mean: 5e6, max: 9e6, p99: 7e6 });
    const sample = createBunSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: fakeElu(0.42) },
    })();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(5);
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBe(9);
    expect(metricValue(sample, 'event_loop_lag_p99_ms')).toBe(7);
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0.42);
    expect(state.enabled).toBe(true); // the histogram was enabled at construction
    expect(state.resets).toBe(1); // and reset after the read
  });

  it('degrades event-loop LAG to zero when monitorEventLoopDelay throws (partial Bun perf_hooks)', () => {
    const sample = createBunSystemMetricsSampler({
      perfHooks: {
        monitorEventLoopDelay: () => {
          throw new Error('unsupported on this runtime');
        },
        eventLoopUtilization: fakeElu(0.3),
      },
    })();
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(0);
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBe(0);
    expect(metricValue(sample, 'event_loop_lag_p99_ms')).toBe(0);
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0.3); // ELU still works → unaffected
  });

  it('degrades UTILIZATION to zero when eventLoopUtilization throws', () => {
    const { histogram } = fakeHistogram({ mean: 2e6, max: 2e6, p99: 2e6 });
    const sample = createBunSystemMetricsSampler({
      perfHooks: {
        monitorEventLoopDelay: () => histogram,
        eventLoopUtilization: () => {
          throw new Error('unsupported');
        },
      },
    })();
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0);
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(2); // lag still works → unaffected
  });

  it('treats a non-finite histogram reading as zero lag', () => {
    const { histogram } = fakeHistogram({ mean: Number.NaN, max: 5e6, p99: 5e6 });
    const sample = createBunSystemMetricsSampler({
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
    const sample = createBunSystemMetricsSampler({
      perfHooks: {
        monitorEventLoopDelay: () => throwingHistogram,
        eventLoopUtilization: fakeElu(0),
      },
    })();
    // The reader must NOT throw out of the sampler (it runs synchronously in launch()'s first sample).
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(0);
  });

  it('degrades utilization to zero if the ELU delta READ throws (not just init)', () => {
    // 0-arg init succeeds; the 2-arg delta form throws (a partial-runtime sample-time failure).
    const elu = (a?: { utilization: number }): { utilization: number } => {
      if (a !== undefined) {
        throw new Error('delta failed');
      }
      return { utilization: 0 };
    };
    const { histogram } = fakeHistogram({ mean: 1e6, max: 1e6, p99: 1e6 });
    const sample = createBunSystemMetricsSampler({
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: elu },
    })();
    expect(metricValue(sample, 'event_loop_utilization')).toBe(0);
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(1); // lag unaffected
  });

  it('defaults to real node:perf_hooks when no perfHooks are injected (Bun supports them)', () => {
    const sample = createBunSystemMetricsSampler()();
    // The default path uses the live perf_hooks; the entries exist and are finite numbers.
    expect(Number.isFinite(metricValue(sample, 'event_loop_lag_ms') ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(metricValue(sample, 'event_loop_utilization') ?? Number.NaN)).toBe(true);
  });

  it('lets caller-supplied node deps override the guarded event-loop reader', () => {
    const { histogram } = fakeHistogram({ mean: 99e6, max: 99e6, p99: 99e6 });
    const sample = createBunSystemMetricsSampler({
      eventLoop: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }),
      perfHooks: { monitorEventLoopDelay: () => histogram, eventLoopUtilization: fakeElu(0) },
    })();
    // The explicit dep wins over the guarded perf_hooks reader (1, not 99).
    expect(metricValue(sample, 'event_loop_lag_ms')).toBe(1);
    expect(metricValue(sample, 'event_loop_lag_max_ms')).toBe(2);
  });
});
