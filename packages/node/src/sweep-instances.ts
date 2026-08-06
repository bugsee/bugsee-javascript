import { join } from 'node:path';
import { listFiles, remove } from '@bugsee/node-utils';
import { pidAlive, readLiveMtimeMs, readOwner } from './liveness';

// Age-based (TTL) hygiene sweep for default-on-disk capture (server write-path P1, D3). With disk capture
// the DEFAULT, abandoned per-instance subtrees would otherwise accumulate under `os.tmpdir()/bugsee/<hash>`
// — runs that crashed and never relaunched. Multi-instance recovery already reclaims FRESH dead siblings
// (recover-then-remove); this sweep is the last-resort reaper for the truly abandoned: a subtree whose
// owning process is dead AND whose newest activity is older than the TTL is removed outright (its very-old
// capture is discarded, not recovered — an accepted tradeoff). A live owner is not touched in practice
// because a live instance heartbeats, so it never ages out — but a LIVE PID alone no longer protects a
// subtree (Wave 6.6), since recovery now deliberately keeps alive-pid siblings and a recycled pid would
// otherwise be un-reclaimable forever. The shape regex below is a cheap first filter, NOT the
// safety boundary (it also matches e.g. a `2024-01-02` date dir): the real guard is that a subtree is
// reclaimed ONLY when it carries a valid `owner.json` (the Bugsee marker), so a foreign directory is never
// recursive-deleted even if its name matches the shape. Runs on launch whenever a shared on-disk dataDir is
// in use, independent of whether recovery is enabled. Fully defensive: a per-subtree failure goes to onError
// and never blocks the rest or the launch.

/** A cheap first-filter for instance-id-shaped names; the owner.json marker (not this) is the safety gate. */
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
      if (owner === undefined) {
        continue;
      }
      // A LIVE pid used to stop the sweep unconditionally. Since Wave 6.6 recovery deliberately keeps an
      // alive-pid main-thread sibling however stale its heartbeat — so a frozen process no longer has its
      // capture deleted underneath it — this sweep is the only thing left that can free a subtree whose pid
      // was RECYCLED by an unrelated process. Age alone would not justify that: a live instance whose
      // heartbeat has been FAILING has no `.live` file at all, and sweeping it on `startedAt` would delete
      // a running instance's capture, which is the very defect 6.6 exists to fix.
      //
      // A STALE HEARTBEAT FILE is the signal that distinguishes them. It exists only because an instance
      // once wrote it, and a live instance rewrites it every 10 s — so one untouched for the whole TTL
      // belongs to nobody, whatever its pid now says. No file at all stays protected.
      const beat = readLiveMtimeMs(join(sub, '.live'));
      if (pidAlive(owner.pid, options.kill) && beat === undefined) {
        continue;
      }
      if (now() - (beat ?? owner.startedAt) <= ttlMs) {
        continue; // still within the TTL window — keep it (recovery may yet reclaim it)
      }
      remove(sub);
    } catch (error) {
      onError(error); // isolate a per-subtree failure; keep sweeping the rest
    }
  }
}
