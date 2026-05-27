import type { CaptureAggregator, CaptureDataEntry, CaptureStore } from './contracts';

// The single data adapter every provider feeds (Android BugseeCaptureAggregator parity, design §7.7).
// Data flows ONE direction: accept an entry → transform (entry.serialize()) → route the serialized
// record to the configurable CaptureStore (in-memory / disk / IndexedDB). Read-back is NOT here —
// it belongs to the CaptureExporter (capture-exporter.ts).

export function createCaptureAggregator(store: CaptureStore): CaptureAggregator {
  const route = (entry: CaptureDataEntry): void => {
    store.add({ type: entry.type, timestamp: entry.timestamp, serialized: entry.serialize() });
  };
  return {
    addEntry(entry: CaptureDataEntry): void {
      route(entry);
    },
    addEntries(entries: readonly CaptureDataEntry[]): void {
      for (const entry of entries) {
        route(entry);
      }
    },
    clear(): void {
      store.clear();
    },
  };
}
