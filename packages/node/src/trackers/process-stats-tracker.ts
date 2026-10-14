import { cpus, freemem, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { InterceptorBase, type Scheduler } from '@bugsee/core';

// Shared node process-stats TRACKER (mirrors the mobile tracker/producer split): ONE timer aggregates
// memory / system RAM / CPU deltas (+ optional event-loop sources) into a ProcessStats object that many
// per-trace producers read. Attaches nothing until its first subscriber; the last unsubscribe releases
// the timer and stops the event-loop source. The cpu% arithmetic is identical to system-metrics.ts.

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
  utilization?: number;
}

export interface ProcessStatsDeps {
  memoryUsage?: () => ProcessStats['memory'];
  cpuUsage?: () => { user: number; system: number };
  systemMemory?: () => { total: number; free: number };
  cpuCount?: () => number;
  monotonicNowMs?: () => number;
  /** Lazily started on activation, stopped on deactivation. Default: none (lag omitted). */
  eventLoop?: EventLoopSource;
  /** ELU delta 0..1 per call, or undefined when unavailable. Default: none. */
  eventLoopUtilization?: () => number | undefined;
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
  scheduler: Scheduler;
  intervalMs: number;
}

export class ProcessStatsTracker extends InterceptorBase<{ stats: ProcessStats }> {
  readonly name = 'node-process-stats';
  readonly #d: ResolvedDeps;
  readonly #eventLoop: EventLoopSource | undefined;
  readonly #eventLoopUtilization: (() => number | undefined) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #timer: unknown = null;
  #eventLoopRunning = false;
  #lastCpu = { user: 0, system: 0 };
  #lastWallMs = 0;
  #cached: ProcessStats | undefined;

  constructor(deps: ProcessStatsDeps = {}) {
    super(deps.onError);
    // Per-field `??` (not a spread): an explicit `undefined` must fall back to the default.
    this.#d = {
      memoryUsage: deps.memoryUsage ?? (() => process.memoryUsage()),
      cpuUsage: deps.cpuUsage ?? (() => process.cpuUsage()),
      systemMemory: deps.systemMemory ?? (() => ({ total: totalmem(), free: freemem() })),
      cpuCount: deps.cpuCount ?? (() => cpus().length),
      monotonicNowMs: deps.monotonicNowMs ?? (() => performance.now()),
      scheduler: deps.scheduler ?? defaultScheduler,
      intervalMs: deps.intervalMs ?? 1000,
    };
    this.#eventLoop = deps.eventLoop;
    this.#eventLoopUtilization = deps.eventLoopUtilization;
    this.#onError = deps.onError;
  }

  /** Latest stats (read once on activation, then replaced on every poll). Safe for many callers. */
  current(): ProcessStats {
    this.#cached ??= this.#read();
    return this.#cached;
  }

  // Guarded: InterceptorBase marks the tracker active (and the subscriber is already registered) BEFORE
  // this runs, so a throw escaping here would leave an "active" tracker with no timer and leak the
  // subscribing producer's listener. A failure is reported and everything started is unwound; the
  // tracker then re-tries on its next activation (after the current subscribers leave).
  protected onActivate(): void {
    try {
      this.#lastCpu = this.#d.cpuUsage();
      this.#lastWallMs = this.#d.monotonicNowMs();
      this.#cached = undefined;
      if (this.#eventLoop !== undefined) {
        this.#eventLoop.start();
        this.#eventLoopRunning = true;
      }
      this.#timer = this.#d.scheduler.setInterval(() => this.#poll(), this.#d.intervalMs);
    } catch (error) {
      this.#onError?.(error);
      this.#timer = null;
      try {
        this.#stopEventLoop();
      } catch {
        /* best-effort unwind; the original failure is the one reported */
      }
    }
  }

  /** Stops the event-loop source only if this activation started it. */
  #stopEventLoop(): void {
    if (!this.#eventLoopRunning) return;
    this.#eventLoopRunning = false;
    this.#eventLoop?.stop();
  }

  protected override onDeactivate(): void {
    this.#d.scheduler.clearInterval(this.#timer);
    this.#timer = null;
    this.#stopEventLoop();
    this.#cached = undefined;
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
    return {
      memory,
      systemMemory,
      cpu: { userDelta, systemDelta, processPct },
      ...(eventLoop !== undefined ? { eventLoop } : {}),
      ...(utilization !== undefined ? { utilization } : {}),
    };
  }
}
