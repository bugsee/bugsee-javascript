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

  it('surfaces a persistence (put) failure to the CALLER, without throwing synchronously', async () => {
    const onError = vi.fn();
    const blob: AsyncBlobStore = {
      loadAll: () => Promise.resolve([]),
      put: () => Promise.reject(new Error('quota exceeded')),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentReportMarkerStore(blob, onError);
    const written = store.put(marker('a')); // does not throw; the mirror still holds it
    expect(store.list().map((m) => m.request.id)).toEqual(['a']);
    // Reported through the RETURN value now, not swallowed to the sink — the client uses it to tell
    // whether the incident survives the page. `remove` and hydration still route to `onError`, since
    // neither has a caller that can act on the answer.
    await expect(written).rejects.toThrow('quota exceeded');
    expect(onError).not.toHaveBeenCalled();
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

describe('createPersistentReportMarkerStore — a failed marker write reaches the CALLER', () => {
  // The marker is the only trace of an incident whose bundle never reached durable storage, and it also
  // pins that incident's capture generation against the recovery sweep. Swallowing its write failure to
  // `onError` meant the client kept a marker that existed only in the in-memory mirror — which dies with
  // the page. On the browser tier the dominant failure is quota exhaustion, and the marker lives in the
  // SAME database as the bundle, so it is exactly the case where both writes fail together.
  const failing = (error: Error): AsyncBlobStore => ({
    loadAll: () => Promise.resolve([]),
    put: () => Promise.reject(error),
    remove: () => Promise.resolve(),
  });

  it('returns a promise that REJECTS when the durable marker write fails', async () => {
    const onError = vi.fn();
    const store = createPersistentReportMarkerStore(
      failing(new Error('QuotaExceededError')),
      onError,
    );
    await expect(store.put(marker('a'))).rejects.toThrow('QuotaExceededError');
    expect(onError).not.toHaveBeenCalled(); // reported by the caller, once, not twice
    expect(store.list()).toEqual([marker('a')]); // the mirror still serves this run
  });

  it('resolves once the marker is durable — the positive control', async () => {
    const store = createPersistentReportMarkerStore({
      loadAll: () => Promise.resolve([]),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    });
    await expect(store.put(marker('a'))).resolves.toBeUndefined();
  });

  it('survives put AND remove failures with no onError supplied', async () => {
    // Two things, and only one of them is an assertion. (1) `put` is public API on an injectable store,
    // so a caller that IGNORES the returned promise must not have the SDK emit an `unhandledrejection`
    // into the host page — that property is enforced by the runner's unhandled-rejection reporter, not
    // by the `not.toThrow()` below, which cannot fail because neither fake throws synchronously.
    // (2) `remove` has no caller that can act on its failure, so it still routes to the sink — and with
    // no `onError` supplied that is the DEFAULTED no-op, which is the only path that reaches it now that
    // `put` reports through its return value.
    const store = createPersistentReportMarkerStore({
      loadAll: () => Promise.resolve([]),
      put: () => Promise.reject(new Error('boom')),
      remove: () => Promise.reject(new Error('remove boom')),
    });
    expect(() => store.put(marker('a'))).not.toThrow();
    expect(() => store.remove('a')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    // The put rejection IS observable to a caller that keeps it — that half is a real assertion.
    await expect(store.put(marker('b'))).rejects.toThrow('boom');
  });
});
