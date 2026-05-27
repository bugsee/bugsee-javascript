import type { FileType } from '@bugsee/protocol';
import type { CaptureSnapshot, StoredEntry } from './contracts';

// A frozen, in-memory CaptureSnapshot over a flat list of records — shared by the part-based stores
// (the memory store flattens its live parts; the file store reads its in-window chunk-files). Records
// are immutable, so a flat copy of refs is enough to divorce the snapshot from the still-rolling live
// store. release() drops the copy (subsequent reads yield nothing).

export function groupByType(records: readonly StoredEntry[]): Map<FileType, StoredEntry[]> {
  const map = new Map<FileType, StoredEntry[]>();
  for (const record of records) {
    const list = map.get(record.type);
    if (list === undefined) {
      map.set(record.type, [record]);
    } else {
      list.push(record);
    }
  }
  return map;
}

export function createRecordSnapshot(records: StoredEntry[]): CaptureSnapshot {
  let frozen: StoredEntry[] | null = records;
  return {
    stream(): AsyncIterableIterator<StoredEntry> {
      const data = frozen ?? [];
      return (async function* (): AsyncIterableIterator<StoredEntry> {
        for (const record of data) {
          yield record;
        }
      })();
    },
    drainAll(): Promise<Map<FileType, StoredEntry[]>> {
      return Promise.resolve(groupByType(frozen ?? []));
    },
    release(): void {
      frozen = null;
    },
  };
}
