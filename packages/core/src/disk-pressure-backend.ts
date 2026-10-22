import type { FileType } from '@bugsee/protocol';
import { groupByType } from './capture-snapshot';
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
// sizes (a refused durable write included), mirrors every removal into the shadow (so memory is bounded by the same
// window and cap), and merges the two halves at snapshot time. With no pressure ever seen the shadow is empty and a
// snapshot is the durable backend's own, untouched.
//
// ORDER. A part's records of one type may have been written to either half at different moments, and timestamps
// cannot say which came first (rrweb events share milliseconds, clocks step). So once a part has a shadow record the
// wrapper remembers, per type, WHICH HALF each record went to, in append order, and the merge replays exactly that.
//
// MEMORY. A snapshot is read part by part: `stream()` holds one part's two halves at a time, and releases it before
// the next, so a report built under pressure does not buffer the whole window.
//
// PART META. A part's durable meta is created lazily, on its first durable write, and `closePart` records only the
// DURABLE bytes: recovery after a crash reads the durable half, and its recorded size must describe that half.
//
// PROBE. While the pressure is PINNED by a refused write, nothing would ever reach the medium to show it works again,
// so each `closePart` (the store's ~1 s tick) writes and removes a throwaway part: its success is what the writers
// report back (`noteWriteRecovered`) and what releases the pin.

/** The file types that stop being persisted at `low` (iOS drops video, logs and network; the JS replay is its video). */
const GATED_AT_LOW: ReadonlySet<FileType> = new Set<FileType>([
  'replay',
  'video',
  'log',
  'network',
]);

/**
 * The `capture` trace entry (a few dozen bytes) states WHY a report is empty or gapped, so it is the one record that is
 * still persisted at `none` (iOS: `bypassDiskSpaceGuard`; Android keeps a reserve level for its disk-level trace): a
 * chunk-recovered report (a native crash, an incident whose process died before upload) must be able to explain itself.
 * Recognised by its trace name; the entry is a `traces.system` record `{timestamp, data: {name, value}}`.
 */
function explainsEmptiness(record: StoredEntry): boolean {
  return record.type === 'traces.system' && record.serialized.includes('"name":"capture","value"');
}

/** The throwaway part the probe writes; far above any real part number. */
const PROBE_PART = 2_000_000_000;

export interface DiskPressureBackendOptions {
  /**
   * Called when a durable write THROWS synchronously. When given, the record is kept in the shadow, counted like any
   * other (the store's byte cap sees it) and the call returns normally; the callback owns reporting. When absent the
   * error is rethrown after the record is kept.
   */
  onWriteError?: (error: unknown) => void;
}

interface PartState {
  start: number;
  /** Whether the durable medium has this part (openPart was forwarded). */
  opened: boolean;
  durableCount: number;
  shadowCount: number;
  durableBytes: number;
  /** Durable records per type: seeds `routes` when a type first meets the shadow. */
  durableByType: Map<FileType, number>;
  /** Per type, the half (true = durable) each record went to, in append order. Only once the part is shadowed. */
  routes: Map<FileType, boolean[]>;
}

const keyOf = (ref: PartRef): string => `${ref.generation}/${ref.number}`;

/** Replays `route` over the two per-type lists; anything the route does not cover (a torn read) is appended. */
function mergeByRoute(
  durable: StoredEntry[],
  shadow: StoredEntry[],
  route: readonly boolean[],
): StoredEntry[] {
  const out: StoredEntry[] = [];
  let i = 0;
  let j = 0;
  for (const toDurable of route) {
    const next = toDurable ? durable[i++] : shadow[j++];
    if (next !== undefined) out.push(next);
  }
  while (i < durable.length) out.push(durable[i++] as StoredEntry);
  /* v8 ignore next -- unreachable by construction: every shadow record has a route bit; kept so a torn read cannot drop records. */
  while (j < shadow.length) out.push(shadow[j++] as StoredEntry);
  return out;
}

export function withDiskPressure(
  durable: ChunkBackend,
  pressure: DiskPressure,
  options: DiskPressureBackendOptions = {},
): ChunkBackend {
  const shadow = createMemoryChunkBackend({ generation: durable.generation });
  const parts = new Map<string, PartState>();
  // Parts that hold at least one shadow record: only these need a merge at snapshot time.
  let shadowed = 0;

  const persists = (record: StoredEntry): boolean => {
    const level = pressure.level();
    if (level === 'none') return explainsEmptiness(record);
    return level === 'normal' || !GATED_AT_LOW.has(record.type);
  };

  const ensureOpened = (ref: PartRef, state: PartState): void => {
    if (!state.opened) {
      durable.openPart(ref, state.start);
      state.opened = true;
    }
  };

  const routeOf = (state: PartState, type: FileType): boolean[] => {
    let route = state.routes.get(type);
    if (route === undefined) {
      route = new Array<boolean>(state.durableByType.get(type) ?? 0).fill(true);
      state.routes.set(type, route);
    }
    return route;
  };

  const toShadow = (ref: PartRef, state: PartState, record: StoredEntry): number => {
    if (state.shadowCount === 0) {
      shadowed += 1;
    }
    routeOf(state, record.type).push(false);
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

  const probe = (): void => {
    const ref: PartRef = { generation: durable.generation, number: PROBE_PART };
    try {
      durable.openPart(ref, 0);
      durable.removePart(ref);
    } catch (error) {
      options.onWriteError?.(error);
    }
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
        durableByType: new Map(),
        routes: new Map(),
      };
      parts.set(keyOf(ref), state);
      if (pressure.level() !== 'none') {
        try {
          ensureOpened(ref, state);
        } catch (error) {
          // The part's meta could not be created (no room): it stays unopened and the first durable write retries.
          options.onWriteError?.(error);
        }
      }
    },

    appendEntry(ref: PartRef, record: StoredEntry): number {
      const state = parts.get(keyOf(ref)) as PartState;
      if (persists(record)) {
        try {
          ensureOpened(ref, state);
          const size = durable.appendEntry(ref, record);
          state.durableCount += 1;
          state.durableBytes += size;
          if (state.shadowCount > 0) {
            routeOf(state, record.type).push(true);
          }
          state.durableByType.set(record.type, (state.durableByType.get(record.type) ?? 0) + 1);
          return size;
        } catch (error) {
          // A write the medium refused SYNCHRONOUSLY must not cost the in-memory window its record. The shipped writers
          // (the batched fs storage, the IndexedDB queue, the ring writer) never throw here: they buffer, report later
          // (`onWriteFailure`) and retry, which the pin and the readers' buffered tail cover. This branch is for the
          // writers that DO throw: the plain `createFsChunkStorage`, a custom ChunkBackend, a failing meta create.
          const size = toShadow(ref, state, record);
          if (options.onWriteError === undefined) {
            throw error;
          }
          options.onWriteError(error);
          return size;
        }
      }
      return toShadow(ref, state, record);
    },

    closePart(ref: PartRef, end: number): void {
      const state = parts.get(keyOf(ref)) as PartState;
      shadow.closePart(ref, end, 0);
      // Sealing is a tiny metadata write that also closes the writer's file handles, so it is done at every level (a
      // sealed part's meta must not lie about its end/size and its descriptors must not outlive it); a write that
      // fails for lack of room is the writer's to report. A part the durable medium never saw is left alone (the
      // meta would otherwise be the only thing creating it).
      if (state.opened) {
        try {
          durable.closePart(ref, end, state.durableBytes);
        } catch (error) {
          options.onWriteError?.(error); // a seal refused for lack of room must not take the tick (or the probe) with it
        }
      }
      if (pressure.pinned()) {
        probe();
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
      // The counts are the boundary of each half at THIS instant (the store's own count is their sum).
      const durableParts: FrozenPart[] = [];
      for (const { ref } of frozen) {
        durableParts.push({ ref, count: parts.get(keyOf(ref))?.durableCount ?? 0 });
      }
      if (shadowed === 0) {
        return durable.snapshot(durableParts);
      }
      // One snapshot per part and half, taken NOW (a file backend reads eagerly, so this freezes the view) but
      // DRAINED one part at a time: the IndexedDB half reads lazily, so only one part is in memory at once.
      interface FrozenPartRead {
        fromDurable: CaptureSnapshot;
        fromShadow: CaptureSnapshot | undefined;
        /** Per-type routes (append-only: records appended after this snapshot sit beyond what the frozen lists hold). */
        routes: Map<FileType, boolean[]>;
      }
      const reads: FrozenPartRead[] = frozen.map(({ ref }, index) => {
        const state = parts.get(keyOf(ref));
        const fromDurable = durable.snapshot([durableParts[index] as FrozenPart]);
        if (state === undefined || state.shadowCount === 0) {
          return { fromDurable, fromShadow: undefined, routes: new Map() };
        }
        return {
          fromDurable,
          fromShadow: shadow.snapshot([{ ref, count: state.shadowCount }]),
          routes: state.routes,
        };
      });

      const readPart = async (item: FrozenPartRead): Promise<Map<FileType, StoredEntry[]>> => {
        const d = await item.fromDurable.drainAll();
        if (item.fromShadow === undefined) {
          return d;
        }
        const s = await item.fromShadow.drainAll();
        const merged = new Map<FileType, StoredEntry[]>();
        for (const type of new Set([...d.keys(), ...s.keys()])) {
          merged.set(
            type,
            mergeByRoute(d.get(type) ?? [], s.get(type) ?? [], item.routes.get(type) ?? []),
          );
        }
        return merged;
      };
      const releasePart = (item: FrozenPartRead): void => {
        item.fromDurable.release();
        item.fromShadow?.release();
      };

      return {
        async *stream(): AsyncIterableIterator<StoredEntry> {
          for (const item of reads) {
            const records = await readPart(item);
            releasePart(item);
            for (const list of records.values()) {
              yield* list;
            }
          }
        },
        async drainAll(): Promise<Map<FileType, StoredEntry[]>> {
          const all: StoredEntry[] = [];
          for (const item of reads) {
            const records = await readPart(item);
            releasePart(item);
            for (const list of records.values()) all.push(...list);
          }
          return groupByType(all);
        },
        release(): void {
          for (const item of reads) releasePart(item);
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
