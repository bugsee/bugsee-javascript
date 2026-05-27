import { describe, expect, it, vi } from 'vitest';
import { createCaptureAggregator } from './capture-aggregator';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import type { CaptureDataEntry, CaptureStore, StoredEntry } from './contracts';
import { createMemoryCaptureStore } from './memory-capture-store';

function fakeStore() {
  const added: StoredEntry[] = [];
  const store: CaptureStore = {
    add: (r) => added.push(r),
    stream: vi.fn(async function* () {}),
    drainAll: vi.fn(async () => new Map()),
    clear: vi.fn(),
  };
  return { store, added };
}

describe('createCaptureAggregator', () => {
  it('serializes an entry and routes the record to the store', () => {
    const { store, added } = fakeStore();
    const e = new CaptureDataEntryBase('network', 1, { url: 'u' });
    createCaptureAggregator(store).addEntry(e);
    expect(added).toEqual([{ type: 'network', timestamp: 1, serialized: e.serialize() }]);
  });

  it("routes the entry's OWN serialize() output", () => {
    const { store, added } = fakeStore();
    const custom: CaptureDataEntry = {
      type: 'log',
      timestamp: 5,
      data: {},
      serialize: () => 'MARKER',
      deserialize: () => {},
    };
    createCaptureAggregator(store).addEntry(custom);
    expect(added[0]).toEqual({ type: 'log', timestamp: 5, serialized: 'MARKER' });
  });

  it('serializes and routes each entry of a batch, in order', () => {
    const { store, added } = fakeStore();
    const a = new CaptureDataEntryBase('log', 1, { a: 1 });
    const b = new CaptureDataEntryBase('network', 2, { b: 2 });
    createCaptureAggregator(store).addEntries([a, b]);
    expect(added).toEqual([
      { type: 'log', timestamp: 1, serialized: a.serialize() },
      { type: 'network', timestamp: 2, serialized: b.serialize() },
    ]);
  });

  it('clear delegates to store.clear', () => {
    const { store } = fakeStore();
    createCaptureAggregator(store).clear();
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  // Integration: write via the aggregator, read back via the exporter over the same store.
  it('round-trips entries through the in-memory store + exporter', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const aggregator = createCaptureAggregator(store);
    const exporter = createCaptureExporter(store);
    aggregator.addEntry(new CaptureDataEntryBase('log', 1, { m: 'hi' }));
    const out = await exporter.drain();
    expect(
      out.get('log')?.map((e) => ({ type: e.type, timestamp: e.timestamp, data: e.data })),
    ).toEqual([{ type: 'log', timestamp: 1, data: { m: 'hi' } }]);
    expect((await exporter.drain()).size).toBe(0); // drained
  });
});
