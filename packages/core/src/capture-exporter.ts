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
  onError: (error: unknown) => void = (): void => {},
): CaptureExporter {
  return {
    stream(): AsyncIterableIterator<CaptureDataEntry> {
      const snapshot = store.snapshot();
      const records = snapshot.stream();
      return (async function* (): AsyncIterableIterator<CaptureDataEntry> {
        try {
          for await (const record of records) {
            let entry: CaptureDataEntry;
            try {
              entry = reify(record, factory);
            } catch (error) {
              // A torn/un-deserializable record (e.g. a crash's torn trailing frame): skip + report it,
              // never let one bad record abort the whole export.
              onError(error);
              continue;
            }
            yield entry;
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
          const entries: CaptureDataEntry[] = [];
          for (const record of records) {
            try {
              entries.push(reify(record, factory));
            } catch (error) {
              onError(error); // skip + report a torn record; never fail the whole drain
            }
          }
          result.set(type, entries);
        }
        return result;
      } finally {
        snapshot.release();
      }
    },
  };
}
