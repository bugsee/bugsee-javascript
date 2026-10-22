import type { DiskPressureState } from '@bugsee/core';
import { type StorageTrackerEnv, storageTrackerFor } from '@bugsee/trackers/browser';

// Feeds the launch's DiskPressure from the window's StorageTracker (`@bugsee/trackers/browser`): the HEADROOM of the
// origin's storage quota, `quota - usage` from `navigator.storage.estimate()`. This is an origin QUOTA estimate, not
// device free space, and browsers pad and fuzz both numbers (Safari, private windows) -- the spec accepts that, and the
// thresholds are the iOS ones (50 MB / 10 MB). A reading missing either number never reaches `observe`, and a negative
// headroom (usage over quota, a padding artifact) is ignored by it: pressure is never fabricated.
//
// Cadence (spec): the tracker's slow 5 minute poll, and every 30 s once headroom is under 500 MB. A page that is
// hidden is not polled (the tracker's own rule). A write failing with `QuotaExceededError` moves the state to
// `none` at once through `DiskPressureState.noteWriteError` (the launch routes the IndexedDB store's error sink there).

/** Poll period once headroom is under {@link DISK_FAST_BELOW_BYTES}. */
export const DISK_FAST_POLL_MS = 30_000;
/** Headroom under which the faster cadence applies (binary MiB, like the thresholds). */
export const DISK_FAST_BELOW_BYTES = 500 * 1024 * 1024;

export interface BrowserDiskPressureFeedDeps
  extends Omit<StorageTrackerEnv, 'fastIntervalMs' | 'fastBelowBytes'> {
  onError?: (error: unknown) => void;
}

/** Subscribe the pressure to the window's StorageTracker. Returns the release function (stops the poll when last). */
export function startBrowserDiskPressureFeed(
  pressure: DiskPressureState,
  deps: BrowserDiskPressureFeedDeps,
): () => void {
  const { onError, ...env } = deps;
  return storageTrackerFor(
    { ...env, fastIntervalMs: DISK_FAST_POLL_MS, fastBelowBytes: DISK_FAST_BELOW_BYTES },
    onError,
  ).on('storageEstimate', (estimate) => {
    if (estimate.usageBytes !== undefined && estimate.quotaBytes !== undefined) {
      pressure.observe(estimate.quotaBytes - estimate.usageBytes);
    }
  });
}
