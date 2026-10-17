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

// Node `traces.system` producers (mirrors the mobile tracker/producer split): five producers over ONE shared
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

export interface NodeTraceProducerDeps extends ProcessStatsDeps {
  /** perf_hooks primitives for the event-loop metrics (partial on Bun/Deno). Default node:perf_hooks. */
  perfHooks?: PerfHooks;
  /**
   * Does this runtime's `monitorEventLoopDelay` observe a BLOCKED loop? Default `true`. Deno's does not
   * (answers, never throws, never registers a stall), so `@bugsee/deno` passes `false` and the histogram
   * is never even constructed.
   */
  measuresEventLoopDelay?: boolean;
}

export function createNodeSystemTraceProducers(deps: NodeTraceProducerDeps = {}): TraceProducer[] {
  const { perfHooks, measuresEventLoopDelay = true, ...rest } = deps;
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
  });
  return [
    new ProcessMemoryProducer(tracker),
    new SystemMemoryProducer(tracker),
    new CpuProducer(tracker),
    new EventLoopLagProducer(tracker),
    new EventLoopUtilizationProducer(tracker),
  ];
}
