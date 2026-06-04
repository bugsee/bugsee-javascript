import { utf8ByteLength } from '@bugsee/util';
import { createRecordSnapshot } from './capture-snapshot';
import type { ChunkBackend, FrozenPart, PartMeta, PartRef } from './chunk-backend';
import type { CaptureSnapshot, StoredEntry } from './contracts';

// In-memory ChunkBackend — the ephemeral default (lambda/edge; no persistent medium to spill to, so
// the data lives in RAM). Stores each part's records as a flat append-ordered list (interleaved types,
// matching the historical memory store) keyed by `<generation>/<number>`; snapshot() EAGER-copies the
// frozen records (records are immutable, so the copy is isolated from the still-rolling live store and
// survives later eviction — preserving the prior createMemoryCaptureStore semantics exactly).

const key = (ref: PartRef): string => `${ref.generation}/${ref.number}`;

export interface MemoryChunkBackendOptions {
  /** Generation id; moot for the ephemeral store (no persistence). Default 0. */
  generation?: number;
}

export function createMemoryChunkBackend(options?: MemoryChunkBackendOptions): ChunkBackend {
  const generation = options?.generation ?? 0;
  const data = new Map<string, StoredEntry[]>();
  const meta = new Map<string, PartMeta>();

  return {
    generation,

    openPart(ref: PartRef, start: number): void {
      data.set(key(ref), []);
      meta.set(key(ref), {
        generation: ref.generation,
        number: ref.number,
        start,
        end: undefined,
        byteSize: 0,
      });
    },

    appendEntry(ref: PartRef, record: StoredEntry): number {
      data.get(key(ref))?.push(record);
      return utf8ByteLength(record.serialized);
    },

    closePart(ref: PartRef, end: number, byteSize: number): void {
      const existing = meta.get(key(ref));
      if (existing !== undefined) {
        meta.set(key(ref), { ...existing, end, byteSize });
      }
    },

    removePart(ref: PartRef): void {
      data.delete(key(ref));
      meta.delete(key(ref));
    },

    removeGeneration(gen: number): void {
      const prefix = `${gen}/`;
      for (const k of [...data.keys()]) {
        if (k.startsWith(prefix)) {
          data.delete(k);
        }
      }
      for (const k of [...meta.keys()]) {
        if (k.startsWith(prefix)) {
          meta.delete(k);
        }
      }
    },

    snapshot(parts: readonly FrozenPart[]): CaptureSnapshot {
      const frozen: StoredEntry[] = [];
      for (const { ref, count } of parts) {
        const records = data.get(key(ref));
        if (records !== undefined) {
          for (let i = 0; i < count && i < records.length; i += 1) {
            frozen.push(records[i] as StoredEntry);
          }
        }
      }
      return createRecordSnapshot(frozen);
    },

    listParts(gen: number): PartMeta[] {
      return [...meta.values()]
        .filter((part) => part.generation === gen)
        .sort((a, b) => a.number - b.number);
    },

    listGenerations(): number[] {
      return [...new Set([...meta.values()].map((part) => part.generation))].sort((a, b) => a - b);
    },
  };
}
