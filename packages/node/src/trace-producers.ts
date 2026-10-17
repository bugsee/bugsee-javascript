import { totalmem } from 'node:os';
import process from 'node:process';
import { getHeapStatistics } from 'node:v8';
import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import {
  createGuardedElu,
  createGuardedEventLoopSource,
  type PerfHooks,
  realPerfHooks,
} from './trackers/guarded-event-loop';
import {
  type ProcessStats,
  type ProcessStatsDeps,
  ProcessStatsTracker,
} from './trackers/process-stats-tracker';
import {
  createAvailableMemoryReader,
  createMemoryLimitReader,
  createV8HeapReader,
} from './trackers/runtime-readers';

// Node `traces.system` producers (mirrors the mobile tracker/producer split): nine producers over ONE shared
// ProcessStatsTracker.

abstract class StatsProducer extends TraceProducerBase {
  #off: (() => void) | undefined;
  constructor(protected readonly tracker: ProcessStatsTracker) {
    super();
  }
  protected abstract publish(stats: ProcessStats): void;
  protected onStart(): void {
    this.#off = this.tracker.on('stats', (s) => this.publish(s)); // subscribing activates the tracker
    this.publish(this.tracker.current()); // baseline
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

class ProcessMemoryProducer extends StatsProducer {
  readonly name = 'process-memory';
  protected publish(s: ProcessStats): void {
    this.emit('process_memory_rss', s.memory.rss);
    this.emit('process_memory_heap_total', s.memory.heapTotal);
    this.emit('process_memory_heap_used', s.memory.heapUsed);
    this.emit('process_memory_external', s.memory.external);
    this.emit('process_memory_array_buffers', s.memory.arrayBuffers);
  }
}

class SystemMemoryProducer extends StatsProducer {
  readonly name = 'system-memory';
  protected publish(s: ProcessStats): void {
    this.emit('ram_system_total', s.systemMemory.total);
    this.emit('ram_system_free', s.systemMemory.free);
  }
}

class CpuProducer extends StatsProducer {
  readonly name = 'cpu';
  protected publish(s: ProcessStats): void {
    this.emit('cpu_usage_user', s.cpu.userDelta);
    this.emit('cpu_usage_system', s.cpu.systemDelta);
    this.emit('cpu_usage_process', s.cpu.processPct);
  }
}

// Omitted, never zeroed, when the runtime cannot measure it.
class EventLoopLagProducer extends StatsProducer {
  readonly name = 'event-loop-lag';
  protected publish(s: ProcessStats): void {
    if (s.eventLoop === undefined) return;
    this.emit('event_loop_lag_ms', s.eventLoop.meanMs);
    this.emit('event_loop_lag_max_ms', s.eventLoop.maxMs);
    this.emit('event_loop_lag_p99_ms', s.eventLoop.p99Ms);
  }
}

class EventLoopUtilizationProducer extends StatsProducer {
  readonly name = 'event-loop-utilization';
  protected publish(s: ProcessStats): void {
    if (s.utilization === undefined) return;
    this.emit('event_loop_utilization', s.utilization);
  }
}

// `ram_js_heap_*` is the CEILING-based view shared with the browser and Android (`total` = the heap limit),
// so it is NOT an alias of `process_memory_heap_*` (committed heap). Only `used` is the same number.
class V8HeapProducer extends StatsProducer {
  readonly name = 'v8-heap';
  protected publish(s: ProcessStats): void {
    const h = s.v8Heap;
    if (h === undefined) return;
    this.emitIfChanged('v8_heap_size_limit', h.limit); // static: held for the provider's refresh
    this.emit('v8_heap_available', h.available);
    this.emit('v8_heap_malloced', h.malloced);
    this.emit('v8_heap_peak_malloced', h.peakMalloced);
    this.emitIfChanged('ram_js_heap_total', h.limit);
    this.emit('ram_js_heap_used', h.used);
    this.emit('ram_js_heap_free', Math.max(h.limit - h.used, 0));
  }
}

class MemoryLimitProducer extends StatsProducer {
  readonly name = 'process-memory-limit';
  protected publish(s: ProcessStats): void {
    if (s.memoryLimit !== undefined) this.emitIfChanged('process_memory_limit', s.memoryLimit);
  }
}

class AvailableMemoryProducer extends StatsProducer {
  readonly name = 'system-memory-available';
  protected publish(s: ProcessStats): void {
    if (s.availableMemory !== undefined) this.emit('ram_system_available', s.availableMemory);
  }
}

class UptimeProducer extends StatsProducer {
  readonly name = 'process-uptime';
  protected publish(s: ProcessStats): void {
    this.emit('process_uptime_s', s.uptimeS);
  }
}

export interface NodeTraceProducerDeps extends ProcessStatsDeps {
  /** perf_hooks primitives for the event-loop metrics (partial on Bun/Deno). Default node:perf_hooks. */
  perfHooks?: PerfHooks;
  /**
   * Does this runtime's `monitorEventLoopDelay` observe a BLOCKED loop? Default `true`. Deno's does not
   * (answers, never throws, never registers a stall), so `@bugsee/deno` passes `false` and the histogram
   * is never even constructed.
   */
  measuresEventLoopDelay?: boolean;
  /**
   * Is `v8.getHeapStatistics()` a real V8 heap with a ceiling? Default `true`. Bun's is JSC-derived (its
   * `heap_size_limit` is not a ceiling, so `limit - used` means nothing, and it costs ~1000x Node per call —
   * measured), so `@bugsee/bun` passes `false` and `v8_heap_*` / `ram_js_heap_*` are omitted.
   */
  measuresV8Heap?: boolean;
  /**
   * Is `process.availableMemory()` comparable to the Node figure? Default `true`. It is not on Bun/Deno:
   * Deno answered 23 GB against Node's 3.4 GB on one macOS host, and on Linux both ignore the container
   * cap (11.2 GB under `docker -m 256m` where Node answers 253 MB). `@bugsee/deno` and `@bugsee/bun`
   * pass `false` and `ram_system_available` is omitted there.
   */
  measuresAvailableMemory?: boolean;
}

export function createNodeSystemTraceProducers(deps: NodeTraceProducerDeps = {}): TraceProducer[] {
  const {
    perfHooks,
    measuresEventLoopDelay = true,
    measuresV8Heap = true,
    measuresAvailableMemory = true,
    ...rest
  } = deps;
  const perf = perfHooks ?? realPerfHooks;
  // `??` / conditional spreads (never a bare `...rest` over defaults): an explicit `undefined` must not
  // clobber a default, and `eventLoop` must be ABSENT (not undefined) when the runtime cannot measure it.
  const eventLoop =
    rest.eventLoop ??
    (measuresEventLoopDelay ? createGuardedEventLoopSource(perf.monitorEventLoopDelay) : undefined);
  const tracker = new ProcessStatsTracker({
    ...rest,
    ...(eventLoop !== undefined ? { eventLoop } : {}),
    eventLoopUtilization: rest.eventLoopUtilization ?? createGuardedElu(perf.eventLoopUtilization),
    // Same rule as `eventLoop`: an injected reader wins, otherwise the default is wired only where the runtime
    // can give a true value; an unwired reader means the field is ABSENT.
    ...optionalReader('v8Heap', rest.v8Heap, measuresV8Heap, () =>
      createV8HeapReader(getHeapStatistics),
    ),
    ...optionalReader('memoryLimit', rest.memoryLimit, true, () =>
      createMemoryLimitReader(process, totalmem),
    ),
    ...optionalReader('availableMemory', rest.availableMemory, measuresAvailableMemory, () =>
      createAvailableMemoryReader(process),
    ),
  });
  return [
    new ProcessMemoryProducer(tracker),
    new SystemMemoryProducer(tracker),
    new CpuProducer(tracker),
    new EventLoopLagProducer(tracker),
    new EventLoopUtilizationProducer(tracker),
    new V8HeapProducer(tracker),
    new MemoryLimitProducer(tracker),
    new AvailableMemoryProducer(tracker),
    new UptimeProducer(tracker),
  ];
}

/** `{ [key]: reader }` for an injected reader, else the default when `enabled`, else nothing. */
function optionalReader<K extends string, R>(
  key: K,
  injected: R | undefined,
  enabled: boolean,
  make: () => R,
): { [P in K]?: R } {
  const reader = injected ?? (enabled ? make() : undefined);
  return (reader !== undefined ? { [key]: reader } : {}) as { [P in K]?: R };
}
