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
// (Per-type count caps — maxBreadcrumbs — and a maxDataSize byte bound are secondary memory bounds,
// not yet implemented here.)

const PART_DURATION_MS = 1000;

interface Part {
  startTimestamp: number;
  /** undefined while the part is open (the current part). */
  endTimestamp: number | undefined;
  records: StoredEntry[];
}

export interface MemoryCaptureStoreOptions {
  /** Recording window in ms (design maxRecordingTime): keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /** Time source for the initial part / clear; injectable for tests. Default system clock. */
  clock?: Clock;
}

export function createMemoryCaptureStore(options?: MemoryCaptureStoreOptions): CaptureStore {
  const maxRecordingTimeMs = options?.maxRecordingTimeMs ?? 60_000;
  const clock = options?.clock ?? createSystemClock();

  // Oldest-first; the last part is the current (open) part.
  let parts: Part[] = [{ startTimestamp: clock.wallNow(), endTimestamp: undefined, records: [] }];

  const currentPart = (): Part => parts[parts.length - 1] as Part;

  return {
    add(record: StoredEntry): void {
      currentPart().records.push(record);
    },

    tick(nowMs: number): void {
      currentPart().endTimestamp = nowMs;
      parts.push({ startTimestamp: nowMs, endTimestamp: undefined, records: [] });
      // Evict closed parts whose end is outside the window (keep one extra part, Android parity).
      const cutting = nowMs - maxRecordingTimeMs - PART_DURATION_MS;
      while (
        parts.length > 0 &&
        parts[0]?.endTimestamp !== undefined &&
        parts[0].endTimestamp < cutting
      ) {
        parts.shift();
      }
    },

    snapshot(): CaptureSnapshot {
      // Flat copy of record refs across parts (chronological); records are immutable, so the live
      // store can keep rolling without affecting the snapshot.
      return createRecordSnapshot(parts.flatMap((part) => part.records));
    },

    clear(): void {
      parts = [{ startTimestamp: clock.wallNow(), endTimestamp: undefined, records: [] }];
    },
  };
}
