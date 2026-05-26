import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCaptureAggregator } from './capture-aggregator';
import type { CaptureDataEntry, CaptureStore } from './contracts';
import { createMemoryCaptureStore } from './memory-capture-store';

const entry = (type: FileType, timestamp: number): CaptureDataEntry => ({
  type,
  timestamp,
  data: {},
});

function fakeStore() {
  const added: CaptureDataEntry[] = [];
  const drainResult = new Map<FileType, CaptureDataEntry[]>([['log', [entry('log', 9)]]]);
  const streamed = entry('network', 8);
  const store: CaptureStore = {
    add: (e) => added.push(e),
    stream: vi.fn(async function* () {
      yield streamed;
    }),
    drain: vi.fn(async () => drainResult),
    clear: vi.fn(),
  };
  return { store, added, drainResult, streamed };
}

describe('createCaptureAggregator', () => {
  it('supplies a single entry to the store', () => {
    const { store, added } = fakeStore();
    const e = entry('network', 1);
    createCaptureAggregator(store).addEntry(e);
    expect(added).toEqual([e]);
  });

  it('supplies each entry of a batch to the store, in order', () => {
    const { store, added } = fakeStore();
    const a = entry('log', 1);
    const b = entry('network', 2);
    createCaptureAggregator(store).addEntries([a, b]);
    expect(added).toEqual([a, b]);
  });

  it('snapshot delegates to store.drain', async () => {
    const { store, drainResult } = fakeStore();
    const snap = await createCaptureAggregator(store).snapshot();
    expect(store.drain).toHaveBeenCalledTimes(1);
    expect(snap).toBe(drainResult);
  });

  it('stream delegates to store.stream', async () => {
    const { store, streamed } = fakeStore();
    const out: CaptureDataEntry[] = [];
    for await (const e of createCaptureAggregator(store).stream()) {
      out.push(e);
    }
    expect(store.stream).toHaveBeenCalledTimes(1);
    expect(out).toEqual([streamed]);
  });

  it('clear delegates to store.clear', () => {
    const { store } = fakeStore();
    createCaptureAggregator(store).clear();
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  // Integration with the default in-memory store.
  it('round-trips entries through the in-memory store', async () => {
    const aggregator = createCaptureAggregator(createMemoryCaptureStore());
    const log = entry('log', 1);
    aggregator.addEntry(log);
    expect((await aggregator.snapshot()).get('log')).toEqual([log]);
    expect((await aggregator.snapshot()).size).toBe(0); // drained
  });
});
