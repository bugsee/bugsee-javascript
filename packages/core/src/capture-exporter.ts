import type { FileType } from '@bugsee/protocol';
import { defaultEntryFactory } from './capture-data-entry';
import type {
  CaptureDataEntry,
  CaptureEntryFactory,
  CaptureExporter,
  CaptureStore,
  StoredEntry,
} from './contracts';

// CaptureExporter (Android CaptureExporter parity): the read side of the capture pipeline. It takes a
// CaptureSnapshot of the store — a frozen view divorced from the live rolling window, so capture
// keeps writing during export — reads the snapshot's records, reconstructs entries (factory(type) +
// instance deserialize), and RELEASES the snapshot when done (try/finally). stream() reads one-by-one
// (memory-light); drain() reads all-at-once grouped by file type. The aggregator writes; the exporter
// reads — the two directions are separate (Android-derived §16).

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
      const snapshot = store.snapshot();
      const records = snapshot.stream();
      return (async function* (): AsyncIterableIterator<CaptureDataEntry> {
        try {
          for await (const record of records) {
            yield reify(record, factory);
          }
        } finally {
          snapshot.release();
        }
      })();
    },

    async drain(): Promise<Map<FileType, CaptureDataEntry[]>> {
      const snapshot = store.snapshot();
      try {
        const raw = await snapshot.drainAll();
        const result = new Map<FileType, CaptureDataEntry[]>();
        for (const [type, records] of raw) {
          result.set(
            type,
            records.map((record) => reify(record, factory)),
          );
        }
        return result;
      } finally {
        snapshot.release();
      }
    },
  };
}
