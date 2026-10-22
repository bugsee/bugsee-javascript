import { serviceToken } from '@bugsee/service';

// DISK PRESSURE (iOS `BGSTrackerDiskSpace` port; spec `traces.md#capture`, JavaScript C7): a tiny state machine over
// "how much room is left where the capture store persists", with iOS's thresholds and hysteresis. The kernel owns
// only the state and its change subscription; a platform FEEDS it (Node/Electron main: `statfs` of the data dir;
// browser: `navigator.storage.estimate()` headroom) and the capture stores / the `capture` trace READ it (pub/sub, no
// piercing the core).
//
//   normal -> low   when free < 50 MiB           low -> normal  only at free >= 60 MiB   (+10 MiB hysteresis)
//   any    -> none  when free < 10 MiB           none -> low    only at free >= 20 MiB; none -> normal at >= 60 MiB
//
// Units are BINARY mebibytes, as iOS (`BGSUtil.m`: `freeMB = totalFree / 1024 / 1024`, the 50 / 10 / 10 constants in
// `BGSTrackerDiskSpace.m` compare against that). A reading that is not a finite non-negative number is IGNORED: the
// state never changes on an absent, hostile or impossible reading, so pressure is never fabricated (a failed `statfs`
// is not a full disk).
//
// WRITE FAILURE PIN. A write that fails for lack of space (`noteWriteError`) holds `none` regardless of what the size
// readings say, until a durable write SUCCEEDS (`noteWriteRecovered`): a size reading is a different instrument from a
// refused write (a fuzzed browser quota, a per-user `EDQUOT`) and must not undo it. While pinned, `pinned()` is true so
// the store can send a probe write; the size readings keep updating the underlying level, which takes over again
// when the pin clears.

/** `normal` = persist everything; `low` = stop persisting replay/log/network; `none` = persist nothing. */
export type DiskPressureLevel = 'normal' | 'low' | 'none';

/** The read-only view a capture store / trace producer is handed. */
export interface DiskPressure {
  /** The current level (`none` while pinned by a refused write). */
  level(): DiskPressureLevel;
  /** True while `none` is held by a refused write rather than by a size reading. */
  pinned(): boolean;
  /** Subscribe to level changes (fires only on a real transition, with the NEW level). Returns an unsubscribe. */
  onChange(listener: (level: DiskPressureLevel) => void): () => void;
}

/** The mutable state a platform feeds. */
export interface DiskPressureState extends DiskPressure {
  /** Apply a free-space reading in BYTES. Not a finite number >= 0: ignored. */
  observe(freeBytes: number): void;
  /**
   * A persistence write failed (call it for EVERY failure). When `error` says "out of space", pin `none` and return true.
   * `suspect: true` widens "out of space" to what a browser actually reports for a refused IndexedDB write on a full disk:
   * Chromium surfaces it as `AbortError` or `InvalidStateError` (the transaction aborts / the connection closes), not as
   * `QuotaExceededError`. Pass it ONLY for a failed WRITE of the capture store, never for a read or a delete.
   */
  noteWriteError(error: unknown, options?: { suspect?: boolean }): boolean;
  /** A durable write succeeded: release a write-failure pin (the size readings decide again). */
  noteWriteRecovered(): void;
}

/** iOS thresholds (binary MiB): below this free space the store stops persisting replay, log and network. */
export const DISK_LOW_BYTES = 50 * 1024 * 1024;
/** Below this free space nothing is persisted. */
export const DISK_NONE_BYTES = 10 * 1024 * 1024;
/** A state is left only at its threshold plus this margin. */
export const DISK_RECOVERY_MARGIN_BYTES = 10 * 1024 * 1024;

/** Service token: the platform registers the launch's disk pressure when `captureDiskSpace` is on. */
export const DiskPressureToken = serviceToken<DiskPressureState>('diskPressure');

export interface DiskPressureOptions {
  /** A throwing listener is reported here and isolated. Default no-op. */
  onError?: (error: unknown) => void;
}

const OUT_OF_SPACE_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);
const OUT_OF_SPACE_CODES = new Set(['ENOSPC', 'EDQUOT']);

/**
 * Whether an error means the medium is out of room: a `QuotaExceededError` (IndexedDB / Storage), Firefox's
 * `NS_ERROR_DOM_QUOTA_REACHED`, or a Node `ENOSPC` / `EDQUOT`. Every property read is guarded: a hostile error
 * object answers `false`.
 */
export function isOutOfSpaceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  try {
    const { name, code } = error as { name?: unknown; code?: unknown };
    return (
      (typeof name === 'string' && OUT_OF_SPACE_NAMES.has(name)) ||
      (typeof code === 'string' && OUT_OF_SPACE_CODES.has(code))
    );
  } catch {
    return false;
  }
}

const SUSPECT_NAMES = new Set(['AbortError', 'InvalidStateError']);

/** {@link isOutOfSpaceError}, plus the names Chromium uses for an IndexedDB write refused on a full disk. */
export function isStorageFullSuspect(error: unknown): boolean {
  if (isOutOfSpaceError(error)) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  try {
    const { name } = error as { name?: unknown };
    return typeof name === 'string' && SUSPECT_NAMES.has(name);
  } catch {
    return false;
  }
}

/** Next level for a reading, given the level the reading arrives from (hysteresis on the way up only). */
function nextLevel(free: number, current: DiskPressureLevel): DiskPressureLevel {
  const noneLeave = DISK_NONE_BYTES + DISK_RECOVERY_MARGIN_BYTES;
  const lowLeave = DISK_LOW_BYTES + DISK_RECOVERY_MARGIN_BYTES;
  if (current === 'normal') {
    if (free < DISK_NONE_BYTES) return 'none';
    return free < DISK_LOW_BYTES ? 'low' : 'normal';
  }
  if (current === 'low') {
    if (free < DISK_NONE_BYTES) return 'none';
    return free >= lowLeave ? 'normal' : 'low';
  }
  if (free >= lowLeave) return 'normal';
  return free >= noneLeave ? 'low' : 'none';
}

export function createDiskPressure(options: DiskPressureOptions = {}): DiskPressureState {
  // What the size readings say, with their own hysteresis; a pin overrides it without disturbing it.
  let reading: DiskPressureLevel = 'normal';
  let pin = false;
  let current: DiskPressureLevel = 'normal';
  const listeners = new Set<(level: DiskPressureLevel) => void>();

  const publish = (): void => {
    const level: DiskPressureLevel = pin ? 'none' : reading;
    if (level === current) {
      return;
    }
    current = level;
    for (const listener of [...listeners]) {
      try {
        listener(level);
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {
          /* the reporter itself failed */
        }
      }
    }
  };

  return {
    level: () => current,
    pinned: () => pin,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observe(freeBytes) {
      if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) {
        return;
      }
      reading = nextLevel(freeBytes, reading);
      publish();
    },
    noteWriteError(error, noteOptions) {
      if (
        !(noteOptions?.suspect === true ? isStorageFullSuspect(error) : isOutOfSpaceError(error))
      ) {
        return false;
      }
      pin = true;
      publish();
      return true;
    },
    noteWriteRecovered() {
      pin = false;
      publish();
    },
  };
}
