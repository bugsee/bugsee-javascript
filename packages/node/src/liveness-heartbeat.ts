import type { Scheduler } from '@bugsee/core';
import { writeFileSecure } from '@bugsee/node-utils';

// The liveness heartbeat (design: multi-instance-disk-coexistence.md, D3). While an instance is alive it
// re-writes its `.live` file on an interval, advancing the mtime a peer reads to decide the subtree is still
// in use. A main-thread scheduler interval for v1 (a worker-thread carrier — true hang-proofness — is a
// deferred hardening; `kill(pid,0)` already makes a hung PROCESS read as alive, and the patient window covers
// a hung worker_thread). Fully defensive: a touch failure goes to onError, never throwing into the app.

const DEFAULT_INTERVAL_MS = 10_000;

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
  beat(); // immediate first beat — create the file up front
  const handle = deps.scheduler.setInterval(beat, intervalMs);
  return {
    stop(): void {
      deps.scheduler.clearInterval(handle);
    },
  };
}
