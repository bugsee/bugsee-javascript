import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { TraceSample } from '@bugsee/capture';

// Node system-metrics sampler for @bugsee/capture's systemTracesProvider (Android traces.system parity,
// Node subset). Returns the current process metrics as TraceSamples each call; the provider routes them
// to `traces.system`. Captures process memory (rss/heap/external), CPU (per-sample delta in µs), and
// event-loop lag (mean ms since the previous sample). Mobile-only traces (battery/orientation/fps/
// displays) have no Node analog and are not sampled. All readers are injectable for testing.

type MemoryReader = () => { rss: number; heapTotal: number; heapUsed: number; external: number };
type CpuReader = () => { user: number; system: number };

export interface NodeSystemMetricsDeps {
  /** Reads process memory (bytes). Default process.memoryUsage. */
  memoryUsage?: MemoryReader;
  /** Reads cumulative process CPU time (µs). Default process.cpuUsage. The sampler reports per-sample deltas. */
  cpuUsage?: CpuReader;
  /** Reads the event-loop lag (ms) since the previous sample. Default a perf_hooks delay histogram. */
  eventLoopLagMs?: () => number;
}

/** Convert a perf_hooks mean event-loop delay (ns) to ms; 0 before the first tick (mean is NaN). */
export const eventLoopLagFromMeanNs = (meanNs: number): number =>
  Number.isFinite(meanNs) ? meanNs / 1e6 : 0;

// Default event-loop lag: a perf_hooks delay histogram, read as the mean (ms) and reset each sample.
const createEventLoopLagReader = (): (() => number) => {
  const histogram = monitorEventLoopDelay();
  histogram.enable();
  return () => {
    const meanNs = histogram.mean;
    histogram.reset();
    return eventLoopLagFromMeanNs(meanNs);
  };
};

export function createNodeSystemMetricsSampler(
  deps: NodeSystemMetricsDeps = {},
): () => TraceSample[] {
  const memoryUsage: MemoryReader = deps.memoryUsage ?? (() => process.memoryUsage());
  const cpuUsage: CpuReader = deps.cpuUsage ?? (() => process.cpuUsage());
  const eventLoopLagMs = deps.eventLoopLagMs ?? createEventLoopLagReader();
  let lastCpu = cpuUsage();

  return () => {
    const memory = memoryUsage();
    const cpu = cpuUsage();
    const userDelta = cpu.user - lastCpu.user;
    const systemDelta = cpu.system - lastCpu.system;
    lastCpu = cpu;
    return [
      { name: 'process_memory_rss', value: memory.rss },
      { name: 'process_memory_heap_total', value: memory.heapTotal },
      { name: 'process_memory_heap_used', value: memory.heapUsed },
      { name: 'process_memory_external', value: memory.external },
      { name: 'cpu_usage_user', value: userDelta },
      { name: 'cpu_usage_system', value: systemDelta },
      { name: 'event_loop_lag_ms', value: eventLoopLagMs() },
    ];
  };
}
