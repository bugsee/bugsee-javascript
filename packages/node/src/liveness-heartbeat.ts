import { Worker } from 'node:worker_threads';
import type { Scheduler } from '@bugsee/core';
import { writeFileSecure } from '@bugsee/node-utils';

// The liveness heartbeat (design: multi-instance-disk-coexistence.md, D3). While an instance is alive it
// re-writes its `.live` file on an interval, advancing the mtime a peer reads to decide the subtree is still
// in use. Fully defensive: a touch failure goes to onError, never throwing into the app.
//
// WAVE 6.6 — the beat runs on a WORKER THREAD, the hardening this file previously deferred ("a worker-thread
// carrier — true hang-proofness"). On the main-thread scheduler the signal died for the wrong reason: any
// whole-instance stall past the 120 s patient window — a docker pause, a VM suspend, a debugger break, a
// death-spiral GC, or a genuinely blocked event loop, the exact condition this SDK ships ANR detection for —
// made a live instance read as dead, and a sibling coordinator deleted its capture subtree underneath it
// (reproduced with a real SIGSTOP; on resume every write failed ENOENT forever).
//
// Both halves were verified against real worker_threads before building on them: with the main thread
// blocked for 2000 ms the `.live` mtime still advanced by 2033 ms, and a heartbeat worker spawned BY a
// worker thread stops the moment that thread dies — which is what keeps a dead worker_thread instance
// reclaimable rather than protected forever.

const DEFAULT_INTERVAL_MS = 10_000;

// The worker's whole job: rewrite one file on an interval. No message passing in either direction — a
// `message` listener would re-ref the MessagePort and undo the `unref` below, which is precisely how the
// ANR watchdog once made a default launch() unable to exit (Wave 2.4).
const WORKER_SCRIPT = `
const start = (wt) => {
  const { workerData } = wt;
  const fs = require('node:fs');
  const beat = () => { try { fs.writeFileSync(workerData.liveFile, '', { mode: 0o600 }); } catch {} };
  setInterval(beat, workerData.intervalMs);
};
Promise.resolve(typeof require === 'function' ? require('node:worker_threads') : import('node:worker_threads')).then(start).catch(() => {});
`;

/** The slice of a worker this needs: keep it off the process's liveness, and be able to end it. */
export interface HeartbeatWorker {
  unref(): void;
  terminate(): unknown;
}

/**
 * Spawn the heartbeat worker, or undefined where the runtime has no worker_threads (the capability guard).
 * Exported with the same shape as the watchdog's spawner so the no-worker arm is testable without mocking
 * the builtin.
 */
export function spawnHeartbeatWorker(workerData: object): HeartbeatWorker | undefined {
  try {
    const w = new Worker(WORKER_SCRIPT, { eval: true, workerData }) as unknown as HeartbeatWorker;
    w.unref(); // the heartbeat must never keep the host process alive
    return w;
  } catch {
    return undefined;
  }
}

export interface LivenessHeartbeat {
  /** Stop the heartbeat (clears the interval); called from the client's stop(). */
  stop(): void;
}

export interface LivenessHeartbeatDeps {
  /** The instance's `.live` file. */
  liveFile: string;
  /** Scheduler for the interval (the client's resolved scheduler). */
  scheduler: Scheduler;
  /** Beat interval in ms. Default 10000 (well under the 120 s patient reclaim window). */
  intervalMs?: number;
  /** Touch the file (advance its mtime). Default: re-write it owner-only. Injectable for tests. */
  touch?: (file: string) => void;
  /** Failure sink. Default no-op. */
  onError?: (error: unknown) => void;
  /**
   * Spawn the worker that carries the beat. Default the real worker_threads one; returning undefined (or
   * throwing) falls back to the scheduler interval — degraded, but still correct for the common case of a
   * process that dies outright, which the pid probe catches instantly anyway.
   */
  spawnHeartbeatWorker?: (workerData: object) => HeartbeatWorker | undefined;
}

/** Start the `.live` heartbeat — beats once immediately (so the file exists right after launch), then on
 * the interval. Returns a stop handle. */
export function startLivenessHeartbeat(deps: LivenessHeartbeatDeps): LivenessHeartbeat {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const touch = deps.touch ?? ((file: string): void => writeFileSecure(file, ''));
  const onError = deps.onError ?? ((): void => {});
  const beat = (): void => {
    try {
      touch(deps.liveFile);
    } catch (error) {
      onError(error);
    }
  };
  // Synchronous first beat, whichever carrier follows: a sibling coordinator can run its recovery before
  // the worker's first tick lands, and a `.live` file that does not exist yet reads as an instance that
  // never armed.
  beat();

  const spawn = deps.spawnHeartbeatWorker ?? spawnHeartbeatWorker;
  let worker: HeartbeatWorker | undefined;
  try {
    worker = spawn({ liveFile: deps.liveFile, intervalMs });
  } catch (error) {
    onError(error); // a runtime without worker_threads — fall through to the scheduler
  }
  if (worker !== undefined) {
    const w = worker;
    // Unref'd HERE rather than only inside the default spawner, so the guarantee holds for any injected
    // carrier and is observable through the seam. An un-unref'd worker makes a default launch() unable to
    // exit — the Wave 2.4 defect, which was invisible because its test only asserted that unref was called
    // on a fake, never that the process could still exit.
    try {
      w.unref();
    } catch (error) {
      onError(error);
    }
    return {
      stop(): void {
        try {
          w.terminate();
        } catch (error) {
          onError(error);
        }
      },
    };
  }

  const handle = deps.scheduler.setInterval(beat, intervalMs);
  return {
    stop(): void {
      deps.scheduler.clearInterval(handle);
    },
  };
}
