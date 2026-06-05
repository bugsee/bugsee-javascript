import type { ReportMarker } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncBlobStore } from './idb';
import { createPersistentReportMarkerStore } from './idb-report-marker-store';

const marker = (id: string, generation = 5): ReportMarker => ({
  generation,
  request: {
    id,
    source: { type: 'crash', mechanism: 'uncaught' },
    report: {
      id,
      type: 'crash',
      severity: 'blocker',
      labels: [],
      attributes: {},
      signatures: ['s'],
    },
  },
  attributes: { plan: 'pro' },
  userIdentifier: 'u@e.com',
});
const enc = (m: ReportMarker): Uint8Array => new TextEncoder().encode(JSON.stringify(m));

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

describe('createPersistentReportMarkerStore', () => {
  it('serves put/list synchronously (keyed by request.id) and persists the encoded marker through', async () => {
    const { blob, map, calls } = fakeBlob();
    const store = createPersistentReportMarkerStore(blob);
    const m = marker('inc-1');
    store.put(m);
    expect(store.list()).toEqual([m]); // mirror is synchronous, returns the marker
    await store.whenReady;
    expect(calls.put).toEqual(['inc-1']); // persisted under request.id
    expect(map.get('inc-1')).toEqual(enc(m));
  });

  it('removes by id from the mirror and persists the removal', async () => {
    const { blob, map, calls } = fakeBlob();
    const store = createPersistentReportMarkerStore(blob);
    store.put(marker('a'));
    store.put(marker('b'));
    store.remove('a');
    expect(store.list().map((m) => m.request.id)).toEqual(['b']);
    await Promise.resolve();
    expect(calls.remove).toEqual(['a']);
    expect(map.has('a')).toBe(false);
  });

  it('hydrates + decodes durable markers on open (recovery sees a prior run’s incidents)', async () => {
    const { blob } = fakeBlob([
      ['old-1', enc(marker('old-1', 100))],
      ['old-2', enc(marker('old-2', 200))],
    ]);
    const store = createPersistentReportMarkerStore(blob);
    await store.whenReady;
    expect(
      store
        .list()
        .map((m) => [m.request.id, m.generation])
        .sort(),
    ).toEqual([
      ['old-1', 100],
      ['old-2', 200],
    ]);
  });

  it('drops + purges a corrupt persisted marker during hydration, routing it to onError', async () => {
    const onError = vi.fn();
    const { blob, map, calls } = fakeBlob([
      ['good', enc(marker('good'))],
      ['bad', new TextEncoder().encode('not-json')],
    ]);
    const store = createPersistentReportMarkerStore(blob, onError);
    await store.whenReady;
    expect(store.list().map((m) => m.request.id)).toEqual(['good']); // corrupt skipped
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await vi.waitFor(() => expect(calls.remove).toEqual(['bad'])); // purged from durable storage
    expect(map.has('bad')).toBe(false);
  });

  it('does not decode/purge a corrupt persisted marker for an id a live op already touched', async () => {
    // The `touched` guard must run BEFORE the decode: a live op wins, so a corrupt persisted value for
    // that same id is never decoded (no spurious onError) nor purged out from under the live op.
    const onError = vi.fn();
    let resolveLoad: (entries: Array<[string, Uint8Array]>) => void = () => {};
    const removed: string[] = [];
    const blob: AsyncBlobStore = {
      loadAll: () => new Promise((resolve) => (resolveLoad = resolve)),
      put: () => Promise.resolve(),
      remove: (id) => {
        removed.push(id);
        return Promise.resolve();
      },
    };
    const store = createPersistentReportMarkerStore(blob, onError);
    const live = marker('x', 7);
    store.put(live); // touches 'x' before hydration resolves
    resolveLoad([['x', new TextEncoder().encode('corrupt')]]); // a corrupt persisted 'x' arrives
    await store.whenReady;
    expect(store.list()).toEqual([live]); // the live marker stands
    expect(onError).not.toHaveBeenCalled(); // corrupt 'x' skipped (touched) — never decoded
    expect(removed).toEqual([]); // and not purged out from under the live put
  });

  it('a live put during hydration wins over a stale persisted marker for the same id', async () => {
    let resolveLoad: (entries: Array<[string, Uint8Array]>) => void = () => {};
    const blob: AsyncBlobStore = {
      loadAll: () => new Promise((resolve) => (resolveLoad = resolve)),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentReportMarkerStore(blob);
    const live = marker('x', 999);
    store.put(live); // live put before hydration resolves
    resolveLoad([['x', enc(marker('x', 1))]]); // a stale persisted 'x' arrives during hydration
    await store.whenReady;
    expect(store.list()).toEqual([live]); // the live put is NOT clobbered
  });

  it('a remove during hydration is not undone by a stale persisted marker', async () => {
    let resolveLoad: (entries: Array<[string, Uint8Array]>) => void = () => {};
    const blob: AsyncBlobStore = {
      loadAll: () => new Promise((resolve) => (resolveLoad = resolve)),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentReportMarkerStore(blob);
    store.remove('x'); // remove before hydration resolves
    resolveLoad([['x', enc(marker('x'))]]); // the stale persisted 'x' must NOT resurrect it
    await store.whenReady;
    expect(store.list()).toEqual([]);
  });

  it('routes a persistence (put) failure to onError without throwing', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.reject(new Error('quota exceeded')),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentReportMarkerStore(blob, onError);
    store.put(marker('a')); // does not throw; the mirror still holds it
    expect(store.list().map((m) => m.request.id)).toEqual(['a']);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  it('routes a removal failure to onError without throwing', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.resolve(),
      remove: () => Promise.reject(new Error('remove failed')),
    };
    const store = createPersistentReportMarkerStore(blob, onError);
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
    const store = createPersistentReportMarkerStore(blob, onError);
    await store.whenReady; // resolves despite the failure
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(store.list()).toEqual([]); // empty mirror, still operable
    store.put(marker('a'));
    expect(store.list().map((m) => m.request.id)).toEqual(['a']);
  });

  it('defaults onError to a no-op (a failure does not crash without an onError)', async () => {
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.reject(new Error('boom')),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentReportMarkerStore(blob); // no onError
    expect(() => store.put(marker('a'))).not.toThrow();
    await Promise.resolve();
  });
});
