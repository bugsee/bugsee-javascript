import type { DiskPressureState } from '@bugsee/core';
import { type StorageTrackerEnv, storageTrackerFor } from '@bugsee/trackers/node';

// Feeds the launch's DiskPressure from the per-process StorageTracker (`@bugsee/trackers/node`): the SAME `statfs` of
// the data directory's volume, on the same 5 s timer, that backs `disk_mem_free` — one read serves both. COMPOSITION
// only: the read, the poll, the failure-streak reporting and the omit-never-zero rule belong to the tracker. An
// absent, failed or impossible reading never reaches `observe` (the tracker emits nothing for it), so a hostile
// `statfs` cannot change the state, let alone fabricate pressure.
//
// Subscribing arms the tracker's poll (an immediate read, then its timer); the returned function releases it.

export interface DiskPressureFeedDeps extends Omit<StorageTrackerEnv, 'key'> {
  /** The directory whose volume is measured (the launch's effective data dir). */
  dataDir: string;
  onError?: (error: unknown) => void;
}

export function startDiskPressureFeed(
  pressure: DiskPressureState,
  deps: DiskPressureFeedDeps,
): () => void {
  const { onError, ...env } = deps;
  return storageTrackerFor(env, onError).on('disk', (reading) => {
    pressure.observe(reading.freeBytes);
  });
}
