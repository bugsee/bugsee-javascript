import type { TraceSample } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import {
  createNodeSystemMetricsSampler,
  eventLoopLagFromMeanNs,
  type NodeSystemMetricsDeps,
} from './system-metrics';

describe('eventLoopLagFromMeanNs', () => {
  it('converts a finite mean (ns) to ms', () => {
    expect(eventLoopLagFromMeanNs(1_500_000)).toBe(1.5);
  });
  it('returns 0 for a non-finite mean (NaN before the first tick)', () => {
    expect(eventLoopLagFromMeanNs(Number.NaN)).toBe(0);
    expect(eventLoopLagFromMeanNs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

const byName = (samples: TraceSample[]) => new Map(samples.map((s) => [s.name, s.value]));

// Fully-injected deps so every metric is deterministic; individual tests override what they assert.
const deps = (over: Partial<NodeSystemMetricsDeps> = {}): NodeSystemMetricsDeps => ({
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  systemMemory: () => ({ total: 0, free: 0 }),
  eventLoop: () => ({ meanMs: 0, maxMs: 0, p99Ms: 0 }),
  eventLoopUtilization: () => 0,
  cpuCount: () => 1,
  monotonicNowMs: () => 0,
  ...over,
});

describe('createNodeSystemMetricsSampler', () => {
  it('reports process memory incl. arrayBuffers from the memory reader', () => {
    const m = byName(
      createNodeSystemMetricsSampler(
        deps({
          memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 }),
        }),
      )(),
    );
    expect(m.get('process_memory_rss')).toBe(1);
    expect(m.get('process_memory_heap_total')).toBe(2);
    expect(m.get('process_memory_heap_used')).toBe(3);
    expect(m.get('process_memory_external')).toBe(4);
    expect(m.get('process_memory_array_buffers')).toBe(5);
  });

  it('reports system total/free memory (Android ram_system_total/free parity)', () => {
    const m = byName(
      createNodeSystemMetricsSampler(deps({ systemMemory: () => ({ total: 800, free: 300 }) }))(),
    );
    expect(m.get('ram_system_total')).toBe(800);
    expect(m.get('ram_system_free')).toBe(300);
  });

  it('reports CPU user/system as per-sample deltas', () => {
    let cpu = { user: 0, system: 0 };
    const sampler = createNodeSystemMetricsSampler(deps({ cpuUsage: () => cpu }));
    cpu = { user: 100, system: 50 };
    const first = byName(sampler());
    expect(first.get('cpu_usage_user')).toBe(100);
    expect(first.get('cpu_usage_system')).toBe(50);
    cpu = { user: 250, system: 80 };
    const second = byName(sampler());
    expect(second.get('cpu_usage_user')).toBe(150);
    expect(second.get('cpu_usage_system')).toBe(30);
  });

  it('reports normalized cpu_usage_process % over wall-time across cpu count', () => {
    let cpu = { user: 0, system: 0 };
    let now = 0;
    const sampler = createNodeSystemMetricsSampler(
      deps({ cpuUsage: () => cpu, monotonicNowMs: () => now, cpuCount: () => 2 }),
    );
    // 200_000 µs of CPU over a 1000 ms (1_000_000 µs) wall window, across 2 cores → 10%.
    cpu = { user: 150_000, system: 50_000 };
    now = 1000;
    expect(byName(sampler()).get('cpu_usage_process')).toBe(10);
  });

  it('reports 0% process CPU when no wall-time has elapsed (no divide-by-zero)', () => {
    const sampler = createNodeSystemMetricsSampler(
      deps({
        cpuUsage: () => ({ user: 999, system: 999 }),
        monotonicNowMs: () => 0,
        cpuCount: () => 4,
      }),
    );
    expect(byName(sampler()).get('cpu_usage_process')).toBe(0);
  });

  it('reports event-loop mean/max/p99 lag from the event-loop reader', () => {
    const m = byName(
      createNodeSystemMetricsSampler(
        deps({ eventLoop: () => ({ meanMs: 1.5, maxMs: 40, p99Ms: 12 }) }),
      )(),
    );
    expect(m.get('event_loop_lag_ms')).toBe(1.5);
    expect(m.get('event_loop_lag_max_ms')).toBe(40);
    expect(m.get('event_loop_lag_p99_ms')).toBe(12);
  });

  it('reports event-loop utilization (0..1) from its reader', () => {
    expect(
      byName(createNodeSystemMetricsSampler(deps({ eventLoopUtilization: () => 0.42 }))()).get(
        'event_loop_utilization',
      ),
    ).toBe(0.42);
  });

  it('defaults to the perf_hooks event-loop reader (finite, non-negative ms)', () => {
    const sampler = createNodeSystemMetricsSampler(); // real readers
    const m = byName(sampler());
    for (const key of ['event_loop_lag_ms', 'event_loop_lag_max_ms', 'event_loop_lag_p99_ms']) {
      const v = m.get(key) as number;
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('defaults to the real process/os readers (all metrics present and numeric)', () => {
    const samples = createNodeSystemMetricsSampler()();
    expect(samples.map((s) => s.name)).toEqual([
      'process_memory_rss',
      'process_memory_heap_total',
      'process_memory_heap_used',
      'process_memory_external',
      'process_memory_array_buffers',
      'ram_system_total',
      'ram_system_free',
      'cpu_usage_user',
      'cpu_usage_system',
      'cpu_usage_process',
      'event_loop_lag_ms',
      'event_loop_lag_max_ms',
      'event_loop_lag_p99_ms',
      'event_loop_utilization',
    ]);
    for (const sample of samples) {
      expect(typeof sample.value).toBe('number');
      expect(Number.isFinite(sample.value)).toBe(true);
    }
  });
});
