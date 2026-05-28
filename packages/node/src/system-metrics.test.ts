import type { TraceSample } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import { createNodeSystemMetricsSampler, eventLoopLagFromMeanNs } from './system-metrics';

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

describe('createNodeSystemMetricsSampler', () => {
  it('reports process memory (rss/heap/external) from the memory reader', () => {
    const sampler = createNodeSystemMetricsSampler({
      memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4 }),
      cpuUsage: () => ({ user: 0, system: 0 }),
      eventLoopLagMs: () => 0,
    });
    const m = byName(sampler());
    expect(m.get('process_memory_rss')).toBe(1);
    expect(m.get('process_memory_heap_total')).toBe(2);
    expect(m.get('process_memory_heap_used')).toBe(3);
    expect(m.get('process_memory_external')).toBe(4);
  });

  it('reports CPU as a per-sample delta (current minus previous absolute)', () => {
    let cpu = { user: 0, system: 0 };
    const sampler = createNodeSystemMetricsSampler({
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
      cpuUsage: () => cpu,
      eventLoopLagMs: () => 0,
    });
    cpu = { user: 100, system: 50 };
    const first = byName(sampler()); // delta from the {0,0} baseline
    expect(first.get('cpu_usage_user')).toBe(100);
    expect(first.get('cpu_usage_system')).toBe(50);
    cpu = { user: 250, system: 80 };
    const second = byName(sampler()); // delta since the previous sample
    expect(second.get('cpu_usage_user')).toBe(150);
    expect(second.get('cpu_usage_system')).toBe(30);
  });

  it('reports the event-loop lag from the lag reader', () => {
    const sampler = createNodeSystemMetricsSampler({
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
      cpuUsage: () => ({ user: 0, system: 0 }),
      eventLoopLagMs: () => 12.5,
    });
    expect(byName(sampler()).get('event_loop_lag_ms')).toBe(12.5);
  });

  it('defaults to the perf_hooks event-loop lag reader (a finite, non-negative ms)', () => {
    const sampler = createNodeSystemMetricsSampler({
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
      cpuUsage: () => ({ user: 0, system: 0 }),
    });
    const lag = byName(sampler()).get('event_loop_lag_ms') as number;
    expect(typeof lag).toBe('number');
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(lag)).toBe(true);
  });

  it('defaults to the real process readers (all metrics present and numeric)', () => {
    const sampler = createNodeSystemMetricsSampler(); // real process.memoryUsage / cpuUsage / perf_hooks
    const samples = sampler();
    expect(samples.map((s) => s.name)).toEqual([
      'process_memory_rss',
      'process_memory_heap_total',
      'process_memory_heap_used',
      'process_memory_external',
      'cpu_usage_user',
      'cpu_usage_system',
      'event_loop_lag_ms',
    ]);
    for (const sample of samples) {
      expect(typeof sample.value).toBe('number');
    }
  });
});
