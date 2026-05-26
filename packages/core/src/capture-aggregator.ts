import type { CaptureAggregator, CaptureDataEntry, CaptureStore } from './contracts';

// The single data adapter every provider feeds (Android BugseeCaptureAggregator parity, design §7.7).
// It is a thin, store-agnostic router: providers push entries here and the aggregator supplies them
// to the configurable CaptureStore (in-memory / disk / IndexedDB). snapshot() reads + clears the
// store at trigger time (async, so disk/IndexedDB backends fit).

export function createCaptureAggregator(store: CaptureStore): CaptureAggregator {
  return {
    addEntry(entry: CaptureDataEntry): void {
      store.add(entry);
    },
    addEntries(entries: readonly CaptureDataEntry[]): void {
      for (const entry of entries) {
        store.add(entry);
      }
    },
    stream(): AsyncIterableIterator<CaptureDataEntry> {
      return store.stream();
    },
    snapshot(): Promise<Map<CaptureDataEntry['type'], CaptureDataEntry[]>> {
      return store.drain();
    },
    clear(): void {
      store.clear();
    },
  };
}
