import type { FileType } from '@bugsee/protocol';
import type { CaptureStore, FileStorageAdapter, StoredEntry } from './contracts';

// File-backed CaptureStore LOGIC, shared by every file-based runtime (node/bun/deno/electron-main).
// Only the FileStorageAdapter primitive is platform-specific (node:fs / Deno.* / …) — this layout
// (one append-only JSONL stream per file type, read-back + per-type capacity on export) is identical
// everywhere, so it lives in core (mirrors how createMemoryCaptureStore and the transport impls are
// shared). The store owns the record↔line encoding; the adapter just appends/reads/lists/removes.

export interface FileCaptureStoreOptions {
  /** Newest-N kept per file-type with no explicit override. Default Infinity (unbounded). */
  defaultCapacity?: number;
  /** Per-file-type capacity overrides (e.g. breadcrumbs: maxBreadcrumbs). */
  capacities?: Partial<Record<FileType, number>>;
}

interface Line {
  t: number;
  s: string;
}

export function createFileCaptureStore(
  adapter: FileStorageAdapter,
  options?: FileCaptureStoreOptions,
): CaptureStore {
  const defaultCapacity = options?.defaultCapacity ?? Number.POSITIVE_INFINITY;
  const capacities = options?.capacities ?? {};

  const encode = (record: StoredEntry): string =>
    `${JSON.stringify({ t: record.timestamp, s: record.serialized })}\n`;

  // Parse a stream's text into records for `type`, keeping only the newest `capacity` (corrupt or
  // truncated lines — e.g. a partial write — are skipped).
  const recordsOf = (type: FileType, text: string): StoredEntry[] => {
    const records: StoredEntry[] = [];
    for (const line of text.split('\n')) {
      // Skip blank lines (incl. the trailing newline's empty tail) and any corrupt/truncated line —
      // JSON.parse throws on all of them.
      let parsed: Line;
      try {
        parsed = JSON.parse(line) as Line;
      } catch {
        continue;
      }
      records.push({ type, timestamp: parsed.t, serialized: parsed.s });
    }
    const capacity = capacities[type] ?? defaultCapacity;
    return records.length > capacity ? records.slice(records.length - capacity) : records;
  };

  return {
    add(record: StoredEntry): void {
      adapter.append(record.type, encode(record));
    },

    stream(): AsyncIterableIterator<StoredEntry> {
      const names = adapter.names();
      return (async function* (): AsyncIterableIterator<StoredEntry> {
        // Memory-light: read + clear one stream at a time, yielding its records before the next.
        for (const name of names) {
          const text = adapter.read(name) ?? '';
          adapter.remove(name);
          for (const record of recordsOf(name as FileType, text)) {
            yield record;
          }
        }
      })();
    },

    drainAll(): Promise<Map<FileType, StoredEntry[]>> {
      const result = new Map<FileType, StoredEntry[]>();
      for (const name of adapter.names()) {
        const text = adapter.read(name) ?? '';
        adapter.remove(name);
        const records = recordsOf(name as FileType, text);
        if (records.length > 0) {
          result.set(name as FileType, records);
        }
      }
      return Promise.resolve(result);
    },

    clear(): void {
      for (const name of adapter.names()) {
        adapter.remove(name);
      }
    },
  };
}
