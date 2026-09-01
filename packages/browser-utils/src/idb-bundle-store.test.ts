import { describe, expect, it, vi } from 'vitest';
import type { AsyncBlobStore } from './idb';
import { createPersistentBundleStore } from './idb-bundle-store';

const bytes = (...n: number[]) => new Uint8Array(n);

// A fake AsyncBlobStore over a Map, recording calls; loadAll is overridable for hydration-timing tests.
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

describe('createPersistentBundleStore', () => {
  it('serves put/read/list synchronously and persists through to the blob store', async () => {
    const { blob, map, calls } = fakeBlob();
    const store = createPersistentBundleStore(blob);
    store.put('a', bytes(1, 2));
    expect(store.read('a')).toEqual(bytes(1, 2)); // mirror is synchronous
    expect(store.list()).toEqual(['a']);
    await store.whenReady;
    expect(calls.put).toEqual(['a']); // persisted through
    expect(map.get('a')).toEqual(bytes(1, 2));
  });

  it('removes from the mirror and persists the removal', async () => {
    const { blob, map, calls } = fakeBlob();
    const store = createPersistentBundleStore(blob);
    store.put('a', bytes(1));
    store.put('b', bytes(2));
    store.remove('a');
    expect(store.list()).toEqual(['b']);
    expect(store.read('a')).toBeUndefined();
    await Promise.resolve();
    expect(calls.remove).toEqual(['a']);
    expect(map.has('a')).toBe(false);
  });

  it('hydrates the mirror from durable storage on open (recovery sees prior bundles)', async () => {
    const { blob } = fakeBlob([
      ['old-1', bytes(7)],
      ['old-2', bytes(8)],
    ]);
    const store = createPersistentBundleStore(blob);
    await store.whenReady;
    expect(store.list().sort()).toEqual(['old-1', 'old-2']);
    expect(store.read('old-1')).toEqual(bytes(7));
  });

  it('a live put during hydration wins over the persisted value for the same id', async () => {
    let resolveLoad: (entries: Array<[string, Uint8Array]>) => void = () => {};
    const blob: AsyncBlobStore = {
      loadAll: () => new Promise((resolve) => (resolveLoad = resolve)),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentBundleStore(blob);
    store.put('x', bytes(2)); // live put before hydration resolves
    resolveLoad([['x', bytes(99)]]); // a stale persisted 'x' arrives during hydration
    await store.whenReady;
    expect(store.read('x')).toEqual(bytes(2)); // the live put is NOT clobbered
  });

  it('a remove during hydration is not undone by a stale persisted value', async () => {
    let resolveLoad: (entries: Array<[string, Uint8Array]>) => void = () => {};
    const blob: AsyncBlobStore = {
      loadAll: () => new Promise((resolve) => (resolveLoad = resolve)),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentBundleStore(blob);
    store.remove('x'); // remove before hydration resolves
    resolveLoad([['x', bytes(99)]]); // the stale persisted 'x' must NOT resurrect it
    await store.whenReady;
    expect(store.read('x')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('surfaces a persistence (put) failure to the CALLER, without throwing synchronously', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.reject(new Error('quota exceeded')),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentBundleStore(blob, onError);
    const written = store.put('a', bytes(1)); // does not throw; the mirror still holds it
    expect(store.read('a')).toEqual(bytes(1));
    // The durable queue AWAITS this to decide `UploadResult.retained`, and `client.ts` retires the
    // report marker on the strength of that. Swallowing the failure here — which is what a
    // `.catch(onError)` did — made `retained: true` UNCONDITIONAL on this tier: quota exhaustion left
    // the marker retired with nothing durable behind the incident, so it was unrecoverable.
    await expect(written).rejects.toThrow('quota exceeded');
    expect(onError).not.toHaveBeenCalled(); // reported by the queue, once, not twice
  });

  it('resolves the returned promise once the write is durable — the positive control', async () => {
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentBundleStore(blob);
    await expect(store.put('a', bytes(1))).resolves.toBeUndefined();
  });

  it('routes a removal failure to onError without throwing', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.resolve(),
      remove: () => Promise.reject(new Error('remove failed')),
    };
    const store = createPersistentBundleStore(blob, onError);
    store.remove('a'); // no throw
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  it('routes a hydration failure to onError, leaving an empty (but usable) mirror', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.reject(new Error('hydration failed')),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentBundleStore(blob, onError);
    await store.whenReady; // resolves despite the failure
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(store.list()).toEqual([]); // empty mirror, still operable
    store.put('a', bytes(1));
    expect(store.read('a')).toEqual(bytes(1));
  });

  it('defaults onError to a no-op (a failure does not crash without an onError)', async () => {
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.reject(new Error('boom')),
      remove: () => Promise.reject(new Error('remove boom')),
    };
    const store = createPersistentBundleStore(blob); // no onError
    // `put` reports through its RETURN value, so an ignoring caller must neither throw nor leak an
    // unhandled rejection …
    expect(() => store.put('a', bytes(1))).not.toThrow();
    // … while `remove` has no caller that can act on it and so still routes to the sink — which is the
    // path that actually exercises the defaulted no-op.
    expect(() => store.remove('a')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
