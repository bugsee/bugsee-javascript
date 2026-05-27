import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import type { StoredEntry } from './contracts';
import { createMemoryCaptureStore } from './memory-capture-store';

const rec = (type: FileType, timestamp: number, serialized = '{}'): StoredEntry => ({
  type,
  timestamp,
  serialized,
});

describe('createMemoryCaptureStore', () => {
  it('stores a record under its file type', async () => {
    const store = createMemoryCaptureStore();
    const r = rec('log', 1, '{"message":"hi"}');
    store.add(r);
    expect(await store.drainAll()).toEqual(new Map([['log', [r]]]));
  });

  it('routes records to separate buffers by file type', async () => {
    const store = createMemoryCaptureStore();
    const net = rec('network', 1);
    const log = rec('log', 2);
    store.add(net);
    store.add(log);
    const snap = await store.drainAll();
    expect(snap.get('network')).toEqual([net]);
    expect(snap.get('log')).toEqual([log]);
  });

  it('accumulates same-type records in insertion order', async () => {
    const store = createMemoryCaptureStore();
    const a = rec('log', 1);
    const b = rec('log', 2);
    store.add(a);
    store.add(b);
    expect((await store.drainAll()).get('log')).toEqual([a, b]);
  });

  it('drainAll clears the buffers (next drain is empty)', async () => {
    const store = createMemoryCaptureStore();
    store.add(rec('log', 1));
    await store.drainAll();
    expect((await store.drainAll()).size).toBe(0);
  });

  it('drainAll omits file types with no buffered records', async () => {
    const store = createMemoryCaptureStore();
    store.add(rec('log', 1));
    await store.drainAll(); // drains 'log'
    store.add(rec('network', 2)); // only network has records now
    expect([...(await store.drainAll()).keys()]).toEqual(['network']);
  });

  it('bounds a file-type buffer at defaultCapacity, evicting oldest', async () => {
    const store = createMemoryCaptureStore({ defaultCapacity: 2 });
    store.add(rec('log', 1));
    store.add(rec('log', 2));
    store.add(rec('log', 3));
    expect((await store.drainAll()).get('log')?.map((e) => e.timestamp)).toEqual([2, 3]);
  });

  it('applies a per-type capacity override', async () => {
    const store = createMemoryCaptureStore({
      defaultCapacity: 100,
      capacities: { breadcrumbs: 1 },
    });
    store.add(rec('breadcrumbs', 1));
    store.add(rec('breadcrumbs', 2));
    expect((await store.drainAll()).get('breadcrumbs')?.map((e) => e.timestamp)).toEqual([2]);
  });

  it('clear empties all buffers', async () => {
    const store = createMemoryCaptureStore();
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.clear();
    expect((await store.drainAll()).size).toBe(0);
  });

  it('throws (via the ring buffer) for an invalid capacity', () => {
    const store = createMemoryCaptureStore({ defaultCapacity: 0 });
    expect(() => store.add(rec('log', 1))).toThrow(/must be a positive integer/);
  });

  it('stream yields records one-by-one grouped by file type, then clears', async () => {
    const store = createMemoryCaptureStore();
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.add(rec('log', 3));
    const seen: string[] = [];
    for await (const r of store.stream()) {
      seen.push(`${r.type}:${r.timestamp}`);
    }
    // log buffer (created first) drains fully, then network
    expect(seen).toEqual(['log:1', 'log:3', 'network:2']);
    expect((await store.drainAll()).size).toBe(0); // cleared
  });

  it('stream drains eagerly at call time (before iteration), not lazily per yield', async () => {
    const store = createMemoryCaptureStore();
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.stream();
    expect((await store.drainAll()).size).toBe(0);
  });

  it('stream over an empty store yields nothing', async () => {
    const store = createMemoryCaptureStore();
    const seen: unknown[] = [];
    for await (const r of store.stream()) {
      seen.push(r);
    }
    expect(seen).toEqual([]);
  });
});
