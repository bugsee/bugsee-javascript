import type { ChunkBackend, FrozenPart, PartRef } from './chunk-backend';
import { type Clock, createSystemClock } from './clock';
import type { CaptureSnapshot, CaptureStore, StoredEntry } from './contracts';
import type { DiskPressure } from './disk-pressure';
import { withDiskPressure } from './disk-pressure-backend';

// The chunk-based CaptureStore (Android `CapturePartManager` analog): an Android-style PartManager that
// keeps only a part metadata INDEX in memory and writes every record through to a ChunkBackend. Captured
// records accumulate in the current 1-second PART; tick(now) closes it, opens a new one, and evicts
// parts outside the recording window; an optional maxDataSize byte cap evicts oldest CLOSED parts. One
// implementation serves every backend (in-memory / file / IndexedDB) — only the storage medium differs.
// snapshot() freezes the in-window parts (each with its current entry count, the open-part isolation
// boundary) and delegates to the backend, which produces an isolated CaptureSnapshot.

const PART_DURATION_MS = 1000;

export interface ChunkCaptureStoreOptions {
  /** Recording window in ms: keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /** Byte ceiling on stored records; oldest closed parts are evicted once exceeded. Default unbounded. */
  maxDataSizeBytes?: number;
  /** Time source for the initial part / clear. Default system clock. */
  clock?: Clock;
  /**
   * Disk pressure (C7). Under it the DURABLE backend stops receiving replay/log/network (low) or anything (none)
   * while the in-memory window is kept (see `disk-pressure-backend.ts`). Absent: every record is persisted as
   * before. Pointless over a backend that is already in memory.
   */
  diskPressure?: DiskPressure;
  /** With `diskPressure`: a durable write that throws is reported here instead of being rethrown (the record is kept). */
  onDiskWriteError?: (error: unknown) => void;
  /** With `diskPressure`: a failed read of the durable half (once per snapshot); the snapshot serves memory instead. */
  onDiskReadError?: (error: unknown) => void;
  /** With `diskPressure`: how long a durable read may take before it counts as failed (default 5000 ms). */
  diskReadTimeoutMs?: number;
}

// The in-memory index entry per live part (NO record data — that lives in the backend).
interface IndexedPart {
  readonly ref: PartRef;
  start: number;
  end: number | undefined;
  byteSize: number;
  count: number;
}

export function createChunkCaptureStore(
  durableBackend: ChunkBackend,
  options?: ChunkCaptureStoreOptions,
): CaptureStore {
  const backend =
    options?.diskPressure !== undefined
      ? withDiskPressure(durableBackend, options.diskPressure, {
          ...(options.onDiskWriteError !== undefined
            ? { onWriteError: options.onDiskWriteError }
            : {}),
          ...(options.onDiskReadError !== undefined
            ? { onReadError: options.onDiskReadError }
            : {}),
          ...(options.diskReadTimeoutMs !== undefined
            ? { readTimeoutMs: options.diskReadTimeoutMs }
            : {}),
        })
      : durableBackend;
  const maxRecordingTimeMs = options?.maxRecordingTimeMs ?? 60_000;
  const maxDataSizeBytes = options?.maxDataSizeBytes;
  const clock = options?.clock ?? createSystemClock();
  const generation = backend.generation;

  // Oldest-first; the last entry is the current (open) part.
  let parts: IndexedPart[] = [];
  // Running byte total across all live parts; kept in sync with every add/evict so the byte cap and the
  // time window never double-count.
  let totalBytes = 0;
  let nextNumber = 0;

  const openNewPart = (start: number): void => {
    const ref: PartRef = { generation, number: nextNumber };
    nextNumber += 1;
    backend.openPart(ref, start);
    parts.push({ ref, start, end: undefined, byteSize: 0, count: 0 });
  };

  const currentPart = (): IndexedPart => parts[parts.length - 1] as IndexedPart;

  // Evict whole oldest CLOSED parts until the byte total fits the cap. Never the open current part
  // (parts.length > 1 guard): a lone oversized part is kept (soft bound). No-op when unbounded.
  const enforceByteCap = (): void => {
    if (maxDataSizeBytes === undefined) {
      return;
    }
    while (totalBytes > maxDataSizeBytes && parts.length > 1) {
      const dropped = parts.shift() as IndexedPart;
      totalBytes -= dropped.byteSize;
      backend.removePart(dropped.ref);
    }
  };

  openNewPart(clock.wallNow());

  // Captured once, pre-bound, so the "does this backend support flush?" narrowing holds inside the closure.
  const backendFlush = backend.flush?.bind(backend);

  return {
    add(record: StoredEntry): void {
      const part = currentPart();
      const size = backend.appendEntry(part.ref, record);
      part.byteSize += size;
      part.count += 1;
      totalBytes += size;
      enforceByteCap();
    },

    tick(nowMs: number): void {
      const closing = currentPart();
      closing.end = nowMs;
      backend.closePart(closing.ref, nowMs, closing.byteSize);
      openNewPart(nowMs);
      // Evict closed parts whose end is outside the window (keep one extra part, Android parity).
      const cutting = nowMs - maxRecordingTimeMs - PART_DURATION_MS;
      while (
        parts.length > 0 &&
        parts[0]?.end !== undefined &&
        (parts[0].end as number) < cutting
      ) {
        const dropped = parts.shift() as IndexedPart;
        totalBytes -= dropped.byteSize;
        backend.removePart(dropped.ref);
      }
    },

    snapshot(): CaptureSnapshot {
      // Freeze each in-window part with its CURRENT entry count — the boundary that keeps post-snapshot
      // captures (to the still-open part) out of the frozen view. The backend isolates the read.
      const frozen: FrozenPart[] = parts.map((part) => ({ ref: part.ref, count: part.count }));
      return backend.snapshot(frozen);
    },

    clear(): void {
      backend.removeGeneration(generation);
      parts = [];
      totalBytes = 0;
      openNewPart(clock.wallNow());
    },

    // Forwarded only when the backend HAS one, so `'flush' in store` stays an honest test for "this store
    // can commit pending writes" rather than always true and sometimes meaningless. Bound to a local so the
    // narrowing survives into the closure — TS re-widens `backend.flush` when it is called later.
    ...(backendFlush !== undefined ? { flush: (): Promise<void> => backendFlush() } : {}),
  };
}
