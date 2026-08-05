import {
  type CaptureSnapshot,
  type CaptureStore,
  type ChunkBackend,
  type ChunkCaptureStoreOptions,
  createChunkCaptureStore,
  createSystemClock,
  type FrozenPart,
  type PartMeta,
  type PartRef,
  type StoredEntry,
} from '@bugsee/core';
import type { FileType } from '@bugsee/protocol';
import { utf8ByteLength } from '@bugsee/util';
import type { AsyncKeyedStore } from './idb';

// The durable IndexedDB ChunkBackend — the browser's persistent capture store, done durable-as-captured
// (replacing B5b's in-memory mirror that lost the open chunk on an unpredicted termination). It is the
// SAME chunk-group model as the file backend, over async keyed records instead of directories:
//   data entry  →  key `d/<gen13>/<chunk12>/<seq12>`  value {t,s,ty}  (one put PER captured entry)
//   chunk meta  →  key `m/<gen13>/<chunk12>`          value {n,s,e,b} (written on open, rewritten close)
// Writes are SYNC-ISSUE / ASYNC-COMPLETE: every openPart/appendEntry/closePart/removePart/removeGeneration
// enqueues onto a single in-order write queue and returns void, so CaptureStore.add/tick stay sync and the
// loss window on a crash is ≤1 entry (vs the whole open chunk). Reads are async: snapshot() PINS the
// frozen parts (so eviction can't delete them mid-read), then reads each part's data range bounded by the
// snapshot-time count; listParts/listGenerations read the durable meta records (no data scan) — the
// recovery index. Queue failures route to onError and never throw the capture path.

const GEN_PAD = 13;
const CHUNK_PAD = 12;
const SEQ_PAD = 12;
const pad = (value: number, width: number): string => String(value).padStart(width, '0');

const metaKey = (gen: number, chunk: number): string =>
  `m/${pad(gen, GEN_PAD)}/${pad(chunk, CHUNK_PAD)}`;
const metaGenPrefix = (gen: number): string => `m/${pad(gen, GEN_PAD)}/`;
const dataPrefix = (gen: number, chunk: number): string =>
  `d/${pad(gen, GEN_PAD)}/${pad(chunk, CHUNK_PAD)}/`;
const dataGenPrefix = (gen: number): string => `d/${pad(gen, GEN_PAD)}/`;
const dataKey = (gen: number, chunk: number, seq: number): string =>
  `${dataPrefix(gen, chunk)}${pad(seq, SEQ_PAD)}`;
// The generation embedded in a meta key `m/<gen>/<chunk>` — parsed by separator (not a fixed width),
// so a generation wider than GEN_PAD (≥1e13 ms / an injected large id) is not truncated.
const genOfMetaKey = (key: string): number => Number(key.slice(2, key.indexOf('/', 2)));
// The chunk number embedded in a meta key `m/<gen>/<chunk>`. The KEY survives a corrupt VALUE, so this is
// how a chunk whose meta failed to parse keeps its identity (Wave 6.5).
const numberOfMetaKey = (key: string): number | undefined => {
  const n = Number(key.slice(key.indexOf('/', 2) + 1));
  return Number.isInteger(n) ? n : undefined;
};

interface StoredMeta {
  readonly n: number;
  readonly s: number;
  readonly e: number | null;
  readonly b: number;
}
interface StoredData {
  readonly t: number;
  readonly s: string;
  readonly ty: FileType;
}

const enc = (value: StoredMeta | StoredData): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
/**
 * Decode one stored record, or `undefined` if it is unreadable (Wave 6.5).
 *
 * A bare `JSON.parse` here made ONE corrupt value reject `listParts()` / `drainAll()` for the whole
 * generation, taking every intact record with it — and permanently: capture-recovery catches per
 * generation and does NOT remove the marker, so the generation stays pending, the sweep keeps it, and the
 * next launch fails identically, forever, with the poisoned data never freed.
 *
 * Core designed against exactly this and the IDB port dropped the guard. `capture-drain.ts:24-30`: "Skip
 * it; NEVER let one bad record poison the whole generation's recovery". `file-chunk-backend.ts:66-69`
 * falls back to a derived meta; `:128`/`:133` skip a torn line. This restores the same contract.
 *
 * Triggers are not exotic: a `getAll`/`getAllKeys` length mismatch (the `as Uint8Array` cast hides the
 * hole, and `TextDecoder().decode(undefined)` yields `''`, which `JSON.parse` rejects), storage-layer
 * corruption, and envelope-schema drift on the dead-sibling path — which by construction reads data a
 * DIFFERENT build wrote.
 */
const dec = <T>(bytes: Uint8Array | undefined): T | undefined => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
};

const groupByType = (records: readonly StoredEntry[]): Map<FileType, StoredEntry[]> => {
  const grouped = new Map<FileType, StoredEntry[]>();
  for (const record of records) {
    const list = grouped.get(record.type);
    if (list === undefined) {
      grouped.set(record.type, [record]);
    } else {
      list.push(record);
    }
  }
  return grouped;
};

export interface IdbChunkBackendOptions {
  /** This launch's generation id (groups its chunks). */
  generation: number;
  /** On construction, delete OTHER generations' leftover chunks (prior launches). Default true. */
  cleanOtherGenerations?: boolean;
  /** Failure sink for the async write queue. Default no-op. */
  onError?: (error: unknown) => void;
}

export function createIdbChunkBackend(
  store: AsyncKeyedStore,
  options: IdbChunkBackendOptions,
): ChunkBackend {
  const generation = options.generation;
  const onError = options.onError ?? ((): void => {});

  // The in-order async write queue. Each op runs after the previous settles; a failure routes to onError
  // and the chain continues (capture never blocks or throws).
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (op: () => Promise<unknown>): void => {
    queue = queue.then(op).catch(onError);
  };

  const chunkKey = (ref: PartRef): string => `${ref.generation}/${ref.number}`;
  const openStarts = new Map<string, number>(); // chunkKey → start, for the closePart meta rewrite
  const seqByChunk = new Map<string, number>(); // chunkKey → next data sequence number

  // Snapshot pinning: a part pinned by ≥1 live snapshot is not physically deleted until released.
  const pins = new Map<string, number>(); // chunkKey → active snapshot refcount
  const deferredDelete = new Set<string>(); // chunkKey → delete once unpinned

  const deleteChunk = (gen: number, number: number): void => {
    enqueue(() => store.deletePrefix(dataPrefix(gen, number)));
    enqueue(() => store.deletePrefix(metaKey(gen, number))); // padded → an exact single key
  };

  const writeMeta = (
    gen: number,
    number: number,
    start: number,
    end: number | null,
    byteSize: number,
  ): void => {
    enqueue(() =>
      store.put(metaKey(gen, number), enc({ n: number, s: start, e: end, b: byteSize })),
    );
  };

  // A fresh launch discards prior generations' leftovers (recovery — preserving them — is a later slice).
  if (options.cleanOtherGenerations !== false) {
    enqueue(async () => {
      const metas = await store.readPrefix('m/');
      const gens = new Set<number>();
      for (const [key] of metas) {
        const gen = genOfMetaKey(key);
        if (Number.isInteger(gen) && gen !== generation) {
          gens.add(gen);
        }
      }
      for (const gen of gens) {
        await store.deletePrefix(dataGenPrefix(gen));
        await store.deletePrefix(metaGenPrefix(gen));
      }
    });
  }

  // Read a generation's durable part metadata. The PartMeta is tagged with the QUERIED gen (this is the
  // recovery seam — it reads any generation, not only this backend's own).
  const readMetas = (gen: number): Promise<PartMeta[]> =>
    queue
      .then(() => store.readPrefix(metaGenPrefix(gen)))
      .then((entries) =>
        entries
          .map(([key, bytes], index) => {
            const m = dec<StoredMeta>(bytes);
            if (m === undefined) {
              // The chunk is KEPT with a derived default, not dropped — it still has data, and dropping
              // its meta would orphan those records where nothing reads or frees them. Same choice core
              // makes at file-chunk-backend.ts:66-69. The number comes from the key, which is intact.
              return {
                generation: gen,
                number: numberOfMetaKey(key) ?? index,
                start: 0,
                end: undefined,
                byteSize: 0,
              };
            }
            return {
              generation: gen,
              number: m.n,
              start: m.s,
              end: m.e ?? undefined,
              byteSize: m.b,
            };
          })
          .sort((a, b) => a.number - b.number),
      );

  return {
    generation,

    openPart(ref: PartRef, start: number): void {
      openStarts.set(chunkKey(ref), start);
      seqByChunk.set(chunkKey(ref), 0);
      writeMeta(ref.generation, ref.number, start, null, 0);
    },

    appendEntry(ref: PartRef, record: StoredEntry): number {
      const key = chunkKey(ref);
      const seq = seqByChunk.get(key) ?? 0;
      seqByChunk.set(key, seq + 1);
      const data: StoredData = { t: record.timestamp, s: record.serialized, ty: record.type };
      enqueue(() => store.put(dataKey(ref.generation, ref.number, seq), enc(data)));
      return utf8ByteLength(record.serialized);
    },

    closePart(ref: PartRef, end: number, byteSize: number): void {
      const key = chunkKey(ref);
      const start = openStarts.get(key) ?? 0;
      openStarts.delete(key);
      writeMeta(ref.generation, ref.number, start, end, byteSize);
    },

    removePart(ref: PartRef): void {
      const key = chunkKey(ref);
      openStarts.delete(key);
      seqByChunk.delete(key);
      if ((pins.get(key) ?? 0) > 0) {
        deferredDelete.add(key); // a live snapshot still needs the data
      } else {
        deleteChunk(ref.generation, ref.number);
      }
    },

    removeGeneration(gen: number): void {
      enqueue(() => store.deletePrefix(dataGenPrefix(gen)));
      enqueue(() => store.deletePrefix(metaGenPrefix(gen)));
    },

    snapshot(parts: readonly FrozenPart[]): CaptureSnapshot {
      const frozen = [...parts];
      const frozenQueue = queue; // every write up to now must land before the read
      for (const { ref } of frozen) {
        const key = chunkKey(ref);
        pins.set(key, (pins.get(key) ?? 0) + 1);
      }

      const readAll = async (): Promise<StoredEntry[]> => {
        await frozenQueue;
        const out: StoredEntry[] = [];
        for (const { ref, count } of frozen) {
          const records = await store.readPrefix(dataPrefix(ref.generation, ref.number));
          for (let i = 0; i < count && i < records.length; i += 1) {
            const d = dec<StoredData>((records[i] as [string, Uint8Array])[1]);
            if (d === undefined) {
              continue; // one torn envelope loses ONE record, never the generation
            }
            out.push({ type: d.ty, timestamp: d.t, serialized: d.s });
          }
        }
        return out;
      };

      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        for (const { ref } of frozen) {
          const key = chunkKey(ref);
          // The part was pinned at snapshot() time, so pins.get is defined here.
          const remaining = (pins.get(key) as number) - 1;
          if (remaining <= 0) {
            pins.delete(key);
            if (deferredDelete.has(key)) {
              deferredDelete.delete(key);
              deleteChunk(ref.generation, ref.number);
            }
          } else {
            pins.set(key, remaining);
          }
        }
      };

      return {
        async *stream(): AsyncIterableIterator<StoredEntry> {
          for (const record of await readAll()) {
            yield record;
          }
        },
        async drainAll(): Promise<Map<FileType, StoredEntry[]>> {
          return groupByType(await readAll());
        },
        release,
      };
    },

    listParts(gen: number): Promise<PartMeta[]> {
      return readMetas(gen);
    },

    // Wave 6.2 — the commit seam the page-hide hook awaits. Chaining on `queue` is the whole
    // implementation: every write is already a link in it, so waiting for the tail waits for all of them.
    // It resolves rather than rejects — each link already routes its own failure to `onError`, and a page
    // that is going away can do nothing with a rejection anyway.
    flush(): Promise<void> {
      return queue.then(
        () => undefined,
        () => undefined,
      );
    },

    listGenerations(): Promise<number[]> {
      return queue
        .then(() => store.readPrefix('m/'))
        .then((entries) => {
          const gens = new Set<number>();
          for (const [key] of entries) {
            const gen = genOfMetaKey(key);
            if (Number.isInteger(gen)) {
              gens.add(gen);
            }
          }
          return [...gens].sort((a, b) => a - b);
        });
    },
  };
}

export interface IdbChunkCaptureStoreOptions extends ChunkCaptureStoreOptions {
  /** This launch's generation id. Default clock.wallNow() at construction. */
  generation?: number;
  /** On construction, delete OTHER generations' leftover chunks (prior launches). Default true. */
  cleanOtherGenerations?: boolean;
  /** Failure sink for the async write queue. Default no-op. */
  onError?: (error: unknown) => void;
}

/** The durable IndexedDB CaptureStore: the chunk store over {@link createIdbChunkBackend}. */
export function createIdbChunkCaptureStore(
  store: AsyncKeyedStore,
  options?: IdbChunkCaptureStoreOptions,
): CaptureStore {
  const clock = options?.clock ?? createSystemClock();
  const generation = options?.generation ?? clock.wallNow();
  const backend = createIdbChunkBackend(store, {
    generation,
    cleanOtherGenerations: options?.cleanOtherGenerations,
    onError: options?.onError,
  });
  return createChunkCaptureStore(backend, {
    maxRecordingTimeMs: options?.maxRecordingTimeMs,
    maxDataSizeBytes: options?.maxDataSizeBytes,
    clock,
  });
}
