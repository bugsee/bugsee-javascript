import { cpus, freemem, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import nodeProcess from 'node:process';
import { getHeapStatistics } from 'node:v8';
import { InterceptorBase } from '../interceptor-base';
import { createTrackerRegistry } from '../tracker-registry';
import { createGcSource, type GcInterval, type GcSource, type ObserverCtor } from './gc-observer';
import {
  createGuardedElu,
  createGuardedEventLoopSource,
  type EventLoopSource,
  type PerfHooks,
  realPerfHooks,
} from './guarded-event-loop';
import {
  createAvailableMemoryReader,
  createMemoryLimitReader,
  createV8HeapReader,
  type V8HeapStats,
} from './runtime-readers';

// Node/Bun/Deno PROCESS tracker (domain tracker, design §15.2/§15.3; Android reference: BugseeTrackerProcess). It
// owns everything the runtime can say about its own process, as NINE independent stages:
//
//   memory          process.memoryUsage()                          -> { rss, heapTotal, heapUsed, external, arrayBuffers }
//   systemMemory    os.totalmem()/freemem()                        -> { total, free }
//   cpu             process.cpuUsage() deltas over the wall window -> { userDelta, systemDelta, processPct? }
//   eventLoop       monitorEventLoopDelay histogram (guarded)      -> { meanMs?, maxMs?, p99Ms? }
//   utilization     performance.eventLoopUtilization() (guarded)   -> { utilization }
//   gc              PerformanceObserver('gc') interval             -> { count, pauseMs, maxPauseMs }
//   v8Heap          v8.getHeapStatistics()                         -> { limit, used, available, malloced, peakMalloced }
//   memoryLimit     process.constrainedMemory() (a real cap only)  -> { bytes }
//   availableMemory process.availableMemory()                      -> { bytes }
//
// PER-STAGE ACTIVATION. Nothing runs at construction. ONE shared sampling timer exists only while some stage has a
// listener (`listenerCount`, re-evaluated after every listener mutation via `onListenersChanged`; an `onAny` listener
// counts for every stage), and each stage's own machinery exists only while THAT stage is wanted: the GC observer
// only for `gc`, the histogram for `eventLoop`, the ELU baseline for `utilization`, the CPU baseline for `cpu`.
// `start()`/`stop()` (InterceptorBase) therefore do nothing here. Every tick reads each armed stage on its own and
// emits it; a stage whose read throws is reported and drops ONLY itself for that tick.
//
// ABSENCE IS NEVER ZERO. A stage whose runtime cannot answer emits nothing: ELU on Bun/Deno (flat idle/active zeros),
// the event-loop histogram when it has no sample yet or when the platform gated it off (Deno's never sees a blocked
// loop), the GC observer where it is blind (Bun/Deno) or refused, the heap/limit/available-memory readers when their
// numbers are not true. The platform GATES (`measures*`) are runtime-identity facts the composition root passes in;
// the tracker only honours them. An injected source/reader always wins over its gate.
//
// SINGLETON per key object (see `processTrackerFor`: the `process` object by default). SEAMS MERGE, NEVER DROP: the
// tracker outlives launches, so a later launch that omits `scheduler`/`onError`/a reader KEEPS the previous launch's
// (it can replace a seam, never shed one). Merely BUILDING a producer set (`createNodeSystemTraceProducers`) rebinds
// the shared tracker, so a Bun/Deno default set built before `...options` in their launch.ts already hands its seams over.
// Tests that inject fakes must use a private `key` or call `resetProcessTracker()`. RETENTION rule — what survives
// a stage's last unsubscribe: ONLY the resolved seams, and the "this runtime refused" memory inside the guarded
// sources (a refusing histogram/observer is not hammered again until a rebind swaps the seams). Everything windowed
// starts FRESH on the next subscription: the CPU baseline, the ELU baseline, the last-emitted samples
// (`current()` of a windowed stage), the histogram and the GC interval — a stale window would be a lie. Every timer
// callback is guarded by the run that armed it, so a timer whose clear failed can never emit.
//
// FAILURE. A source that fails to start is reported and the stage is left unarmed (never half-armed); it is retried
// on the next listener change or rebind. A timer that cannot be armed unwinds every stage armed for it.

export type { GcInterval, GcSource } from './gc-observer';
export type { EventLoopSource } from './guarded-event-loop';

export interface ProcessMemory {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}
export interface ProcessEvents {
  memory: ProcessMemory;
  systemMemory: { total: number; free: number };
  /** Deltas since the previous tick (µs), and the process's share of all cores (%) over that window (`processPct` is omitted when the window has no positive length). */
  cpu: { userDelta: number; systemDelta: number; processPct?: number };
  eventLoop: { meanMs?: number; maxMs?: number; p99Ms?: number };
  /** Event-loop utilization over the previous tick, 0..1. */
  utilization: { utilization: number };
  /** GC activity since the previous tick (a quiet interval is a TRUE zero: the observer is running). */
  gc: GcInterval;
  v8Heap: V8HeapStats;
  memoryLimit: { bytes: number };
  availableMemory: { bytes: number };
}
type Stage = keyof ProcessEvents;
// Read order of a tick. GC is last: its read drains the interval, so nothing after it may fail the tick.
const STAGES: readonly Stage[] = [
  'memory',
  'systemMemory',
  'cpu',
  'eventLoop',
  'utilization',
  'v8Heap',
  'memoryLimit',
  'availableMemory',
  'gc',
];
/** Stages whose reading is a window since the previous read: they cannot be re-read on demand. */
const WINDOWED: ReadonlySet<Stage> = new Set<Stage>(['cpu', 'eventLoop', 'utilization', 'gc']);

export interface ProcessTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** What the tracker needs from a launch. Every member is optional; an absent one falls back to the runtime default. */
export interface ProcessEnv {
  memoryUsage?: () => ProcessMemory;
  cpuUsage?: () => { user: number; system: number };
  systemMemory?: () => { total: number; free: number };
  cpuCount?: () => number;
  monotonicNowMs?: () => number;
  /** Overrides the guarded histogram source (and its gate). */
  eventLoop?: EventLoopSource;
  /** Overrides the GC observer source (and its gate). */
  gc?: GcSource;
  /** ELU delta 0..1 per call, or undefined when unavailable. Overrides the guarded ELU reader. */
  eventLoopUtilization?: () => number | undefined;
  /** Each reader answers undefined when the runtime cannot give a true value. Override their defaults and gates. */
  v8Heap?: () => V8HeapStats | undefined;
  memoryLimit?: () => number | undefined;
  availableMemory?: () => number | undefined;
  /** perf_hooks primitives for the event-loop metrics (partial on Bun/Deno). Default node:perf_hooks. */
  perfHooks?: PerfHooks;
  /** Test seam for the GC observer constructor. Default `node:perf_hooks`. */
  performanceObserver?: ObserverCtor;
  /**
   * Does this runtime's `monitorEventLoopDelay` observe a BLOCKED loop? Default `true`. Deno's does not (answers,
   * never throws, never registers a stall), so `@bugsee/deno` passes `false` and the histogram is never constructed.
   */
  measuresEventLoopDelay?: boolean;
  /**
   * Is `v8.getHeapStatistics()` a real V8 heap with a ceiling? Default `true`. Bun's is JSC-derived (not a ceiling,
   * and ~1000x Node's cost per call), so `@bugsee/bun` passes `false`.
   */
  measuresV8Heap?: boolean;
  /** Is `process.availableMemory()` comparable to the Node figure? Default `true`; not on Bun/Deno. */
  measuresAvailableMemory?: boolean;
  /** Does `PerformanceObserver({entryTypes:['gc']})` see collections? Default `true`; blind on Bun/Deno. */
  measuresGc?: boolean;
  /** Drives the shared sampling timer; default the global timers, unref'd so the tracker never holds a process alive. */
  scheduler?: ProcessTimers;
  /** Sampling period in ms (default 1000). */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;

const defaultScheduler: ProcessTimers = {
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const SEAM_KEYS = [
  'memoryUsage',
  'cpuUsage',
  'systemMemory',
  'cpuCount',
  'monotonicNowMs',
  'eventLoop',
  'gc',
  'eventLoopUtilization',
  'v8Heap',
  'memoryLimit',
  'availableMemory',
  'perfHooks',
  'performanceObserver',
  'measuresEventLoopDelay',
  'measuresV8Heap',
  'measuresAvailableMemory',
  'measuresGc',
  'scheduler',
  'intervalMs',
] as const satisfies readonly (keyof ProcessEnv)[];

/** One armed stage. `read` may throw; `stop` is called once on teardown. */
interface StageRun {
  read(): unknown;
  stop(): void;
}

/** The sources/readers an env resolves to; built lazily and kept until the seams are swapped. */
interface Resolved {
  eventLoop: EventLoopSource | undefined;
  gc: GcSource | undefined;
  v8Heap: (() => V8HeapStats | undefined) | undefined;
  memoryLimit: () => number | undefined;
  availableMemory: (() => number | undefined) | undefined;
}

const NOOP_RUN: StageRun = { read: () => undefined, stop: () => {} };

export class ProcessTracker extends InterceptorBase<ProcessEvents> {
  readonly name = 'node-process';
  #env: ProcessEnv;
  #resolved: Resolved | undefined;
  /** Armed stages (and their teardown). */
  readonly #armed = new Map<Stage, StageRun>();
  /** The last emitted/seeded sample of each WINDOWED stage, for the current run only. */
  readonly #last = new Map<Stage, unknown>();
  #timer: { handle: unknown; scheduler: ProcessTimers } | null = null;
  /** Bumped whenever the timer is torn down: a callback of an older run never emits. */
  #gen = 0;
  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => void) | undefined };

  constructor(env: ProcessEnv = {}, onError?: (error: unknown) => void) {
    const report = { fn: onError };
    // A throwing reporter must not escape into the emitter's dispatch (which runs inside the host's timers).
    super((error) => {
      try {
        report.fn?.(error);
      } catch {
        /* the reporter itself failed */
      }
    });
    this.#report = report;
    this.#env = env;
  }

  /**
   * Hand the latest launch's seams to this shared tracker. A defined `onError` replaces the reporter (undefined keeps
   * it). Every defined seam REPLACES ours; an undefined one never clobbers an earlier one (merge, never drop). When a
   * seam actually changed, every armed stage is first torn down with the seams it was ARMED with (the timer is
   * cleared on the scheduler that armed it), then the merged seams are swapped in and the stages that still have
   * listeners start again against them (fresh baselines). An unchanged relaunch restarts nothing.
   */
  rebind(env: ProcessEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    const merged: Record<string, unknown> = {};
    let changed = false;
    for (const key of SEAM_KEYS) {
      const next = env[key] ?? this.#env[key];
      if (next !== undefined) merged[key] = next;
      if (next !== this.#env[key]) changed = true;
    }
    if (!changed) return;
    this.#stopAll(); // OLD seams
    this.#env = merged as ProcessEnv;
    this.#resolved = undefined;
    this.#sync();
  }

  /**
   * The latest reading of `stage`. Stateless stages are read LIVE (guarded: undefined when the runtime cannot answer
   * or the read threw, which is reported). A WINDOWED stage (cpu, eventLoop, utilization, gc) cannot be re-read
   * without consuming its window, so it answers the last sample of the current run: undefined until the first
   * tick (a baseline would be a made-up reading: a zero-length window has no CPU share to report), and undefined
   * while the stage is not armed.
   */
  current<S extends Stage>(stage: S): ProcessEvents[S] | undefined {
    if (WINDOWED.has(stage)) {
      const run = this.#armed.get(stage);
      return run === undefined
        ? undefined
        : (this.#last.get(stage) as ProcessEvents[S] | undefined);
    }
    try {
      const value = this.#makeRun(stage).read() as ProcessEvents[S] | undefined;
      return value === undefined ? undefined : { ...value };
    } catch (error) {
      this.#onError(error);
      return undefined;
    }
  }

  /** Test/teardown: drop EVERY listener (which releases every stage and the timer). */
  reset(): void {
    this.removeAllListeners();
  }

  // Activation is per stage (onListenersChanged); the whole-tracker hook has nothing to do.
  protected onActivate(): void {}

  protected override onListenersChanged(): void {
    this.#sync();
  }

  #onError(error: unknown): void {
    try {
      this.#report.fn?.(error);
    } catch {
      /* the reporter itself failed */
    }
  }

  #sync(): void {
    for (const stage of STAGES) {
      if (this.listenerCount(stage) === 0) this.#stopStage(stage);
      else if (!this.#armed.has(stage)) this.#startStage(stage);
    }
    this.#syncTimer();
  }

  #startStage(stage: Stage): void {
    try {
      const run = this.#makeRun(stage);
      this.#armed.set(stage, run);
    } catch (error) {
      this.#onError(error); // left unarmed: retried on the next listener change / rebind
    }
  }

  #stopStage(stage: Stage): void {
    const run = this.#armed.get(stage);
    this.#armed.delete(stage);
    this.#last.delete(stage);
    if (run === undefined) return;
    try {
      run.stop();
    } catch (error) {
      this.#onError(error); // one failing stop must not strand another stage
    }
  }

  #stopAll(): void {
    for (const stage of [...this.#armed.keys()]) this.#stopStage(stage);
    this.#clearTimer();
  }

  #syncTimer(): void {
    if (this.#armed.size === 0) {
      this.#clearTimer();
      return;
    }
    if (this.#timer !== null) return;
    const scheduler = this.#env.scheduler ?? defaultScheduler;
    const gen = ++this.#gen;
    try {
      const handle = scheduler.setInterval(() => {
        if (gen === this.#gen) this.#tick();
      }, this.#env.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.#timer = { handle, scheduler };
    } catch (error) {
      this.#gen += 1;
      this.#onError(error);
      // Nothing would ever read these stages: do not leave an observer/histogram running for them.
      this.#stopAll();
    }
  }

  #clearTimer(): void {
    const timer = this.#timer;
    this.#timer = null;
    this.#gen += 1;
    if (timer === null) return;
    try {
      timer.scheduler.clearInterval(timer.handle);
    } catch (error) {
      this.#onError(error);
    }
  }

  #tick(): void {
    const gen = this.#gen;
    for (const stage of [...this.#armed.keys()]) {
      if (gen !== this.#gen) return; // a listener tore this run down (or rebound the seams) mid-tick
      const run = this.#armed.get(stage); // a listener may have removed it mid-tick
      if (run === undefined) continue;
      let value: unknown;
      try {
        value = run.read();
      } catch (error) {
        this.#onError(error);
        continue;
      }
      if (value === undefined) continue; // absence, never zero
      if (WINDOWED.has(stage)) this.#last.set(stage, value);
      // Emitted payloads are copies: a subscriber cannot mutate the retained sample.
      this.emit(stage, { ...(value as object) } as never);
    }
  }

  #resolve(): Resolved {
    if (this.#resolved !== undefined) return this.#resolved;
    const env = this.#env;
    const perf = env.perfHooks ?? realPerfHooks;
    // `??` / explicit gates (never a spread over defaults): an injected source wins; otherwise the default is wired
    // only where the runtime can give a true value, and an unwired source means the stage is ABSENT.
    const resolved: Resolved = {
      eventLoop:
        env.eventLoop ??
        (env.measuresEventLoopDelay !== false
          ? createGuardedEventLoopSource(perf.monitorEventLoopDelay)
          : undefined),
      gc:
        env.gc ?? (env.measuresGc !== false ? createGcSource(env.performanceObserver) : undefined),
      v8Heap:
        env.v8Heap ??
        (env.measuresV8Heap !== false ? createV8HeapReader(getHeapStatistics) : undefined),
      memoryLimit: env.memoryLimit ?? createMemoryLimitReader(nodeProcess, totalmem),
      availableMemory:
        env.availableMemory ??
        (env.measuresAvailableMemory !== false
          ? createAvailableMemoryReader(nodeProcess)
          : undefined),
    };
    this.#resolved = resolved;
    return resolved;
  }

  /** Builds the machinery of one stage against the CURRENT seams. May throw (the caller reports it). */
  #makeRun(stage: Stage): StageRun {
    const env = this.#env;
    const res = this.#resolve();
    switch (stage) {
      case 'memory': {
        const read = env.memoryUsage ?? (() => nodeProcess.memoryUsage());
        return { read, stop: () => {} };
      }
      case 'systemMemory': {
        const read = env.systemMemory ?? (() => ({ total: totalmem(), free: freemem() }));
        return { read, stop: () => {} };
      }
      case 'v8Heap':
        return optionalRun(res.v8Heap);
      case 'memoryLimit':
        return optionalRun(res.memoryLimit, (bytes) => ({ bytes }));
      case 'availableMemory':
        return optionalRun(res.availableMemory, (bytes) => ({ bytes }));
      case 'cpu':
        return this.#cpuRun();
      case 'eventLoop': {
        const source = res.eventLoop;
        if (source === undefined) return NOOP_RUN;
        source.start();
        return { read: () => source.read(), stop: () => source.stop() };
      }
      case 'gc': {
        const source = res.gc;
        if (source === undefined) return NOOP_RUN;
        source.start();
        return { read: () => source.read(), stop: () => source.stop() };
      }
      case 'utilization': {
        // Created per run: a fresh baseline, so the first tick never spans a period nobody was listening.
        const perf = env.perfHooks ?? realPerfHooks;
        const elu = env.eventLoopUtilization ?? createGuardedElu(perf.eventLoopUtilization);
        return {
          read: () => {
            const utilization = elu();
            return utilization === undefined ? undefined : { utilization };
          },
          stop: () => {},
        };
      }
    }
  }

  #cpuRun(): StageRun {
    const env = this.#env;
    const cpuUsage = env.cpuUsage ?? (() => nodeProcess.cpuUsage());
    const nowMs = env.monotonicNowMs ?? (() => performance.now());
    const cpuCount = env.cpuCount ?? (() => cpus().length);
    let last = cpuUsage();
    let lastWallMs = nowMs();
    return {
      read: () => {
        // Read BEFORE any baseline moves: a throw here fails this read and must not advance the CPU window.
        const cpu = cpuUsage();
        const wall = nowMs();
        // `os.cpus()` can be empty (some containers/Android): a share of "no cores" is unknowable, so omit the sample
        // rather than emit Infinity/NaN. Checked before the baseline moves.
        const cores = cpuCount();
        if (!(cores >= 1)) return undefined;
        const userDelta = cpu.user - last.user;
        const systemDelta = cpu.system - last.system;
        const wallMsDelta = wall - lastWallMs;
        last = cpu;
        lastWallMs = wall;
        // The CPU deltas are real regardless of the window. The SHARE is not: a zero-length (or backwards) wall window
        // has no defined percentage, so `processPct` is omitted (never written as 0%).
        // Normalized process CPU %: busy-µs / wall-µs / cores * 100.
        if (!(wallMsDelta > 0)) return { userDelta, systemDelta };
        const processPct = ((userDelta + systemDelta) / (wallMsDelta * 1000) / cores) * 100;
        return { userDelta, systemDelta, processPct };
      },
      stop: () => {},
    };
  }
}

/** A stateless run over a reader that may be unwired (absent) or answer undefined (cannot give a true value). */
function optionalRun<T>(
  reader: (() => T | undefined) | undefined,
  wrap: (value: T) => unknown = (value) => value,
): StageRun {
  if (reader === undefined) return NOOP_RUN;
  return {
    read: () => {
      const value = reader();
      return value === undefined ? undefined : wrap(value);
    },
    stop: () => {},
  };
}

const registry = createTrackerRegistry<ProcessTracker>();

/** A {@link ProcessEnv} plus the object the singleton is keyed on (default: the `process` object). */
export interface ProcessTrackerEnv extends ProcessEnv {
  key?: object;
}

function seamsOf(env: ProcessTrackerEnv): ProcessEnv {
  const seams: Record<string, unknown> = {};
  for (const key of SEAM_KEYS) {
    const value = env[key];
    if (value !== undefined) seams[key] = value;
  }
  return seams as ProcessEnv;
}

/**
 * The singleton ProcessTracker for the env's key (the `process` object by default). Every call (a relaunch
 * included) hands the shared tracker the latest launch's `onError` and seams (see {@link ProcessTracker.rebind});
 * nothing else of the env is kept.
 */
export function processTrackerFor(
  env: ProcessTrackerEnv = {},
  onError?: (error: unknown) => void,
): ProcessTracker {
  const seams = seamsOf(env);
  return registry.for(
    env.key ?? nodeProcess,
    () => new ProcessTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/** Test/teardown: drop the key's tracker (resetting it, so its timer and sources are released). */
export function resetProcessTracker(key: object = nodeProcess): void {
  registry.reset(key);
}
