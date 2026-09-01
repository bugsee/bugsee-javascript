import { cpus, freemem, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { TraceSample } from '@bugsee/capture';

// Node system-metrics sampler for @bugsee/capture's systemTracesProvider (Android traces.system parity,
// Node subset). Returns the current process metrics as TraceSamples each call; the provider routes them
// to `traces.system`. Captures:
//  - process memory (rss / heapTotal / heapUsed / external / arrayBuffers),
//  - system memory (ram_system_total / ram_system_free — Android parity),
//  - CPU: per-sample user/system deltas (µs) AND a normalized cpu_usage_process % (over wall-time,
//    across cpu count — Android cpu_usage_process parity),
//  - event loop: mean / max / p99 lag (ms) + utilization (0..1).
// Mobile-only traces (battery/orientation/fps/thermal/displays) have no Node analog and are not sampled.
// All readers are injectable for testing.

type MemoryReader = () => {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};
type CpuReader = () => { user: number; system: number };
type SystemMemoryReader = () => { total: number; free: number };
type EventLoopReader = () => { meanMs: number; maxMs: number; p99Ms: number };

export interface NodeSystemMetricsDeps {
  /** Reads process memory (bytes). Default process.memoryUsage. */
  memoryUsage?: MemoryReader;
  /** Reads cumulative process CPU time (µs). Default process.cpuUsage. The sampler reports deltas. */
  cpuUsage?: CpuReader;
  /** Reads system memory (bytes). Default os.totalmem / os.freemem. */
  systemMemory?: SystemMemoryReader;
  /** Reads event-loop lag mean/max/p99 (ms) since the previous sample. Default a perf_hooks histogram. */
  eventLoop?: EventLoopReader;
  /**
   * Reads event-loop utilization (0..1) over the interval, or `undefined` when the runtime cannot
   * answer. Default perf_hooks eventLoopUtilization. See {@link eluUnavailable} for why `undefined`
   * has to be representable at all.
   */
  eventLoopUtilization?: () => number | undefined;
  /** Logical CPU count for the cpu% normalization. Default os.cpus().length. */
  cpuCount?: () => number;
  /** Monotonic wall clock (ms) for the cpu% window. Default perf_hooks performance.now. */
  monotonicNowMs?: () => number;
}

/** Convert a perf_hooks event-loop delay (ns) to ms; 0 when non-finite (e.g. NaN before the first tick). */
export const eventLoopLagFromMeanNs = (ns: number): number => (Number.isFinite(ns) ? ns / 1e6 : 0);

// Default event-loop reader: a perf_hooks delay histogram, read as mean/max/p99 (ms) and reset each sample.
const createEventLoopReader = (): EventLoopReader => {
  const histogram = monitorEventLoopDelay();
  histogram.enable();
  return () => {
    const out = {
      meanMs: eventLoopLagFromMeanNs(histogram.mean),
      maxMs: eventLoopLagFromMeanNs(histogram.max),
      p99Ms: eventLoopLagFromMeanNs(histogram.percentile(99)),
    };
    histogram.reset();
    return out;
  };
};

/**
 * Does this delta mean "the runtime does not implement ELU" rather than "the loop was idle"?
 *
 * `performance.eventLoopUtilization()` exists on Bun and Deno and does not throw — it simply answers
 * `{idle:0, active:0, utilization:0}` for ever. Measured 2026-09-01, after a 120ms CPU burn and a 60ms
 * sleep: node reported `{idle:61.0, active:0.118}` while Bun and Deno both reported zeros. A throw-guard
 * cannot see that, so the SDK shipped a confident 0% utilization — which reads, to whoever opens the
 * report, exactly like a perfectly healthy idle process.
 *
 * `idle` is the discriminator, not `utilization`: on any honest implementation idle accumulates
 * wall-clock time between samples, so at a 1s cadence it cannot be zero. A process that genuinely did
 * nothing reports utilization 0 with a non-zero idle, and that reading is true and worth keeping.
 */
export const eluUnavailable = (delta: { idle?: number; active?: number }): boolean =>
  delta.idle === 0 && delta.active === 0;

// Default event-loop utilization reader: the delta utilization (0..1) between successive samples.
const createEluReader = (): (() => number | undefined) => {
  let last = performance.eventLoopUtilization();
  return () => {
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, last);
    last = current;
    return eluUnavailable(delta) ? undefined : delta.utilization;
  };
};

export function createNodeSystemMetricsSampler(
  deps: NodeSystemMetricsDeps = {},
): () => TraceSample[] {
  const memoryUsage: MemoryReader = deps.memoryUsage ?? (() => process.memoryUsage());
  const cpuUsage: CpuReader = deps.cpuUsage ?? (() => process.cpuUsage());
  const systemMemory: SystemMemoryReader =
    deps.systemMemory ?? (() => ({ total: totalmem(), free: freemem() }));
  const eventLoop: EventLoopReader = deps.eventLoop ?? createEventLoopReader();
  const eventLoopUtilization = deps.eventLoopUtilization ?? createEluReader();
  const cpuCount = deps.cpuCount ?? (() => cpus().length);
  const monotonicNowMs = deps.monotonicNowMs ?? (() => performance.now());

  let lastCpu = cpuUsage();
  let lastWallMs = monotonicNowMs();

  return () => {
    const memory = memoryUsage();
    const sys = systemMemory();
    const cpu = cpuUsage();
    const nowMs = monotonicNowMs();
    const userDelta = cpu.user - lastCpu.user;
    const systemDelta = cpu.system - lastCpu.system;
    const wallMsDelta = nowMs - lastWallMs;
    lastCpu = cpu;
    lastWallMs = nowMs;
    // Normalized process CPU %: busy-µs / wall-µs / cores * 100. Guard the zero-window first sample.
    const cores = cpuCount();
    const cpuProcessPct =
      wallMsDelta > 0 ? ((userDelta + systemDelta) / (wallMsDelta * 1000) / cores) * 100 : 0;
    const loop = eventLoop();
    const utilization = eventLoopUtilization();
    return [
      { name: 'process_memory_rss', value: memory.rss },
      { name: 'process_memory_heap_total', value: memory.heapTotal },
      { name: 'process_memory_heap_used', value: memory.heapUsed },
      { name: 'process_memory_external', value: memory.external },
      { name: 'process_memory_array_buffers', value: memory.arrayBuffers },
      { name: 'ram_system_total', value: sys.total },
      { name: 'ram_system_free', value: sys.free },
      { name: 'cpu_usage_user', value: userDelta },
      { name: 'cpu_usage_system', value: systemDelta },
      { name: 'cpu_usage_process', value: cpuProcessPct },
      { name: 'event_loop_lag_ms', value: loop.meanMs },
      { name: 'event_loop_lag_max_ms', value: loop.maxMs },
      { name: 'event_loop_lag_p99_ms', value: loop.p99Ms },
      // OMITTED, never zeroed, when the runtime cannot answer: a metric that is absent prompts a
      // question, while a fabricated 0 answers one wrongly.
      ...(utilization === undefined
        ? []
        : [{ name: 'event_loop_utilization', value: utilization }]),
    ];
  };
}
