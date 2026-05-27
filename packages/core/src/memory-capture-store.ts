import type { FileType } from '@bugsee/protocol';
import { type Clock, createSystemClock } from './clock';
import type { CaptureStore, StoredEntry } from './contracts';
import { createRingBuffer, type RingBuffer } from './ring-buffer';

// In-memory CaptureStore: a bounded ring buffer per file-type holding serialized records. The default
// backend, and the only option on runtimes without persistent storage (lambda/edge). Retention is
// TIME-based (design `maxRecordingTime`, default 60s — the bundle is the last N seconds, matching
// Android): the recording window is applied at READ time, now-relative — drain/stream drop records
// older than `now - maxRecordingTime`, so an idle-then-trigger bundle is still the last N seconds.
// `defaultCapacity` is the count safety bound that caps memory between reads (burst protection);
// breadcrumbs use a count cap (maxBreadcrumbs) via `capacities`. Node/Bun (disk) and browser
// (IndexedDB) ship their own stores.

export interface MemoryCaptureStoreOptions {
  /** Count safety cap per file-type with no override (burst bound on top of the time window). Default 1000. */
  defaultCapacity?: number;
  /** Per-file-type count caps (e.g. breadcrumbs: maxBreadcrumbs). */
  capacities?: Partial<Record<FileType, number>>;
  /** Time-window retention in ms (design maxRecordingTime): keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /** Time source for the retention window; injectable for tests. Default system clock. */
  clock?: Clock;
}

export function createMemoryCaptureStore(options?: MemoryCaptureStoreOptions): CaptureStore {
  const defaultCapacity = options?.defaultCapacity ?? 1000;
  const capacities = options?.capacities ?? {};
  const maxRecordingTimeMs = options?.maxRecordingTimeMs ?? 60_000;
  const clock = options?.clock ?? createSystemClock();
  const buffers = new Map<FileType, RingBuffer<StoredEntry>>();

  /** Records with a timestamp below this are out of the recording window. */
  const cutoff = (): number => clock.wallNow() - maxRecordingTimeMs;

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
      // Push (count-capped by the ring buffer); the time window is applied at read time (below).
      bufferFor(record.type).push(record);
    },

    stream(): AsyncIterableIterator<StoredEntry> {
      // Atomic snapshot: drain every buffer now, keeping only records still within the window.
      const oldest = cutoff();
      const snapshot: StoredEntry[] = [];
      for (const buffer of buffers.values()) {
        for (const record of buffer.drain()) {
          if (record.timestamp >= oldest) {
            snapshot.push(record);
          }
        }
      }
      return (async function* (): AsyncIterableIterator<StoredEntry> {
        for (const record of snapshot) {
          yield record;
        }
      })();
    },

    drainAll(): Promise<Map<FileType, StoredEntry[]>> {
      const oldest = cutoff();
      const result = new Map<FileType, StoredEntry[]>();
      for (const [type, buffer] of buffers) {
        const records = buffer.drain().filter((record) => record.timestamp >= oldest);
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
