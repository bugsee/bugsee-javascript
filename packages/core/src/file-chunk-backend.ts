import type { FileType } from '@bugsee/protocol';
import { utf8ByteLength } from '@bugsee/util';
import { createRecordSnapshot } from './capture-snapshot';
import type { ChunkBackend, FrozenPart, PartMeta, PartRef } from './chunk-backend';
import type { ChunkStorage } from './chunk-storage';
import type { CaptureSnapshot, StoredEntry } from './contracts';

// The durable directory-style ChunkBackend (Android-parity): each part is a chunk GROUP holding a `meta`
// file (`{n,s,e,b}` — number/start/end/byteSize, written on open and rewritten on close) and one
// append-only data file per source/FileType. Records are written through as captured (loss window ≤1
// entry); part metadata is persisted (durable index → recovery, no data scan). `removePart` drops the
// whole chunk group. Realized over any sync ChunkStorage (node fs, or the in-memory fake in tests); the
// browser tier supplies the async IndexedDB equivalent.

// The reserved metadata file name within a chunk group; never a FileType, so it never collides with data.
const META_FILE = 'meta';

interface StoredMeta {
  readonly n: number;
  readonly s: number;
  readonly e: number | null;
  readonly b: number;
}

export interface FileChunkBackendOptions {
  /** Generation id (the launch epoch); namespaces this run's chunks. Default 0. */
  generation?: number;
  /** Delete other generations' leftover chunks on construction (a fresh launch). Default true. */
  cleanOtherGenerations?: boolean;
}

export function createFileChunkBackend(
  storage: ChunkStorage,
  options?: FileChunkBackendOptions,
): ChunkBackend {
  const generation = options?.generation ?? 0;

  // A fresh launch discards prior generations' leftovers (recovery — preserving them — is a later slice).
  if (options?.cleanOtherGenerations !== false) {
    for (const gen of storage.generations()) {
      if (gen !== generation) {
        storage.removeGeneration(gen);
      }
    }
  }

  const writeMeta = (
    gen: number,
    number: number,
    start: number,
    end: number | null,
    byteSize: number,
  ): void => {
    const meta: StoredMeta = { n: number, s: start, e: end, b: byteSize };
    storage.write(gen, number, META_FILE, JSON.stringify(meta));
  };

  // The part's start, kept only while it is open so closePart can rewrite a complete meta record. Keyed
  // by generation + number (the store only ever uses this backend's generation, but stay explicit).
  const openStarts = new Map<string, number>();
  const startKey = (ref: PartRef): string => `${ref.generation}/${ref.number}`;

  const readMeta = (gen: number, number: number): PartMeta => {
    const raw = storage.read(gen, number, META_FILE);
    if (raw !== undefined) {
      try {
        const m = JSON.parse(raw) as StoredMeta;
        return { generation: gen, number, start: m.s, end: m.e ?? undefined, byteSize: m.b };
      } catch {
        // fall through to the derived default below
      }
    }
    return { generation: gen, number, start: 0, end: undefined, byteSize: 0 };
  };

  return {
    generation,

    openPart(ref: PartRef, start: number): void {
      openStarts.set(startKey(ref), start);
      writeMeta(ref.generation, ref.number, start, null, 0);
    },

    appendEntry(ref: PartRef, record: StoredEntry): number {
      const encoded = `${JSON.stringify({ t: record.timestamp, s: record.serialized })}\n`;
      storage.append(ref.generation, ref.number, record.type, encoded);
      return utf8ByteLength(encoded);
    },

    closePart(ref: PartRef, end: number, byteSize: number): void {
      const start = openStarts.get(startKey(ref)) ?? readMeta(ref.generation, ref.number).start;
      openStarts.delete(startKey(ref));
      writeMeta(ref.generation, ref.number, start, end, byteSize);
      // A sealed chunk: let a batched storage flush + close its file handles (no-op otherwise), keeping the
      // open-handle count bounded to the active chunk rather than the whole rolling window.
      storage.sealChunk?.(ref.generation, ref.number);
    },

    removePart(ref: PartRef): void {
      openStarts.delete(startKey(ref));
      storage.removeChunk(ref.generation, ref.number);
    },

    removeGeneration(gen: number): void {
      storage.removeGeneration(gen);
    },

    snapshot(parts: readonly FrozenPart[]): CaptureSnapshot {
      // EAGER read at snapshot() time: the data files hold exactly the records captured so far (add is
      // sync), so reading them now freezes the view — post-snapshot appends land after and are excluded.
      const frozen: StoredEntry[] = [];
      for (const { ref } of parts) {
        for (const file of storage.files(ref.generation, ref.number)) {
          if (file === META_FILE) {
            continue;
          }
          const type = file as FileType;
          const content = storage.read(ref.generation, ref.number, file) ?? '';
          for (const line of content.split('\n')) {
            if (line === '') {
              continue;
            }
            try {
              const parsed = JSON.parse(line) as { t: number; s: string };
              frozen.push({ type, timestamp: parsed.t, serialized: parsed.s });
            } catch {
              // skip a corrupt line
            }
          }
        }
      }
      return createRecordSnapshot(frozen);
    },

    listParts(gen: number): PartMeta[] {
      return storage
        .chunks(gen)
        .sort((a, b) => a - b)
        .map((number) => readMeta(gen, number));
    },

    listGenerations(): number[] {
      return storage.generations().sort((a, b) => a - b);
    },
  };
}
