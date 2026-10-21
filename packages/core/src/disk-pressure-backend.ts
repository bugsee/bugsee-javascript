import type { FileType } from '@bugsee/protocol';
import type { ChunkBackend, FrozenPart, PartMeta, PartRef } from './chunk-backend';
import type { CaptureSnapshot, StoredEntry } from './contracts';
import type { DiskPressure } from './disk-pressure';
import { createMemoryChunkBackend } from './memory-chunk-backend';

// The DISK-PRESSURE gate over a DURABLE ChunkBackend (spec `traces.md#capture`, JavaScript C7). Under pressure the
// durable medium stops receiving records, but they are NOT dropped: they go to an in-memory SHADOW backend, so the
// rolling window a live report reads is still complete. What is lost is durability: a crash or restart finds the
// gap the `capture` state announced.
//
//   normal : everything -> durable
//   low    : replay / log / network / video -> shadow;  everything else (traces, events, input, breadcrumbs, user
//            data, ...) -> durable
//   none   : everything -> shadow, and no new part (meta) is created on the durable medium
//
// Nothing already persisted is touched (no rewrite, no truncate): the gate only decides where the NEXT record goes.
// The store above keeps its index, window eviction and byte cap exactly as before: this wrapper returns the same
// sizes, mirrors every removal into the shadow (so memory is bounded by the same window and cap), and merges the two
// halves at snapshot time. With no pressure ever seen the shadow stays empty and a snapshot is the durable backend's
// own, untouched.
//
// PART META. A part's durable meta is created lazily, on its first durable write, and `closePart` records only the
// DURABLE bytes: recovery after a crash reads the durable half, and its recorded size must describe that half.

/** The file types that stop being persisted at `low` (iOS drops video, logs and network; the JS replay is its video). */
const GATED_AT_LOW: ReadonlySet<FileType> = new Set<FileType>([
  'replay',
  'video',
  'log',
  'network',
]);

interface PartState {
  start: number;
  /** Whether the durable medium has this part (openPart was forwarded). */
  opened: boolean;
  durableCount: number;
  shadowCount: number;
  durableBytes: number;
}

const keyOf = (ref: PartRef): string => `${ref.generation}/${ref.number}`;

/** Stable merge of two oldest-first lists by timestamp; on a tie the durable (earlier-written) one goes first. */
function mergeByTimestamp(durable: StoredEntry[], shadow: StoredEntry[]): StoredEntry[] {
  const out: StoredEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < durable.length && j < shadow.length) {
    if ((shadow[j] as StoredEntry).timestamp < (durable[i] as StoredEntry).timestamp) {
      out.push(shadow[j++] as StoredEntry);
    } else {
      out.push(durable[i++] as StoredEntry);
    }
  }
  while (i < durable.length) out.push(durable[i++] as StoredEntry);
  while (j < shadow.length) out.push(shadow[j++] as StoredEntry);
  return out;
}

export function withDiskPressure(durable: ChunkBackend, pressure: DiskPressure): ChunkBackend {
  const shadow = createMemoryChunkBackend({ generation: durable.generation });
  const parts = new Map<string, PartState>();
  // Parts that hold at least one shadow record: only these need a merge at snapshot time.
  let shadowed = 0;

  const persists = (type: FileType): boolean => {
    const level = pressure.level();
    if (level === 'none') return false;
    return level === 'normal' || !GATED_AT_LOW.has(type);
  };

  const ensureOpened = (ref: PartRef, state: PartState): void => {
    if (!state.opened) {
      durable.openPart(ref, state.start);
      state.opened = true;
    }
  };

  const toShadow = (ref: PartRef, state: PartState, record: StoredEntry): number => {
    if (state.shadowCount === 0) {
      shadowed += 1;
    }
    state.shadowCount += 1;
    return shadow.appendEntry(ref, record);
  };

  const forget = (key: string): void => {
    const state = parts.get(key);
    if (state !== undefined && state.shadowCount > 0) {
      shadowed -= 1;
    }
    parts.delete(key);
  };

  const wrapped: ChunkBackend = {
    generation: durable.generation,

    openPart(ref: PartRef, start: number): void {
      shadow.openPart(ref, start);
      const state: PartState = {
        start,
        opened: false,
        durableCount: 0,
        shadowCount: 0,
        durableBytes: 0,
      };
      parts.set(keyOf(ref), state);
      if (pressure.level() !== 'none') {
        ensureOpened(ref, state);
      }
    },

    appendEntry(ref: PartRef, record: StoredEntry): number {
      const state = parts.get(keyOf(ref)) as PartState;
      if (persists(record.type)) {
        try {
          ensureOpened(ref, state);
          const size = durable.appendEntry(ref, record);
          state.durableCount += 1;
          state.durableBytes += size;
          return size;
        } catch (error) {
          // A write the medium refused (out of space, ...) must not cost the in-memory window its record: keep
          // it in the shadow, then let the failure surface (the aggregator reports it; the platform's reporter
          // feeds `DiskPressure.noteWriteError`).
          toShadow(ref, state, record);
          throw error;
        }
      }
      return toShadow(ref, state, record);
    },

    closePart(ref: PartRef, end: number): void {
      const state = parts.get(keyOf(ref)) as PartState;
      shadow.closePart(ref, end, 0);
      // Sealing is a small metadata write: skipped while there is no room, and for a part the durable medium
      // never saw (its meta would otherwise be the only thing creating it).
      if (state.opened && pressure.level() !== 'none') {
        durable.closePart(ref, end, state.durableBytes);
      }
    },

    removePart(ref: PartRef): void {
      const key = keyOf(ref);
      const state = parts.get(key) as PartState;
      shadow.removePart(ref);
      forget(key);
      // Removal frees space, so it is always forwarded (a part the durable medium never saw has nothing there).
      if (state.opened) {
        durable.removePart(ref);
      }
    },

    removeGeneration(generation: number): void {
      shadow.removeGeneration(generation);
      for (const key of [...parts.keys()]) {
        if (key.startsWith(`${generation}/`)) {
          forget(key);
        }
      }
      durable.removeGeneration(generation);
    },

    snapshot(frozen: readonly FrozenPart[]): CaptureSnapshot {
      const durableParts: FrozenPart[] = [];
      const shadowParts: FrozenPart[] = [];
      for (const { ref } of frozen) {
        const state = parts.get(keyOf(ref));
        // The counts are the boundary of each half at THIS instant (the store's own count is their sum).
        durableParts.push({ ref, count: state?.durableCount ?? 0 });
        shadowParts.push({ ref, count: state?.shadowCount ?? 0 });
      }
      if (shadowed === 0) {
        return durable.snapshot(durableParts);
      }
      const fromDurable = durable.snapshot(durableParts);
      const fromShadow = shadow.snapshot(shadowParts);
      const read = async (): Promise<Map<FileType, StoredEntry[]>> => {
        const [d, s] = await Promise.all([fromDurable.drainAll(), fromShadow.drainAll()]);
        const merged = new Map<FileType, StoredEntry[]>();
        for (const type of new Set([...d.keys(), ...s.keys()])) {
          merged.set(type, mergeByTimestamp(d.get(type) ?? [], s.get(type) ?? []));
        }
        return merged;
      };
      return {
        async *stream(): AsyncIterableIterator<StoredEntry> {
          for (const records of (await read()).values()) {
            yield* records;
          }
        },
        drainAll: read,
        release(): void {
          fromDurable.release();
          fromShadow.release();
        },
      };
    },

    listParts: (generation: number): PartMeta[] | Promise<PartMeta[]> =>
      durable.listParts(generation),
    listGenerations: (): number[] | Promise<number[]> => durable.listGenerations(),
  };

  const flush = durable.flush?.bind(durable);
  if (flush !== undefined) {
    wrapped.flush = (): Promise<void> => flush();
  }
  return wrapped;
}
