import { cpus, freemem, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { InterceptorBase, type Scheduler } from '@bugsee/core';
import type { GcInterval, GcSource } from './gc-observer';
import type { V8HeapStats } from './runtime-readers';

// Shared node process-stats TRACKER (mirrors the mobile tracker/producer split): ONE timer aggregates
// memory / system RAM / CPU deltas (+ optional event-loop sources) into a ProcessStats object that many
// per-trace producers read. Attaches nothing until its first subscriber; the last unsubscribe releases
// the timer and stops the event-loop source.

export interface EventLoopSource {
  /** Mean/max/p99 lag (ms) since the previous read, or undefined when the runtime cannot measure it. */
  read(): { meanMs: number; maxMs: number; p99Ms: number } | undefined;
  start(): void;
  stop(): void;
}

export interface ProcessStats {
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  systemMemory: { total: number; free: number };
  cpu: { userDelta: number; systemDelta: number; processPct: number };
  eventLoop?: { meanMs: number; maxMs: number; p99Ms: number };
  /** GC activity since the previous poll; ABSENT (never zero) when no GC source is running. */
  gc?: GcInterval;
  utilization?: number;
  /** Whole seconds since process start. Portable, so always present. */
  uptimeS: number;
  /** Each optional field is ABSENT (never zero) when its reader is not wired or cannot answer. */
  v8Heap?: V8HeapStats;
  memoryLimit?: number;
  availableMemory?: number;
}

export interface ProcessStatsDeps {
  memoryUsage?: () => ProcessStats['memory'];
  cpuUsage?: () => { user: number; system: number };
  systemMemory?: () => { total: number; free: number };
  cpuCount?: () => number;
  monotonicNowMs?: () => number;
  /** Lazily started on activation, stopped on deactivation. Default: none (lag omitted). */
  eventLoop?: EventLoopSource;
  /** Lazily started on activation, stopped on deactivation. Default: none (gc omitted). */
  gc?: GcSource;
  /** ELU delta 0..1 per call, or undefined when unavailable. Default: none. */
  eventLoopUtilization?: () => number | undefined;
  /** Seconds since process start (fractions floored). Default `process.uptime()`. */
  uptime?: () => number;
  /** Optional readers; each answers undefined when the runtime cannot give a true value. Default: none. */
  v8Heap?: () => V8HeapStats | undefined;
  memoryLimit?: () => number | undefined;
  availableMemory?: () => number | undefined;
  scheduler?: Scheduler;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

// Unref'd so the tracker never keeps a process alive.
const defaultScheduler: Scheduler = {
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

interface ResolvedDeps {
  memoryUsage: () => ProcessStats['memory'];
  cpuUsage: () => { user: number; system: number };
  systemMemory: () => { total: number; free: number };
  cpuCount: () => number;
  monotonicNowMs: () => number;
  uptime: () => number;
  scheduler: Scheduler;
  intervalMs: number;
}

export class ProcessStatsTracker extends InterceptorBase<{ stats: ProcessStats }> {
  readonly name = 'node-process-stats';
  readonly #d: ResolvedDeps;
  readonly #eventLoop: EventLoopSource | undefined;
  readonly #gc: GcSource | undefined;
  readonly #eventLoopUtilization: (() => number | undefined) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #v8Heap: (() => V8HeapStats | undefined) | undefined;
  readonly #memoryLimit: (() => number | undefined) | undefined;
  readonly #availableMemory: (() => number | undefined) | undefined;
  #timer: unknown = null;
  #eventLoopRunning = false;
  #gcRunning = false;
  #lastCpu = { user: 0, system: 0 };
  #lastWallMs = 0;
  #cached: ProcessStats | undefined;
  #activationFailed = false;

  constructor(deps: ProcessStatsDeps = {}) {
    super(deps.onError);
    // Per-field `??` (not a spread): an explicit `undefined` must fall back to the default.
    this.#d = {
      memoryUsage: deps.memoryUsage ?? (() => process.memoryUsage()),
      cpuUsage: deps.cpuUsage ?? (() => process.cpuUsage()),
      systemMemory: deps.systemMemory ?? (() => ({ total: totalmem(), free: freemem() })),
      cpuCount: deps.cpuCount ?? (() => cpus().length),
      monotonicNowMs: deps.monotonicNowMs ?? (() => performance.now()),
      uptime: deps.uptime ?? (() => process.uptime()),
      scheduler: deps.scheduler ?? defaultScheduler,
      intervalMs: deps.intervalMs ?? 1000,
    };
    this.#eventLoop = deps.eventLoop;
    this.#gc = deps.gc;
    this.#eventLoopUtilization = deps.eventLoopUtilization;
    this.#onError = deps.onError;
    this.#v8Heap = deps.v8Heap;
    this.#memoryLimit = deps.memoryLimit;
    this.#availableMemory = deps.availableMemory;
  }

  /**
   * Latest stats (read once on activation, then replaced on every poll). Safe for many callers. If the
   * activation failed, this RETRIES it first (a failure propagates) so a producer never takes a baseline
   * from a tracker that has no timer and would otherwise stay silent until every subscriber left.
   */
  current(): ProcessStats {
    if (this.#activationFailed) {
      this.#activate();
      this.#activationFailed = false;
    }
    this.#cached ??= this.#read();
    return this.#cached;
  }

  // Guarded: InterceptorBase marks the tracker active (and the subscriber is already registered) BEFORE
  // this runs, so a throw escaping here would leave an "active" tracker with no timer and leak the
  // subscribing producer's listener. A failure is reported, everything started is unwound, and the
  // failure is remembered so the next current() retries (deactivation clears it; the next activation
  // retries too).
  protected onActivate(): void {
    try {
      this.#activate();
    } catch (error) {
      this.#activationFailed = true;
      this.#onError?.(error);
    }
  }

  // Starts everything or unwinds what it started and rethrows.
  #activate(): void {
    try {
      this.#lastCpu = this.#d.cpuUsage();
      this.#lastWallMs = this.#d.monotonicNowMs();
      this.#cached = undefined;
      if (this.#eventLoop !== undefined) {
        this.#eventLoop.start();
        this.#eventLoopRunning = true;
      }
      if (this.#gc !== undefined) {
        this.#gc.start();
        this.#gcRunning = true;
      }
      this.#timer = this.#d.scheduler.setInterval(() => this.#poll(), this.#d.intervalMs);
    } catch (error) {
      this.#stopSources(); // best-effort unwind; the original failure is the one thrown
      throw error;
    }
  }

  /** Stops each source only if this activation started it; one failing stop() must not strand the other. */
  #stopSources(): void {
    const eventLoop = this.#eventLoopRunning ? this.#eventLoop : undefined;
    const gc = this.#gcRunning ? this.#gc : undefined;
    this.#eventLoopRunning = false;
    this.#gcRunning = false;
    for (const source of [eventLoop, gc]) {
      try {
        source?.stop();
      } catch (error) {
        try {
          this.#onError?.(error); // reported, never thrown: one failing stop must not strand the other
        } catch {
          /* a failing reporter must not stop the remaining source either */
        }
      }
    }
  }

  protected override onDeactivate(): void {
    if (this.#timer !== null) this.#d.scheduler.clearInterval(this.#timer); // none after a failed activation
    this.#timer = null;
    this.#stopSources();
    this.#cached = undefined;
    this.#activationFailed = false;
  }

  #poll(): void {
    let stats: ProcessStats;
    try {
      stats = this.#read();
    } catch (error) {
      this.#onError?.(error);
      return;
    }
    this.#cached = stats;
    this.emit('stats', stats);
  }

  #read(): ProcessStats {
    // Read before any baseline moves: a throw here fails the whole poll, and must not advance the CPU window.
    const uptimeS = Math.floor(this.#d.uptime());
    const memory = this.#d.memoryUsage();
    const systemMemory = this.#d.systemMemory();
    const cpu = this.#d.cpuUsage();
    const nowMs = this.#d.monotonicNowMs();
    const userDelta = cpu.user - this.#lastCpu.user;
    const systemDelta = cpu.system - this.#lastCpu.system;
    const wallMsDelta = nowMs - this.#lastWallMs;
    this.#lastCpu = cpu;
    this.#lastWallMs = nowMs;
    // Normalized process CPU %: busy-µs / wall-µs / cores * 100. Guard the zero-window first sample.
    const processPct =
      wallMsDelta > 0
        ? ((userDelta + systemDelta) / (wallMsDelta * 1000) / this.#d.cpuCount()) * 100
        : 0;
    const eventLoop = this.#eventLoop?.read();
    const utilization = this.#eventLoopUtilization?.();
    const v8Heap = this.#optional(this.#v8Heap);
    const memoryLimit = this.#optional(this.#memoryLimit);
    const availableMemory = this.#optional(this.#availableMemory);
    // Read LAST: it drains the interval, so nothing that can still fail the poll may run after it.
    const gc = this.#optional(() => this.#gc?.read());
    return {
      memory,
      systemMemory,
      cpu: { userDelta, systemDelta, processPct },
      ...(eventLoop !== undefined ? { eventLoop } : {}),
      ...(gc !== undefined ? { gc } : {}),
      ...(utilization !== undefined ? { utilization } : {}),
      uptimeS,
      ...(v8Heap !== undefined ? { v8Heap } : {}),
      ...(memoryLimit !== undefined ? { memoryLimit } : {}),
      ...(availableMemory !== undefined ? { availableMemory } : {}),
    };
  }

  /** An optional reader failing drops only its own field: it must not take the memory/cpu row with it. */
  #optional<T>(read: (() => T | undefined) | undefined): T | undefined {
    try {
      return read?.();
    } catch (error) {
      this.#onError?.(error);
      return undefined;
    }
  }
}
