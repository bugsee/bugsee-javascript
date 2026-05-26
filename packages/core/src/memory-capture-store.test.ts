import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import type { CaptureDataEntry } from './contracts';
import { createMemoryCaptureStore } from './memory-capture-store';

const entry = (type: FileType, timestamp: number, data: unknown = {}): CaptureDataEntry => ({
  type,
  timestamp,
  data,
});

describe('createMemoryCaptureStore', () => {
  it('stores an entry under its file type', async () => {
    const store = createMemoryCaptureStore();
    const e = entry('log', 1, { message: 'hi' });
    store.add(e);
    expect(await store.drain()).toEqual(new Map([['log', [e]]]));
  });

  it('routes entries to separate buffers by file type', async () => {
    const store = createMemoryCaptureStore();
    const net = entry('network', 1);
    const log = entry('log', 2);
    store.add(net);
    store.add(log);
    const snap = await store.drain();
    expect(snap.get('network')).toEqual([net]);
    expect(snap.get('log')).toEqual([log]);
  });

  it('accumulates same-type entries in insertion order', async () => {
    const store = createMemoryCaptureStore();
    const a = entry('log', 1);
    const b = entry('log', 2);
    store.add(a);
    store.add(b);
    expect((await store.drain()).get('log')).toEqual([a, b]);
  });

  it('drain clears the buffers (next drain is empty)', async () => {
    const store = createMemoryCaptureStore();
    store.add(entry('log', 1));
    await store.drain();
    expect((await store.drain()).size).toBe(0);
  });

  it('drain omits file types with no buffered entries', async () => {
    const store = createMemoryCaptureStore();
    store.add(entry('log', 1));
    await store.drain(); // drains 'log'
    store.add(entry('network', 2)); // only network has entries now
    expect([...(await store.drain()).keys()]).toEqual(['network']);
  });

  it('bounds a file-type buffer at defaultCapacity, evicting oldest', async () => {
    const store = createMemoryCaptureStore({ defaultCapacity: 2 });
    store.add(entry('log', 1));
    store.add(entry('log', 2));
    store.add(entry('log', 3));
    expect((await store.drain()).get('log')?.map((e) => e.timestamp)).toEqual([2, 3]);
  });

  it('applies a per-type capacity override', async () => {
    const store = createMemoryCaptureStore({
      defaultCapacity: 100,
      capacities: { breadcrumbs: 1 },
    });
    store.add(entry('breadcrumbs', 1));
    store.add(entry('breadcrumbs', 2));
    expect((await store.drain()).get('breadcrumbs')?.map((e) => e.timestamp)).toEqual([2]);
  });

  it('clear empties all buffers', async () => {
    const store = createMemoryCaptureStore();
    store.add(entry('log', 1));
    store.add(entry('network', 2));
    store.clear();
    expect((await store.drain()).size).toBe(0);
  });

  it('throws (via the ring buffer) for an invalid capacity', () => {
    const store = createMemoryCaptureStore({ defaultCapacity: 0 });
    expect(() => store.add(entry('log', 1))).toThrow(/must be a positive integer/);
  });

  it('stream yields entries one-by-one grouped by file type, then clears', async () => {
    const store = createMemoryCaptureStore();
    store.add(entry('log', 1));
    store.add(entry('network', 2));
    store.add(entry('log', 3));
    const seen: string[] = [];
    for await (const e of store.stream()) {
      seen.push(`${e.type}:${e.timestamp}`);
    }
    // log buffer (created first) drains fully, then network
    expect(seen).toEqual(['log:1', 'log:3', 'network:2']);
    expect((await store.drain()).size).toBe(0); // cleared
  });

  it('stream drains eagerly at call time (before iteration), not lazily per yield', async () => {
    const store = createMemoryCaptureStore();
    store.add(entry('log', 1));
    store.add(entry('network', 2));
    // Create the iterator but do NOT iterate it: the snapshot+clear must already have happened.
    store.stream();
    expect((await store.drain()).size).toBe(0);
  });

  it('stream over an empty store yields nothing', async () => {
    const store = createMemoryCaptureStore();
    const seen: unknown[] = [];
    for await (const e of store.stream()) {
      seen.push(e);
    }
    expect(seen).toEqual([]);
  });
});
