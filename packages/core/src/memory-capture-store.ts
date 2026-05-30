import { utf8ByteLength } from '@bugsee/util';
import { createRecordSnapshot } from './capture-snapshot';
import { type Clock, createSystemClock } from './clock';
import type { CaptureSnapshot, CaptureStore, StoredEntry } from './contracts';

// In-memory CaptureStore implemented as an Android-style PartManager: captured records accumulate in
// the current 1-second PART; tick(now) closes it, opens a new one, and evicts parts outside the
// recording window (default 60s) — so the live store is always ~the last maxRecordingTime seconds.
// snapshot() freezes the current parts' records into a CaptureSnapshot for export, divorced from the
// rolling window (a flat copy of record refs — records are immutable, so capture keeps writing while
// the snapshot is read). The default backend, and the only option on runtimes without persistent
// storage (lambda/edge). Node/Bun (disk) and browser (IndexedDB) ship their own part-based stores.
//
// Two memory bounds apply (drop-oldest-part semantics, design A1): the time window above, and an
// optional maxDataSize BYTE cap enforced on add — when the running UTF-8 byte total of stored
// records exceeds the cap, whole oldest CLOSED parts are evicted until it fits. The open current
// part is never evicted, so a single oversized part is a documented soft over-shoot of the cap.
// (Per-type count caps — maxBreadcrumbs — remain a separate, not-yet-implemented bound.)

const PART_DURATION_MS = 1000;

interface Part {
  startTimestamp: number;
  /** undefined while the part is open (the current part). */
  endTimestamp: number | undefined;
  records: StoredEntry[];
  /** Running UTF-8 byte total of this part's records' serialized forms. */
  bytes: number;
}

export interface MemoryCaptureStoreOptions {
  /** Recording window in ms (design maxRecordingTime): keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /**
   * Byte ceiling (design maxDataSize) on the total UTF-8 size of stored records; oldest closed parts
   * are evicted once it is exceeded. Default undefined = unbounded (only the time window applies).
   */
  maxDataSizeBytes?: number;
  /** Time source for the initial part / clear; injectable for tests. Default system clock. */
  clock?: Clock;
}

const freshPart = (startTimestamp: number): Part => ({
  startTimestamp,
  endTimestamp: undefined,
  records: [],
  bytes: 0,
});

export function createMemoryCaptureStore(options?: MemoryCaptureStoreOptions): CaptureStore {
  const maxRecordingTimeMs = options?.maxRecordingTimeMs ?? 60_000;
  const maxDataSizeBytes = options?.maxDataSizeBytes;
  const clock = options?.clock ?? createSystemClock();

  // Oldest-first; the last part is the current (open) part.
  let parts: Part[] = [freshPart(clock.wallNow())];
  // Running byte total across all live parts; kept in sync with every add/evict so the byte cap and
  // the time window never double-count.
  let totalBytes = 0;

  const currentPart = (): Part => parts[parts.length - 1] as Part;

  // Evict whole oldest CLOSED parts until the byte total fits the cap. Never the open current part
  // (parts.length > 1 guard): a lone oversized part is kept (soft bound). No-op when unbounded.
  const enforceByteCap = (): void => {
    if (maxDataSizeBytes === undefined) {
      return;
    }
    while (totalBytes > maxDataSizeBytes && parts.length > 1) {
      totalBytes -= (parts.shift() as Part).bytes;
    }
  };

  return {
    add(record: StoredEntry): void {
      const size = utf8ByteLength(record.serialized);
      const part = currentPart();
      part.records.push(record);
      part.bytes += size;
      totalBytes += size;
      enforceByteCap();
    },

    tick(nowMs: number): void {
      currentPart().endTimestamp = nowMs;
      parts.push(freshPart(nowMs));
      // Evict closed parts whose end is outside the window (keep one extra part, Android parity).
      const cutting = nowMs - maxRecordingTimeMs - PART_DURATION_MS;
      while (
        parts.length > 0 &&
        parts[0]?.endTimestamp !== undefined &&
        parts[0].endTimestamp < cutting
      ) {
        totalBytes -= (parts.shift() as Part).bytes;
      }
    },

    snapshot(): CaptureSnapshot {
      // Flat copy of record refs across parts (chronological); records are immutable, so the live
      // store can keep rolling without affecting the snapshot.
      return createRecordSnapshot(parts.flatMap((part) => part.records));
    },

    clear(): void {
      parts = [freshPart(clock.wallNow())];
      totalBytes = 0;
    },
  };
}
