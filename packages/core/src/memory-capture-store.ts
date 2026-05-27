import type { FileType } from '@bugsee/protocol';
import type { CaptureStore, StoredEntry } from './contracts';
import { createRingBuffer, type RingBuffer } from './ring-buffer';

// In-memory CaptureStore: a bounded ring buffer per file-type holding serialized records. The default
// backend, and the only option on runtimes without persistent storage (lambda/edge). Node/Bun (disk)
// and browser (IndexedDB) ship their own CaptureStore implementations in the platform tiers. The
// store deals only in serialized StoredEntry records — the aggregator serializes on the way in, the
// CaptureExporter deserializes on the way out.

export interface MemoryCaptureStoreOptions {
  /** Ring-buffer capacity for a file-type with no explicit override. Default 1000. */
  defaultCapacity?: number;
  /** Per-file-type capacity overrides (e.g. breadcrumbs: maxBreadcrumbs). */
  capacities?: Partial<Record<FileType, number>>;
}

export function createMemoryCaptureStore(options?: MemoryCaptureStoreOptions): CaptureStore {
  const defaultCapacity = options?.defaultCapacity ?? 1000;
  const capacities = options?.capacities ?? {};
  const buffers = new Map<FileType, RingBuffer<StoredEntry>>();

  const bufferFor = (type: FileType): RingBuffer<StoredEntry> => {
    let buffer = buffers.get(type);
    if (buffer === undefined) {
      buffer = createRingBuffer<StoredEntry>(capacities[type] ?? defaultCapacity);
      buffers.set(type, buffer);
    }
    return buffer;
  };

  return {
    add(record: StoredEntry): void {
      bufferFor(record.type).push(record);
    },

    stream(): AsyncIterableIterator<StoredEntry> {
      // Atomic snapshot: drain every buffer now (type by type), then yield from the captured list.
      const snapshot: StoredEntry[] = [];
      for (const buffer of buffers.values()) {
        for (const record of buffer.drain()) {
          snapshot.push(record);
        }
      }
      return (async function* (): AsyncIterableIterator<StoredEntry> {
        for (const record of snapshot) {
          yield record;
        }
      })();
    },

    drainAll(): Promise<Map<FileType, StoredEntry[]>> {
      const result = new Map<FileType, StoredEntry[]>();
      for (const [type, buffer] of buffers) {
        const records = buffer.drain();
        if (records.length > 0) {
          result.set(type, records);
        }
      }
      return Promise.resolve(result);
    },

    clear(): void {
      for (const buffer of buffers.values()) {
        buffer.clear();
      }
    },
  };
}
