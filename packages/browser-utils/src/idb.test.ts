import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdbBlobStore, createIdbKeyedStore } from './idb';

const bytes = (...n: number[]) => new Uint8Array(n);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createIdbBlobStore', () => {
  it('persists a value under an id and loads it back', async () => {
    const store = createIdbBlobStore({ indexedDB: new IDBFactory() });
    await store.put('a', bytes(1, 2, 3));
    expect(await store.loadAll()).toEqual([['a', bytes(1, 2, 3)]]);
  });

  it('returns no entries for an empty store', async () => {
    const store = createIdbBlobStore({ indexedDB: new IDBFactory() });
    expect(await store.loadAll()).toEqual([]);
  });

  it('replaces an existing value for the same id', async () => {
    const store = createIdbBlobStore({ indexedDB: new IDBFactory() });
    await store.put('a', bytes(1));
    await store.put('a', bytes(9, 9));
    expect(await store.loadAll()).toEqual([['a', bytes(9, 9)]]);
  });

  it('removes a value (and is a no-op for an absent id)', async () => {
    const store = createIdbBlobStore({ indexedDB: new IDBFactory() });
    await store.put('a', bytes(1));
    await store.put('b', bytes(2));
    await store.remove('a');
    await store.remove('missing');
    expect(await store.loadAll()).toEqual([['b', bytes(2)]]);
  });

  it('durably persists across a reopen (new store instance, same database)', async () => {
    const idb = new IDBFactory();
    const first = createIdbBlobStore({ indexedDB: idb });
    await first.put('x', bytes(7));
    await first.put('y', bytes(8));
    // A fresh store over the same IDBFactory simulates a page reload.
    const second = createIdbBlobStore({ indexedDB: idb });
    expect((await second.loadAll()).sort()).toEqual([
      ['x', bytes(7)],
      ['y', bytes(8)],
    ]);
  });

  it('honors custom database / store names', async () => {
    const idb = new IDBFactory();
    const store = createIdbBlobStore({ indexedDB: idb, databaseName: 'db2', storeName: 'blobs' });
    await store.put('a', bytes(5));
    expect(await store.loadAll()).toEqual([['a', bytes(5)]]);
  });

  it('reuses the same open database across operations (opens once)', async () => {
    const idb = new IDBFactory();
    const openSpy = vi.spyOn(idb, 'open');
    const store = createIdbBlobStore({ indexedDB: idb });
    await store.put('a', bytes(1));
    await store.put('b', bytes(2));
    await store.loadAll();
    expect(openSpy).toHaveBeenCalledTimes(1); // the db open is memoized
  });

  it('defaults to globalThis.indexedDB', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const store = createIdbBlobStore({ databaseName: 'global-db' });
    await store.put('a', bytes(3));
    expect(await store.loadAll()).toEqual([['a', bytes(3)]]);
  });
});

describe('createIdbKeyedStore', () => {
  it('put + readPrefix round-trips, ascending by key', async () => {
    const store = createIdbKeyedStore({ indexedDB: new IDBFactory() });
    await store.put('d/5/02', bytes(2));
    await store.put('d/5/00', bytes(0));
    await store.put('d/5/01', bytes(1));
    expect(await store.readPrefix('d/5/')).toEqual([
      ['d/5/00', bytes(0)],
      ['d/5/01', bytes(1)],
      ['d/5/02', bytes(2)],
    ]);
  });

  it('readPrefix returns only keys under the prefix (not siblings)', async () => {
    const store = createIdbKeyedStore({ indexedDB: new IDBFactory() });
    await store.put('m/5/0', bytes(1));
    await store.put('d/5/0/000', bytes(2)); // a data record, different keyspace
    await store.put('m/6/0', bytes(3)); // a different generation
    expect(await store.readPrefix('m/5/')).toEqual([['m/5/0', bytes(1)]]);
  });

  it('put replaces an existing value', async () => {
    const store = createIdbKeyedStore({ indexedDB: new IDBFactory() });
    await store.put('m/5/0', bytes(1));
    await store.put('m/5/0', bytes(9, 9));
    expect(await store.readPrefix('m/5/')).toEqual([['m/5/0', bytes(9, 9)]]);
  });

  it('deletePrefix removes the whole range (and is a no-op when none match)', async () => {
    const store = createIdbKeyedStore({ indexedDB: new IDBFactory() });
    await store.put('d/5/00', bytes(0));
    await store.put('d/5/01', bytes(1));
    await store.put('d/6/00', bytes(2)); // a different generation, kept
    await store.deletePrefix('d/5/');
    await store.deletePrefix('d/9/'); // no match → no-op
    expect(await store.readPrefix('d/')).toEqual([['d/6/00', bytes(2)]]);
  });

  it('durably persists across a reopen (new store instance, same database)', async () => {
    const idb = new IDBFactory();
    const first = createIdbKeyedStore({ indexedDB: idb, databaseName: 'cap', storeName: 'chunks' });
    await first.put('m/5/0', bytes(7));
    const second = createIdbKeyedStore({
      indexedDB: idb,
      databaseName: 'cap',
      storeName: 'chunks',
    });
    expect(await second.readPrefix('m/')).toEqual([['m/5/0', bytes(7)]]);
  });

  it('keys lists only the keys under the prefix, ascending, without reading values', async () => {
    const store = createIdbKeyedStore({ indexedDB: new IDBFactory() });
    await store.put('A/d/5/02', bytes(2));
    await store.put('A/d/5/00', bytes(0));
    await store.put('B/d/5/00', bytes(9)); // a different instance prefix, excluded
    expect(await store.keys('A/')).toEqual(['A/d/5/00', 'A/d/5/02']); // ascending, A only
    expect(await store.keys('Z/')).toEqual([]); // no match → empty
  });

  it('reuses the same open database across operations (opens once)', async () => {
    const idb = new IDBFactory();
    const openSpy = vi.spyOn(idb, 'open');
    const store = createIdbKeyedStore({ indexedDB: idb });
    await store.put('a', bytes(1));
    await store.readPrefix('a');
    await store.deletePrefix('a');
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to globalThis.indexedDB', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const store = createIdbKeyedStore({ databaseName: 'global-keyed' });
    await store.put('a', bytes(3));
    expect(await store.readPrefix('a')).toEqual([['a', bytes(3)]]);
  });

  it('rejects put/readPrefix/deletePrefix when the database fails to open', async () => {
    const store = createIdbKeyedStore({
      indexedDB: openFailsFactory(new DOMException('open fail')),
    });
    await expect(store.put('a', bytes(1))).rejects.toThrow('open fail');
    await expect(store.readPrefix('a')).rejects.toThrow('open fail');
    await expect(store.deletePrefix('a')).rejects.toThrow('open fail');
  });

  it('rejects when a request or the readPrefix transaction errors', async () => {
    const store = createIdbKeyedStore({ indexedDB: requestsFailFactory() });
    await expect(store.put('a', bytes(1))).rejects.toThrow('req fail');
    await expect(store.deletePrefix('a')).rejects.toThrow('req fail');
    await expect(store.readPrefix('a')).rejects.toThrow('tx fail');
    await expect(store.keys('a')).rejects.toThrow('req fail'); // getAllKeys request error
  });

  it('falls back to a generic error when the readPrefix transaction carries no error object', async () => {
    const store = createIdbKeyedStore({ indexedDB: requestsFailFactory(null) });
    await expect(store.readPrefix('a')).rejects.toThrow('indexedDB readPrefix failed');
  });
});

// --- error paths (fake-indexeddb can't synthesize storage failures; craft minimal erroring IDB) ----

type Cb = (() => void) | null;

// An IDBFactory whose open() fails with the given error (null → exercises the generic-error fallback).
function openFailsFactory(error: DOMException | null): IDBFactory {
  return {
    open() {
      const request = {
        error,
        result: undefined,
        onupgradeneeded: null as Cb,
        onsuccess: null as Cb,
        onerror: null as Cb,
      };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

// An IDBFactory that opens fine but every object-store request — and the loadAll transaction — errors.
function requestsFailFactory(
  txError: DOMException | null = new DOMException('tx fail'),
): IDBFactory {
  const failingRequest = () => {
    const request = {
      error: new DOMException('req fail'),
      result: undefined,
      onsuccess: null as Cb,
      onerror: null as Cb,
    };
    queueMicrotask(() => request.onerror?.());
    return request;
  };
  const objectStore = {
    put: failingRequest,
    delete: failingRequest,
    getAll: failingRequest,
    getAllKeys: failingRequest,
  };
  const db = {
    transaction() {
      const transaction = {
        objectStore: () => objectStore,
        error: txError,
        oncomplete: null as Cb,
        onerror: null as Cb,
      };
      queueMicrotask(() => transaction.onerror?.());
      return transaction;
    },
  };
  return {
    open() {
      const request = {
        error: null,
        result: db,
        onupgradeneeded: null as Cb,
        onsuccess: null as Cb,
        onerror: null as Cb,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('createIdbBlobStore — error handling', () => {
  it('rejects put/remove/loadAll when the database fails to open (carrying the error)', async () => {
    const store = createIdbBlobStore({
      indexedDB: openFailsFactory(new DOMException('open fail')),
    });
    await expect(store.put('a', bytes(1))).rejects.toThrow('open fail');
    await expect(store.remove('a')).rejects.toThrow('open fail');
    await expect(store.loadAll()).rejects.toThrow('open fail');
  });

  it('falls back to a generic error when the open failure carries no error object', async () => {
    const store = createIdbBlobStore({ indexedDB: openFailsFactory(null) });
    await expect(store.put('a', bytes(1))).rejects.toThrow('indexedDB request failed');
  });

  it('rejects when a request or the loadAll transaction errors', async () => {
    const store = createIdbBlobStore({ indexedDB: requestsFailFactory() });
    await expect(store.put('a', bytes(1))).rejects.toThrow('req fail');
    await expect(store.loadAll()).rejects.toThrow('tx fail');
  });

  it('falls back to a generic error when the loadAll transaction carries no error object', async () => {
    const store = createIdbBlobStore({ indexedDB: requestsFailFactory(null) });
    await expect(store.loadAll()).rejects.toThrow('indexedDB loadAll failed');
  });
});
