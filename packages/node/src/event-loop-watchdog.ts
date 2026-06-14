import { Worker } from 'node:worker_threads';
import type { Scheduler } from '@bugsee/core';

// The event-loop watchdog (node diagnostics, A1) — the Android `BugseeDetectionHang` analog for Node. The
// main thread writes a wall-clock heartbeat into a SharedArrayBuffer on a timer; a WORKER thread polls the
// buffer independently. When the event loop blocks, the heartbeat timer (itself on the loop) can't fire, so
// the stored timestamp goes stale and the worker observes it growing — the robust part: a fully blocked
// loop is exactly when a same-thread detector would be dead too. The worker is deliberately DUMB (it posts
// the raw stall duration); the level/escalation/dedup logic lives on the main thread (evaluateHang +
// reported-rank), so it is pure and unit-testable. The worker is injectable for tests; absent worker_threads
// (a runtime without it) → a no-op via the capability guard.

/** Escalating hang thresholds (Android-canonical defaults: 3000 / 5000 / 10000 ms). */
export interface HangThresholds {
  fairMs: number;
  mediumMs: number;
  severeMs: number;
}

export type HangLevel = 'fair' | 'medium' | 'severe';

const RANK: Record<HangLevel, number> = { fair: 1, medium: 2, severe: 3 };

/** The HIGHEST hang level a stall duration crosses, or undefined when it is below `fair`. Pure. */
export function evaluateHang(durationMs: number, t: HangThresholds): HangLevel | undefined {
  if (durationMs >= t.severeMs) {
    return 'severe';
  }
  if (durationMs >= t.mediumMs) {
    return 'medium';
  }
  if (durationMs >= t.fairMs) {
    return 'fair';
  }
  return undefined;
}

/** A message the watchdog worker posts to the main thread. */
export interface WatchdogMessage {
  /** Current stall duration in ms (0 + recovered:true when the loop resumed after a hang). */
  durationMs: number;
  recovered?: boolean;
}

/** The minimal worker surface the watchdog needs — injectable for tests + the capability guard. */
export interface WatchdogWorker {
  on(event: 'message', listener: (msg: WatchdogMessage) => void): void;
  /** Stop pinning the parent process alive (the watchdog must never block a clean exit). */
  unref(): void;
  terminate(): void;
}

/** Android-canonical hang thresholds (BugseeDetectionHang defaults). */
const ANDROID_THRESHOLDS: HangThresholds = { fairMs: 3000, mediumMs: 5000, severeMs: 10_000 };

/**
 * Enforce the strictly-increasing, positive invariant (Android `BugseeDetectionHang` parity); fall back to
 * the Android-canonical defaults on a mis-ordered or non-positive set rather than silently misbehaving.
 */
export function validateThresholds(t: HangThresholds): HangThresholds {
  if (t.fairMs >= 1 && t.fairMs < t.mediumMs && t.mediumMs < t.severeMs) {
    return t;
  }
  return ANDROID_THRESHOLDS;
}

export interface EventLoopWatchdogDeps {
  thresholds: HangThresholds;
  /** Called once per newly-crossed level within a hang episode (escalation), with the stall duration. */
  onHang: (level: HangLevel, durationMs: number) => void;
  /** Heartbeat write interval (ms). MUST be < fairMs (normal staleness ≤ this). Default 1000. */
  heartbeatIntervalMs?: number;
  /** Heartbeat timer; injectable for tests. Default global timers. */
  scheduler?: Scheduler;
  /** Wall clock for the heartbeat; injectable for tests. Default Date.now. */
  now?: () => number;
  /** Spawns the watchdog worker over the shared buffer. Default a node:worker_threads Worker. */
  workerFactory?: (
    sab: SharedArrayBuffer,
    config: { pollMs: number; fairMs: number },
  ) => WatchdogWorker | undefined;
}

export interface EventLoopWatchdog {
  start(): void;
  stop(): void;
}

// The worker body (inline string so it runs without a build step — the monorepo consumes TS source). Dumb:
// poll the heartbeat, post the raw stall duration while it is ≥ fair, and post a single recovered:true when
// the loop resumes. The escalation/dedup logic is on the main thread (see the message handler below).
const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const view = new BigInt64Array(workerData.sab);
let wasHanging = false;
setInterval(() => {
  const last = Number(Atomics.load(view, 0));
  if (last === 0) return;
  const durationMs = Date.now() - last;
  if (durationMs >= workerData.fairMs) {
    parentPort.postMessage({ durationMs });
    wasHanging = true;
  } else if (wasHanging) {
    parentPort.postMessage({ durationMs: 0, recovered: true });
    wasHanging = false;
  }
}, workerData.pollMs);
`;

type WorkerCtor = new (script: string, options: { eval: true; workerData: object }) => unknown;

/**
 * Construct the watchdog worker, or undefined when the runtime lacks worker_threads (the capability
 * guard). Exported with an injectable constructor so the no-worker_threads arm is testable without
 * mocking the builtin. Defaults to node:worker_threads Worker.
 */
export function spawnWatchdogWorker(
  workerData: object,
  WorkerImpl: WorkerCtor = Worker as unknown as WorkerCtor,
): WatchdogWorker | undefined {
  try {
    const w = new WorkerImpl(WORKER_SCRIPT, { eval: true, workerData }) as WatchdogWorker;
    w.unref(); // never let the watchdog worker keep the process alive (a clean exit must not block)
    return w;
  } catch {
    return undefined; // a runtime without worker_threads (or without Worker#unref)
  }
}

const defaultWorkerFactory = (
  sab: SharedArrayBuffer,
  config: { pollMs: number; fairMs: number },
): WatchdogWorker | undefined => spawnWatchdogWorker({ sab, ...config });

export function createEventLoopWatchdog(deps: EventLoopWatchdogDeps): EventLoopWatchdog {
  const { onHang } = deps;
  const thresholds = validateThresholds(deps.thresholds);
  // The heartbeat MUST be < fairMs so normal inter-beat staleness can't false-positive; clamp it.
  const heartbeatIntervalMs = Math.min(
    deps.heartbeatIntervalMs ?? 1000,
    Math.max(1, Math.floor(thresholds.fairMs / 2)),
  );
  const now = deps.now ?? Date.now;
  const scheduler = deps.scheduler ?? globalScheduler;
  const createWorker = deps.workerFactory ?? defaultWorkerFactory;

  let worker: WatchdogWorker | undefined;
  let timer: unknown;
  let reported = 0; // highest level rank reported in the current hang episode (0 = none)

  return {
    start() {
      if (worker) {
        return; // idempotent
      }
      const sab = new SharedArrayBuffer(8);
      const view = new BigInt64Array(sab);
      Atomics.store(view, 0, BigInt(now())); // an initial beat so a not-yet-ticked buffer isn't "stale"
      const w = createWorker(sab, { pollMs: heartbeatIntervalMs, fairMs: thresholds.fairMs });
      if (!w) {
        return; // capability guard: no worker_threads → watchdog disabled
      }
      worker = w;
      worker.on('message', (msg) => {
        if (msg.recovered) {
          reported = 0; // episode over — re-arm for the next hang
          return;
        }
        const level = evaluateHang(msg.durationMs, thresholds);
        if (level !== undefined && RANK[level] > reported) {
          reported = RANK[level];
          onHang(level, msg.durationMs);
        }
      });
      timer = scheduler.setInterval(() => {
        Atomics.store(view, 0, BigInt(now()));
      }, heartbeatIntervalMs);
    },

    stop() {
      if (timer !== undefined) {
        scheduler.clearInterval(timer);
        timer = undefined;
      }
      worker?.terminate();
      worker = undefined;
      reported = 0;
    },
  };
}

const globalScheduler: Scheduler = {
  setInterval: (cb, ms) =>
    (globalThis as { setInterval(cb: () => void, ms: number): unknown }).setInterval(cb, ms),
  clearInterval: (h) => (globalThis as { clearInterval(h: unknown): void }).clearInterval(h),
};
