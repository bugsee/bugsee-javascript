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
  /** With `diskPressure`: how long a durable read may take before it counts as failed (default 30000 ms, a backstop). */
  diskReadTimeoutMs?: number;
  /**
   * Called (once, deferred to a microtask so the recorder's synchronous restart cannot re-enter the store) when
   * the byte cap forced a whole visual lane out and no new base is open: the host should restart its recorder so
   * the next records start a fresh base (a replay's Meta + FullSnapshot). Called with the lane key (a window) of the
   * lane that lost its bases, and with no argument for the unkeyed lane.
   */
  onVisualReset?: (lane?: string) => void;
}

// The in-memory index entry per live part (NO record data — that lives in the backend).
interface IndexedPart {
  readonly ref: PartRef;
  start: number;
  end: number | undefined;
  byteSize: number;
  count: number;
  /** The part holds a record that opens a self-contained base (`StoredEntry.anchor`). */
  anchor: boolean;
  /** `visual`: replay/video, shed first under the byte cap and kept anchored to a base. `data`: everything else. */
  readonly lane: Lane;
  /** The visual source key (`StoredEntry.lane`) of a visual part; absent for the data lane and the unkeyed source. */
  readonly key?: string;
}

type Lane = 'data' | 'visual';

// Types whose records depend on a base and are the bulk of the bytes. They live in their own lane of parts so the
// byte cap can shed them (whole base segments) before it touches logs, network or events.
const VISUAL_TYPES: ReadonlySet<string> = new Set(['replay', 'video']);

// The backend's snapshot plus the range fixed at snapshot time. Explicit delegation (not a spread) keeps any `this`-bound
// snapshot working, and `unpin` / `inMemory` stay absent when the backend's snapshot has none (callers test for them).
function withTimeRange(
  snapshot: CaptureSnapshot,
  range: { readonly start: number; readonly end: number },
): CaptureSnapshot {
  const { unpin, inMemory } = snapshot;
  return {
    stream: () => snapshot.stream(),
    drainAll: () => snapshot.drainAll(),
    release: () => snapshot.release(),
    ...(unpin !== undefined ? { unpin: () => unpin.call(snapshot) } : {}),
    ...(inMemory !== undefined ? { inMemory: () => inMemory.call(snapshot) } : {}),
    timeRange: () => range,
  };
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

  // Every live part, oldest-first by part number; both lanes share one number space and one backend, so
  // snapshot and crash recovery see plain parts. The open part of the data lane is `dataPart`; each visual source key has its own
  // open part in `openVisual`, opened lazily by its first record of a tick (a store that never sees one is unchanged).
  let parts: IndexedPart[] = [];
  // Running byte total across all live parts; kept in sync with every add/evict so the byte cap and the
  // time window never double-count.
  let totalBytes = 0;
  let nextNumber = 0;
  // The OPEN visual part of each source key ('' = the unkeyed source), opened lazily by its first record of a tick.
  const openVisual = new Map<string, IndexedPart>();

  const openNewPart = (start: number, lane: Lane, key?: string): IndexedPart => {
    const ref: PartRef = { generation, number: nextNumber };
    nextNumber += 1;
    if (key === undefined) {
      backend.openPart(ref, start);
    } else {
      backend.openPart(ref, start, key);
    }
    const part: IndexedPart = {
      ref,
      start,
      end: undefined,
      byteSize: 0,
      count: 0,
      anchor: false,
      lane,
      ...(key !== undefined ? { key } : {}),
    };
    parts.push(part);
    return part;
  };

  const firstStart = clock.wallNow();
  let dataPart = openNewPart(firstStart, 'data');
  // The earliest time this store holds (or held) data for: when it started recording (first part start since launch / the
  // last clear), or an earlier record stamp (a log buffered before launch is replayed with its own time). Nothing older
  // can be in the window, so the export range never starts before it, and never AFTER a record it would then trim.
  let epoch = firstStart;

  const partFor = (record: StoredEntry): IndexedPart => {
    if (!VISUAL_TYPES.has(record.type)) {
      return dataPart;
    }
    const name = record.lane ?? '';
    let part = openVisual.get(name);
    if (part === undefined) {
      part = openNewPart(dataPart.start, 'visual', record.lane);
      openVisual.set(name, part);
    }
    return part;
  };

  const evictPart = (part: IndexedPart): void => {
    parts.splice(parts.indexOf(part), 1);
    totalBytes -= part.byteSize;
    backend.removePart(part.ref);
  };

  const closedParts = (lane: Lane, key?: string): IndexedPart[] =>
    parts.filter(
      (part) =>
        part.lane === lane && part.end !== undefined && (lane === 'data' || part.key === key),
    );

  // Make room for a byte cap by dropping VISUAL records only, always leaving what remains valid: records before
  // the first base are useless and go first; then the oldest base segment (everything before the next base); a lone
  // segment cannot be shrunk and stays valid, so it goes whole and the host is asked for a fresh base.
  // @returns whether anything was dropped.
  const shedVisual = (): boolean => {
    // The lane that holds the OLDEST visual bytes pays first; each lane keeps its own bases valid.
    const oldest = parts.find((part) => part.lane === 'visual' && part.end !== undefined);
    if (oldest === undefined) {
      return false;
    }
    const key = oldest.key;
    const closed = closedParts('visual', key);
    const firstBase = closed.findIndex((part) => part.anchor);
    let upTo: number;
    if (firstBase !== 0) {
      upTo = firstBase === -1 ? closed.length : firstBase;
    } else {
      const nextBase = closed.findIndex((part, index) => index > 0 && part.anchor);
      upTo = nextBase === -1 ? closed.length : nextBase;
    }
    for (const part of closed.slice(0, upTo)) {
      evictPart(part);
    }
    if (upTo === closed.length && openVisual.get(key ?? '')?.anchor !== true) {
      // Nothing valid is left to show and the open part has no base: a fresh one is needed.
      const reset = options?.onVisualReset;
      if (reset !== undefined) {
        void Promise.resolve().then(() => {
          try {
            if (key === undefined) {
              reset();
            } else {
              reset(key);
            }
          } catch {
            /* a host callback must never break capture */
          }
        });
      }
    }
    return true;
  };

  // The byte cap: shed the visual lane first, then evict the oldest CLOSED data part (only if that can make room).
  // Never an open part: a lone oversized part is kept (soft bound). No-op when unbounded.
  const enforceByteCap = (): void => {
    if (maxDataSizeBytes === undefined) {
      return;
    }
    while (totalBytes > maxDataSizeBytes) {
      if (shedVisual()) {
        continue;
      }
      const closedData = closedParts('data');
      const oldest = closedData[0];
      if (oldest === undefined) {
        break;
      }
      // An open replay part that cannot be shed is the excess: if evicting every closed data part would still not fit,
      // the loss would buy nothing, so keep the in-window logs and let the cap be a soft bound. (Without a visual part
      // the old rule stands: the newest, oversized record is kept and the history before it goes.)
      if (
        openVisual.size > 0 &&
        totalBytes - closedData.reduce((sum, part) => sum + part.byteSize, 0) > maxDataSizeBytes
      ) {
        break;
      }
      evictPart(oldest);
    }
  };

  // Evict one lane's closed parts that end outside the window. The visual lane keeps the newest anchored part at or
  // before the window start (the BASE the window's first records depend on) and everything after it, even though it is
  // older than the window; export trims what falls outside. No such part (no anchor recorded, or the only one is
  // newer) evicts as plain time.
  const evictByTime = (lane: Lane, nowMs: number, key?: string): void => {
    const cutting = nowMs - maxRecordingTimeMs - PART_DURATION_MS;
    const windowStart = nowMs - maxRecordingTimeMs;
    const laneParts = parts.filter(
      (part) => part.lane === lane && (lane === 'data' || part.key === key),
    );
    let evictable = laneParts.length;
    if (lane === 'visual') {
      for (let i = laneParts.length - 1; i >= 0; i--) {
        const candidate = laneParts[i] as IndexedPart;
        if (candidate.anchor && candidate.start <= windowStart) {
          evictable = i;
          break;
        }
      }
    }
    for (const part of laneParts.slice(0, evictable)) {
      if (part.end === undefined || part.end >= cutting) {
        break;
      }
      evictPart(part);
    }
  };

  // Captured once, pre-bound, so the "does this backend support flush?" narrowing holds inside the closure.
  const backendFlush = backend.flush?.bind(backend);

  return {
    add(record: StoredEntry): void {
      const part = partFor(record);
      const size = backend.appendEntry(part.ref, record);
      part.byteSize += size;
      part.count += 1;
      if (record.timestamp < epoch) {
        epoch = record.timestamp;
      }
      if (record.anchor === true) {
        part.anchor = true;
      }
      totalBytes += size;
      enforceByteCap();
    },

    tick(nowMs: number): void {
      dataPart.end = nowMs;
      backend.closePart(dataPart.ref, nowMs, dataPart.byteSize);
      for (const open of openVisual.values()) {
        open.end = nowMs;
        backend.closePart(open.ref, nowMs, open.byteSize);
      }
      openVisual.clear();
      dataPart = openNewPart(nowMs, 'data');
      // Evict closed parts whose end is outside the window (keep one extra part, Android parity).
      evictByTime('data', nowMs);
      // Each visual source keeps the base ITS first in-window records depend on.
      const keys = new Set(parts.filter((part) => part.lane === 'visual').map((part) => part.key));
      for (const key of keys) {
        evictByTime('visual', nowMs, key);
      }
    },

    snapshot(): CaptureSnapshot {
      // Freeze each in-window part with its CURRENT entry count — the boundary that keeps post-snapshot
      // captures (to the still-open part) out of the frozen view. The backend isolates the read.
      const frozen: FrozenPart[] = parts.map((part) => ({
        ref: part.ref,
        count: part.count,
        ...(part.key !== undefined ? { lane: part.key } : {}),
      }));
      const end = clock.wallNow();
      const range = { start: Math.min(Math.max(end - maxRecordingTimeMs, epoch), end), end };
      return withTimeRange(backend.snapshot(frozen), range);
    },

    clear(): void {
      backend.removeGeneration(generation);
      parts = [];
      totalBytes = 0;
      openVisual.clear();
      epoch = clock.wallNow();
      dataPart = openNewPart(epoch, 'data');
    },

    // Forwarded only when the backend HAS one, so `'flush' in store` stays an honest test for "this store
    // can commit pending writes" rather than always true and sometimes meaningless. Bound to a local so the
    // narrowing survives into the closure — TS re-widens `backend.flush` when it is called later.
    ...(backendFlush !== undefined ? { flush: (): Promise<void> => backendFlush() } : {}),
  };
}
