import { createMemoryCaptureStore, type StoredEntry } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncBlobStore } from './idb';
import { createPersistentCaptureStore, type PersistentCaptureStore } from './idb-capture-store';

const entry = (serialized: string, timestamp = 0): StoredEntry => ({
  type: 'log',
  timestamp,
  serialized,
});
const encodePart = (records: StoredEntry[], closedAt: number): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ records, closedAt }));
const decodePart = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as { records: StoredEntry[]; closedAt: number };

function fakeBlob(initial: Array<[string, Uint8Array]> = []) {
  const map = new Map(initial);
  const calls = { put: [] as string[], remove: [] as string[] };
  const blob: AsyncBlobStore = {
    loadAll: () => Promise.resolve([...map.entries()]),
    put: (id, b) => {
      calls.put.push(id);
      map.set(id, b);
      return Promise.resolve();
    },
    remove: (id) => {
      calls.remove.push(id);
      map.delete(id);
      return Promise.resolve();
    },
  };
  return { blob, map, calls };
}

// The in-memory mirror keeps everything (Infinity window) so tests isolate the persistent store's own
// part flushing/eviction from the mirror's window.
const mem = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });

const drainLog = async (store: PersistentCaptureStore): Promise<string[]> => {
  const snap = store.snapshot();
  const records = (await snap.drainAll()).get('log') ?? [];
  snap.release();
  return records.map((r) => r.serialized);
};

const opts = (over: Partial<Parameters<typeof createPersistentCaptureStore>[2]> = {}) => ({
  maxRecordingTimeMs: Number.POSITIVE_INFINITY,
  idPrefix: 'r1',
  ...over,
});

describe('createPersistentCaptureStore', () => {
  it('delegates add/snapshot to the in-memory mirror (synchronous)', async () => {
    const store = createPersistentCaptureStore(fakeBlob().blob, mem(), opts());
    store.add(entry('a'));
    store.add(entry('b'));
    expect(await drainLog(store)).toEqual(['a', 'b']);
  });

  it('flushes a closed (ticked) part to the blob store with its records and closedAt', async () => {
    const { blob, map, calls } = fakeBlob();
    const store = createPersistentCaptureStore(blob, mem(), opts());
    store.add(entry('a'));
    store.add(entry('b'));
    store.tick(1000);
    expect(calls.put).toEqual(['r1-0']); // first part, run-prefixed
    const part = decodePart(map.get('r1-0') as Uint8Array);
    expect(part.closedAt).toBe(1000);
    expect(part.records.map((r) => r.serialized)).toEqual(['a', 'b']);
  });

  it('does not flush an empty part (a tick with no adds since the last)', async () => {
    const { blob, calls } = fakeBlob();
    const store = createPersistentCaptureStore(blob, mem(), opts());
    store.tick(1000);
    expect(calls.put).toEqual([]);
  });

  it('uses incrementing part ids per tick', async () => {
    const { blob, calls } = fakeBlob();
    const store = createPersistentCaptureStore(blob, mem(), opts());
    store.add(entry('a'));
    store.tick(1000);
    store.add(entry('b'));
    store.tick(2000);
    expect(calls.put).toEqual(['r1-0', 'r1-1']);
  });

  it('evicts persisted parts older than the recording window on tick', async () => {
    const { blob, calls } = fakeBlob();
    const store = createPersistentCaptureStore(blob, mem(), opts({ maxRecordingTimeMs: 3000 }));
    store.add(entry('old'));
    store.tick(1000); // part r1-0 closedAt 1000
    store.add(entry('new'));
    store.tick(5000); // cutoff = 5000 - 3000 = 2000 → r1-0 (1000 < 2000) evicted; r1-1 (5000) retained
    expect(calls.remove).toContain('r1-0');
    expect(calls.remove).not.toContain('r1-1'); // an in-window part must NOT be over-evicted
  });

  it('hydrates persisted parts back into the mirror on open (oldest closedAt first)', async () => {
    const { blob } = fakeBlob([
      ['r0-1', encodePart([entry('second')], 2000)],
      ['r0-0', encodePart([entry('first')], 1000)],
    ]);
    const store = createPersistentCaptureStore(blob, mem(), opts());
    await store.whenReady;
    expect(await drainLog(store)).toEqual(['first', 'second']); // re-applied oldest-first
  });

  it('persists new parts under this run prefix, never colliding with hydrated ids', async () => {
    const { blob, calls } = fakeBlob([['r0-0', encodePart([entry('prior')], 500)]]);
    const store = createPersistentCaptureStore(blob, mem(), opts({ idPrefix: 'r1' }));
    await store.whenReady;
    store.add(entry('live'));
    store.tick(1000);
    expect(calls.put).toEqual(['r1-0']); // this-run prefix, distinct from the hydrated 'r0-0'
  });

  it('clear() discards the mirror and removes every persisted part', async () => {
    const { blob, map, calls } = fakeBlob();
    const store = createPersistentCaptureStore(blob, mem(), opts());
    store.add(entry('a'));
    store.tick(1000);
    store.add(entry('b'));
    store.tick(2000);
    store.clear();
    expect(await drainLog(store)).toEqual([]);
    expect(calls.remove.sort()).toEqual(['r1-0', 'r1-1']);
    expect(map.size).toBe(0);
  });

  it('purges and reports an unparseable persisted part on hydration', async () => {
    const onError = vi.fn();
    const { blob, calls } = fakeBlob([
      ['r0-0', new TextEncoder().encode('not json')],
      ['r0-1', encodePart([entry('ok')], 1000)],
    ]);
    const store = createPersistentCaptureStore(blob, mem(), opts({ onError }));
    await store.whenReady;
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(calls.remove).toContain('r0-0'); // unparseable leftover purged
    expect(await drainLog(store)).toEqual(['ok']); // the good part still hydrated
  });

  it('routes a hydration failure to onError, leaving an empty but usable store', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.reject(new Error('hydration failed')),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentCaptureStore(blob, mem(), opts({ onError }));
    await store.whenReady;
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    store.add(entry('a'));
    expect(await drainLog(store)).toEqual(['a']);
  });

  it('routes a flush failure to onError without throwing', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.reject(new Error('quota')),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentCaptureStore(blob, mem(), opts({ onError }));
    store.add(entry('a'));
    store.tick(1000); // flush fails
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  it('defaults idPrefix to a timestamp and onError to a no-op (a flush failure is swallowed)', async () => {
    const putIds: string[] = [];
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: (id) => {
        putIds.push(id);
        return Promise.reject(new Error('quota')); // exercises the default no-op onError
      },
      remove: () => Promise.resolve(),
    };
    // No idPrefix / onError supplied.
    const store = createPersistentCaptureStore(blob, mem(), { maxRecordingTimeMs: 1000 });
    store.add(entry('a'));
    expect(() => store.tick(1000)).not.toThrow();
    expect(putIds[0]).toMatch(/^\d+-0$/); // default idPrefix is a timestamp
    await Promise.resolve();
  });
});
