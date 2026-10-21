import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import {
  type ProcessEvents,
  type ProcessTracker,
  type ProcessTrackerEnv,
  processTrackerFor,
} from '@bugsee/trackers/node';

// Node `traces.system` producers (mirrors the mobile tracker/producer split): nine producers, each subscribed to ONE
// stage of the shared per-process ProcessTracker (`@bugsee/trackers/node`, the abstraction layer over the runtime's
// process APIs). This file is COMPOSITION only: which stage feeds which trace names, plus the runtime-identity gates
// the platform packages pass through (`measures*`). The tracker owns every runtime read, its lifetime and its
// honesty rules (a stage that cannot answer emits nothing, never a zero).

type Stage = keyof ProcessEvents;

abstract class StageProducer<S extends Stage> extends TraceProducerBase {
  #off: (() => void) | undefined;
  constructor(
    protected readonly tracker: ProcessTracker,
    private readonly stage: S,
  ) {
    super();
  }
  protected abstract publish(payload: ProcessEvents[S]): void;
  protected onStart(): void {
    this.#off = this.tracker.on(this.stage, (p) => this.publish(p)); // subscribing arms the stage
    this.baseline();
  }
  /** The value emitted at start. Most families publish the current reading; windowed ones override (no baseline). */
  protected baseline(): void {
    const current = this.tracker.current(this.stage);
    if (current !== undefined) this.publish(current);
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

class ProcessMemoryProducer extends StageProducer<'memory'> {
  readonly name = 'process-memory';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'memory');
  }
  protected publish(m: ProcessEvents['memory']): void {
    this.emit('process_memory_rss', m.rss);
    this.emit('process_memory_heap_total', m.heapTotal);
    this.emit('process_memory_heap_used', m.heapUsed);
    this.emit('process_memory_external', m.external);
    this.emit('process_memory_array_buffers', m.arrayBuffers);
  }
}

class SystemMemoryProducer extends StageProducer<'systemMemory'> {
  readonly name = 'system-memory';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'systemMemory');
  }
  protected publish(m: ProcessEvents['systemMemory']): void {
    this.emit('ram_system_total', m.total);
    // memory available to new work (Android parity), absent when no source answers
    if (m.free !== undefined) this.emit('ram_system_free', m.free);
  }
}

class CpuProducer extends StageProducer<'cpu'> {
  readonly name = 'cpu';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'cpu');
  }
  // No baseline: no window has elapsed at start, so any value would be invented (a zero-length window has no CPU share).
  protected override baseline(): void {}
  protected publish(c: ProcessEvents['cpu']): void {
    this.emit('cpu_usage_user', c.userDelta);
    this.emit('cpu_usage_system', c.systemDelta);
    if (c.processPct !== undefined) this.emit('cpu_usage_process', c.processPct); // omitted on a zero wall window
  }
}

// Omitted, never zeroed, when the runtime cannot measure it (the tracker emits nothing then). No baseline: a
// window has not elapsed at start, and a restart while the stage stays armed must not re-emit the last window.
class EventLoopLagProducer extends StageProducer<'eventLoop'> {
  readonly name = 'event-loop-lag';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'eventLoop');
  }
  protected override baseline(): void {}
  protected publish(l: ProcessEvents['eventLoop']): void {
    // A field the histogram could not report is absent: omit that trace, never write a zero.
    if (l.meanMs !== undefined) this.emit('event_loop_lag_ms', l.meanMs);
    if (l.maxMs !== undefined) this.emit('event_loop_lag_max_ms', l.maxMs);
    if (l.p99Ms !== undefined) this.emit('event_loop_lag_p99_ms', l.p99Ms);
  }
}

class EventLoopUtilizationProducer extends StageProducer<'utilization'> {
  readonly name = 'event-loop-utilization';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'utilization');
  }
  protected override baseline(): void {}
  protected publish(u: ProcessEvents['utilization']): void {
    this.emit('event_loop_utilization', u.utilization);
  }
}

// `ram_js_heap_*` is the CEILING-based view shared with the browser and Android (`total` = the heap limit),
// so it is NOT an alias of `process_memory_heap_*` (committed heap). Only `used` is the same number.
class V8HeapProducer extends StageProducer<'v8Heap'> {
  readonly name = 'v8-heap';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'v8Heap');
  }
  protected publish(h: ProcessEvents['v8Heap']): void {
    this.emit('v8_heap_size_limit', h.limit);
    this.emit('v8_heap_available', h.available);
    this.emit('v8_heap_malloced', h.malloced);
    this.emit('v8_heap_peak_malloced', h.peakMalloced);
    this.emit('ram_js_heap_total', h.limit);
    this.emit('ram_js_heap_used', h.used);
    this.emit('ram_js_heap_free', Math.max(h.limit - h.used, 0));
  }
}

// Emitted every tick, never held for the provider's refresh: a cap can be lifted at runtime, and a held value
// would then be re-recorded as a stale limit instead of being omitted.
class MemoryLimitProducer extends StageProducer<'memoryLimit'> {
  readonly name = 'process-memory-limit';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'memoryLimit');
  }
  protected publish(m: ProcessEvents['memoryLimit']): void {
    this.emit('process_memory_limit', m.bytes);
  }
}

// Emitted every tick, never held: a quiet interval is a TRUE zero (the observer is running), and a source that
// stops answering must be omitted rather than re-recorded from a held value. No baseline: the interval opens at
// activation, so nothing has been observed yet (a zero would be invented).
class GcProducer extends StageProducer<'gc'> {
  readonly name = 'gc';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'gc');
  }
  protected override baseline(): void {}
  protected publish(g: ProcessEvents['gc']): void {
    this.emit('gc_count', g.count);
    this.emit('gc_pause_ms', g.pauseMs);
    this.emit('gc_pause_max_ms', g.maxPauseMs);
  }
}

class UptimeProducer extends StageProducer<'uptime'> {
  readonly name = 'process-uptime';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'uptime');
  }
  protected publish(u: ProcessEvents['uptime']): void {
    this.emit('process_uptime_s', u.seconds);
  }
}

/**
 * The tracker seams plus the platform GATES (`measuresEventLoopDelay`, `measuresV8Heap`,
 * `measuresGc`; see {@link ProcessTrackerEnv}) — runtime-identity facts the platform packages pass in: Deno gates the
 * event-loop histogram, Bun the V8 heap, both the GC reader (Bun also sets `readsProcMeminfo`).
 */
export interface NodeTraceProducerDeps extends ProcessTrackerEnv {
  onError?: (error: unknown) => void;
}

export function createNodeSystemTraceProducers(deps: NodeTraceProducerDeps = {}): TraceProducer[] {
  const { onError, ...env } = deps;
  // The per-process singleton: a relaunch (or a second producer set) shares it and hands it THIS launch's seams.
  const tracker = processTrackerFor(env, onError);
  return [
    new ProcessMemoryProducer(tracker),
    new SystemMemoryProducer(tracker),
    new CpuProducer(tracker),
    new EventLoopLagProducer(tracker),
    new EventLoopUtilizationProducer(tracker),
    new V8HeapProducer(tracker),
    new MemoryLimitProducer(tracker),
    new GcProducer(tracker),
    new UptimeProducer(tracker),
  ];
}
