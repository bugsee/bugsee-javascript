import { join } from 'node:path';
import { listFiles, remove } from '@bugsee/node-utils';
import type { InstanceOwner } from './instance-layout';
import { pidAlive, readLiveMtimeMs, readOwner } from './liveness';

// Age-based (TTL) hygiene sweep for default-on-disk capture (server write-path P1, D3). With disk capture
// the DEFAULT, abandoned per-instance subtrees would otherwise accumulate under `os.tmpdir()/bugsee/<hash>`
// — runs that crashed and never relaunched. Multi-instance recovery already reclaims FRESH dead siblings
// (recover-then-remove); this sweep is the last-resort reaper for the truly abandoned: a subtree whose
// owning process is dead AND whose newest activity is older than the TTL is removed outright (its very-old
// capture is discarded, not recovered — an accepted tradeoff). A LIVE owner is never touched (and a live
// instance heartbeats, so it never ages out anyway). To NEVER recursive-delete a non-Bugsee directory, a
// subtree is only reclaimed when it carries a valid `owner.json` (the Bugsee marker) — a foreign dir whose
// name merely matches the instance-id shape (e.g. a `2024-01-02` date dir) is left untouched. Runs on launch
// whenever a shared on-disk dataDir is in use, independent of whether recovery is enabled. Fully defensive:
// a per-subtree failure goes to onError and never blocks the rest or the launch.

/** Subtree names shaped like an instance id (`<pid>-<threadId>-<nonce>`) — never touch foreign files. */
const INSTANCE_DIR = /^\d+-\d+-/;

/** Default age after which an abandoned (dead) instance subtree is reclaimed for disk hygiene. */
export const DEFAULT_INSTANCE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SweepInstancesOptions {
  /** The shared root holding every instance's subtree. */
  dataDir: string;
  /** This launch's own instance id — its subtree is never touched. */
  ownInstanceId: string;
  /** Age (ms) past which a dead/orphaned subtree is reclaimed. Default DEFAULT_INSTANCE_TTL_MS. */
  ttlMs?: number;
  /** Now (ms). Default Date.now. */
  now?: () => number;
  /** Process-alive probe seam (advanced / tests). Default process.kill via pidAlive. */
  kill?: (pid: number, signal: number) => void;
  /** Failure sink. Default no-op. */
  onError?: (error: unknown) => void;
}

/** Newest activity signal (ms) for a subtree: the heartbeat mtime, else the owner's start time. */
function lastActivityMs(sub: string, owner: InstanceOwner): number {
  const live = readLiveMtimeMs(join(sub, '.live'));
  return live !== undefined ? live : owner.startedAt;
}

/** Remove every abandoned (dead + aged) instance subtree under `dataDir`. Best-effort; never throws. */
export function sweepAgedInstances(options: SweepInstancesOptions): void {
  const onError = options.onError ?? ((): void => {});
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_INSTANCE_TTL_MS;
  let entries: string[];
  try {
    entries = listFiles(options.dataDir);
  } catch (error) {
    onError(error);
    return;
  }
  for (const id of entries) {
    if (id === options.ownInstanceId || !INSTANCE_DIR.test(id)) {
      continue;
    }
    const sub = join(options.dataDir, id);
    try {
      // Only reclaim a subtree carrying a valid owner.json (the Bugsee marker) — never recursive-delete a
      // foreign directory whose name merely matches the instance-id shape, and never reclaim a subtree whose
      // owning process is still alive (it may be a live, quiet instance).
      const owner = readOwner(join(sub, 'owner.json'));
      if (owner === undefined || pidAlive(owner.pid, options.kill)) {
        continue;
      }
      if (now() - lastActivityMs(sub, owner) <= ttlMs) {
        continue; // still within the TTL window — keep it (recovery may yet reclaim it)
      }
      remove(sub);
    } catch (error) {
      onError(error); // isolate a per-subtree failure; keep sweeping the rest
    }
  }
}
