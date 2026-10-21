import { serviceToken } from '@bugsee/service';

// DISK PRESSURE (iOS `BGSTrackerDiskSpace` port; spec `traces.md#capture`, JavaScript C7): a tiny state machine over
// "how much room is left where the capture store persists", with iOS's thresholds and hysteresis. The kernel owns
// only the state and its change subscription; a platform FEEDS it (Node/Electron main: `statfs` of the data dir;
// browser: `navigator.storage.estimate()` headroom) and the capture stores / the `capture` trace READ it (pub/sub, no
// piercing the core).
//
//   normal -> low   when free < 50 MB            low -> normal  only at free >= 60 MB   (+10 MB hysteresis)
//   any    -> none  when free < 10 MB            none -> low    only at free >= 20 MB; none -> normal at >= 60 MB
//
// Units are DECIMAL megabytes, as iOS. A reading that is not a finite non-negative number is IGNORED: the state never
// changes on an absent, hostile or impossible reading, so pressure is never fabricated (a failed `statfs` is not a full
// disk). A write that fails for lack of space pins `none` at once; the pin is released only by a sane reading that
// clears the none-leave margin, so a quota estimate that still looks healthy cannot undo the evidence of a failed write
// until the next poll shows room.

/** `normal` = persist everything; `low` = stop persisting replay/log/network; `none` = persist nothing. */
export type DiskPressureLevel = 'normal' | 'low' | 'none';

/** The read-only view a capture store / trace producer is handed. */
export interface DiskPressure {
  /** The current level. */
  level(): DiskPressureLevel;
  /** Subscribe to level changes (fires only on a real transition, with the NEW level). Returns an unsubscribe. */
  onChange(listener: (level: DiskPressureLevel) => void): () => void;
}

/** The mutable state a platform feeds. */
export interface DiskPressureState extends DiskPressure {
  /** Apply a free-space reading in BYTES. Not a finite number >= 0: ignored. */
  observe(freeBytes: number): void;
  /** A persistence write failed. When `error` says "out of space", move to `none` and return true; else false. */
  noteWriteError(error: unknown): boolean;
}

/** iOS thresholds (decimal MB): below this free space the store stops persisting replay, log and network. */
export const DISK_LOW_BYTES = 50_000_000;
/** Below this free space nothing is persisted. */
export const DISK_NONE_BYTES = 10_000_000;
/** A state is left only at its threshold plus this margin. */
export const DISK_RECOVERY_MARGIN_BYTES = 10_000_000;

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
  let current: DiskPressureLevel = 'normal';
  const listeners = new Set<(level: DiskPressureLevel) => void>();

  const set = (level: DiskPressureLevel): void => {
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
      set(nextLevel(freeBytes, current));
    },
    noteWriteError(error) {
      if (!isOutOfSpaceError(error)) {
        return false;
      }
      set('none');
      return true;
    },
  };
}
