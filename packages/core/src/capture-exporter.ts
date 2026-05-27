import type { FileType } from '@bugsee/protocol';
import { defaultEntryFactory } from './capture-data-entry';
import type {
  CaptureDataEntry,
  CaptureEntryFactory,
  CaptureExporter,
  CaptureStore,
  StoredEntry,
} from './contracts';

// CaptureExporter (Android CaptureExporter / CaptureDataEntryStreamReader parity): the read side of
// the capture pipeline. It drains the store's serialized records and reconstructs entries by creating
// an empty entry of the record's type (via the CaptureEntryFactory) and calling its deserialize().
// stream() reads one-by-one (memory-light); drain() reads all-at-once grouped by file type. The
// aggregator writes; the exporter reads — the two directions are separate (Android-derived §16).

function reify(record: StoredEntry, factory: CaptureEntryFactory): CaptureDataEntry {
  const entry = factory(record.type);
  entry.deserialize(record.serialized);
  return entry;
}

export function createCaptureExporter(
  store: CaptureStore,
  factory: CaptureEntryFactory = defaultEntryFactory,
): CaptureExporter {
  return {
    stream(): AsyncIterableIterator<CaptureDataEntry> {
      const records = store.stream();
      return (async function* (): AsyncIterableIterator<CaptureDataEntry> {
        for await (const record of records) {
          yield reify(record, factory);
        }
      })();
    },

    async drain(): Promise<Map<FileType, CaptureDataEntry[]>> {
      const raw = await store.drainAll();
      const result = new Map<FileType, CaptureDataEntry[]>();
      for (const [type, records] of raw) {
        result.set(
          type,
          records.map((record) => reify(record, factory)),
        );
      }
      return result;
    },
  };
}
