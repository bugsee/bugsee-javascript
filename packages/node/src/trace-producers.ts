import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import { TraceName } from '@bugsee/protocol';
import {
  type ProcessEvents,
  type ProcessTracker,
  type ProcessTrackerEnv,
  processTrackerFor,
} from '@bugsee/trackers/node';

// Node `traces.system` producers (mirrors the mobile tracker/producer split): seven producers, each subscribed to ONE
// stage of the shared per-process ProcessTracker (`@bugsee/trackers/node`, the abstraction layer over the runtime's
// process APIs). This file is COMPOSITION only: which stage feeds which trace names, plus the runtime-identity gates
// the platform packages pass through (`measures*`). GC is deliberately NOT here: it is the `gc` system event (`system-events.ts`), not a trace. The tracker owns every runtime read, its lifetime and its
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
    this.#off = this.tracker.on(this.stage, (p) => this.poll(() => this.publish(p))); // subscribing arms the stage
    this.baseline();
  }
  /** The value emitted at start. Most families publish the current reading; windowed ones override (no baseline). */
  protected baseline(): void {
    const current = this.tracker.current(this.stage);
    if (current !== undefined) this.poll(() => this.publish(current));
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
    this.emit(TraceName.PROCESS_MEMORY_RSS, m.rss);
    this.emit(TraceName.PROCESS_MEMORY_HEAP_TOTAL, m.heapTotal);
    this.emit(TraceName.PROCESS_MEMORY_HEAP_USED, m.heapUsed);
    this.emit(TraceName.PROCESS_MEMORY_EXTERNAL, m.external);
    this.emit(TraceName.PROCESS_MEMORY_ARRAY_BUFFERS, m.arrayBuffers);
  }
}

class SystemMemoryProducer extends StageProducer<'systemMemory'> {
  readonly name = 'system-memory';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'systemMemory');
  }
  protected publish(m: ProcessEvents['systemMemory']): void {
    this.emit(TraceName.RAM_SYSTEM_TOTAL, m.total);
    // memory available to new work (Android parity), absent when no source answers
    if (m.free !== undefined) this.emit(TraceName.RAM_SYSTEM_FREE, m.free);
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
    this.emit(TraceName.CPU_USAGE_USER, c.userDelta);
    this.emit(TraceName.CPU_USAGE_SYSTEM, c.systemDelta);
    if (c.processPct !== undefined) this.emit(TraceName.CPU_USAGE_PROCESS, c.processPct); // omitted on a zero wall window
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
    if (l.meanMs !== undefined) this.emit(TraceName.EVENT_LOOP_LAG_MS, l.meanMs);
    if (l.maxMs !== undefined) this.emit(TraceName.EVENT_LOOP_LAG_MAX_MS, l.maxMs);
    if (l.p99Ms !== undefined) this.emit(TraceName.EVENT_LOOP_LAG_P99_MS, l.p99Ms);
  }
}

class EventLoopUtilizationProducer extends StageProducer<'utilization'> {
  readonly name = 'event-loop-utilization';
  constructor(tracker: ProcessTracker) {
    super(tracker, 'utilization');
  }
  protected override baseline(): void {}
  protected publish(u: ProcessEvents['utilization']): void {
    this.emit(TraceName.EVENT_LOOP_UTILIZATION, u.utilizationPercent); // percent 0-100, one decimal
  }
}

/** The name of the producer that writes `ram_js_heap_*` (a host that must know who writes the heap, like Electron main, looks for it). */
export const V8_HEAP_PRODUCER_NAME = 'v8-heap';

// `ram_js_heap_*` is the CEILING-based view shared with the browser and Android (`total` = the heap limit),
// so it is NOT an alias of `process_memory_heap_*` (committed heap). Only `used` is the same number.
class V8HeapProducer extends StageProducer<'v8Heap'> {
  readonly name = V8_HEAP_PRODUCER_NAME;
  constructor(tracker: ProcessTracker) {
    super(tracker, 'v8Heap');
  }
  protected publish(h: ProcessEvents['v8Heap']): void {
    this.emit(TraceName.V8_HEAP_SIZE_LIMIT, h.limit);
    this.emit(TraceName.V8_HEAP_AVAILABLE, h.available);
    this.emit(TraceName.V8_HEAP_MALLOCED, h.malloced);
    this.emit(TraceName.V8_HEAP_PEAK_MALLOCED, h.peakMalloced);
    this.emit(TraceName.RAM_JS_HEAP_TOTAL, h.limit);
    this.emit(TraceName.RAM_JS_HEAP_USED, h.used);
    this.emit(TraceName.RAM_JS_HEAP_FREE, Math.max(h.limit - h.used, 0));
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
    this.emit(TraceName.PROCESS_MEMORY_LIMIT, m.bytes);
  }
}

/**
 * The tracker seams plus the platform GATES (`measuresEventLoopDelay`, `measuresV8Heap`, `measuresConstrainedMemory`,
 * `measuresGc` (gates the `gc` EVENT source, not a trace); see {@link ProcessTrackerEnv}) — runtime-identity facts the platform packages pass in: Deno gates the
 * event-loop histogram, Bun the V8 heap, Bun and Deno the cgroup cap off Linux, both the GC reader (Bun also sets `readsProcMeminfo`).
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
  ];
}
