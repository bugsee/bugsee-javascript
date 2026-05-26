import type { FileType } from '@bugsee/protocol';
import type { CaptureDataEntry, CaptureStore } from './contracts';
import { createRingBuffer, type RingBuffer } from './ring-buffer';

// In-memory CaptureStore: a bounded ring buffer per file-type. The default backend, and the only
// option on runtimes without persistent storage (lambda/edge). Node/Bun (disk) and browser
// (IndexedDB) ship their own CaptureStore implementations in the platform tiers.

export interface MemoryCaptureStoreOptions {
  /** Ring-buffer capacity for a file-type with no explicit override. Default 1000. */
  defaultCapacity?: number;
  /** Per-file-type capacity overrides (e.g. breadcrumbs: maxBreadcrumbs). */
  capacities?: Partial<Record<FileType, number>>;
}

export function createMemoryCaptureStore(options?: MemoryCaptureStoreOptions): CaptureStore {
  const defaultCapacity = options?.defaultCapacity ?? 1000;
  const capacities = options?.capacities ?? {};
  const buffers = new Map<FileType, RingBuffer<CaptureDataEntry>>();

  const bufferFor = (type: FileType): RingBuffer<CaptureDataEntry> => {
    let buffer = buffers.get(type);
    if (buffer === undefined) {
      buffer = createRingBuffer<CaptureDataEntry>(capacities[type] ?? defaultCapacity);
      buffers.set(type, buffer);
    }
    return buffer;
  };

  return {
    add(entry: CaptureDataEntry): void {
      bufferFor(entry.type).push(entry);
    },

    stream(): AsyncIterableIterator<CaptureDataEntry> {
      // Atomic snapshot: drain every buffer now (type by type), then yield from the captured list.
      const snapshot: CaptureDataEntry[] = [];
      for (const buffer of buffers.values()) {
        for (const entry of buffer.drain()) {
          snapshot.push(entry);
        }
      }
      return (async function* (): AsyncIterableIterator<CaptureDataEntry> {
        for (const entry of snapshot) {
          yield entry;
        }
      })();
    },

    drain(): Promise<Map<FileType, CaptureDataEntry[]>> {
      const result = new Map<FileType, CaptureDataEntry[]>();
      for (const [type, buffer] of buffers) {
        const entries = buffer.drain();
        if (entries.length > 0) {
          result.set(type, entries);
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
