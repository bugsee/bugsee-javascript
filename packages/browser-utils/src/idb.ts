// A tiny async key→bytes store over IndexedDB — the durable substrate for the browser's persistent
// stores (bundle queue now, capture store later). It exposes the minimal async surface the in-memory
// mirror needs (load-all on open, put, remove); the sync-contract adaptation lives in the mirror, not
// here. The IDBFactory is injectable so tests run against fake-indexeddb (or a real browser).

/** The minimal async key→bytes durable store the in-memory mirrors write through to. */
export interface AsyncBlobStore {
  /** Read every [id, bytes] pair currently persisted (for hydrating the mirror on open). */
  loadAll(): Promise<Array<[string, Uint8Array]>>;
  /** Persist `bytes` under `id`, replacing any existing value. */
  put(id: string, bytes: Uint8Array): Promise<void>;
  /** Remove the value under `id`; a no-op if absent. */
  remove(id: string): Promise<void>;
}

export interface IdbBlobStoreOptions {
  /** IndexedDB database name. Default 'bugsee'. */
  databaseName?: string;
  /** Object store name. Default 'bundles'. */
  storeName?: string;
  /** IDB factory; injectable for tests. Default globalThis.indexedDB. */
  indexedDB?: IDBFactory;
}

const reqError = (req: { error: DOMException | null }): Error =>
  req.error ?? new Error('indexedDB request failed');

/** Build an {@link AsyncBlobStore} over IndexedDB (lazily opening the database on first use). */
export function createIdbBlobStore(options: IdbBlobStoreOptions = {}): AsyncBlobStore {
  const databaseName = options.databaseName ?? 'bugsee';
  const storeName = options.storeName ?? 'bundles';
  const idb = options.indexedDB ?? globalThis.indexedDB;

  let dbPromise: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (dbPromise === undefined) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = idb.open(databaseName, 1);
        // onupgradeneeded fires only on the 0→1 first open of a brand-new database, so the object
        // store never pre-exists — create it unconditionally.
        request.onupgradeneeded = () => {
          request.result.createObjectStore(storeName);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(reqError(request));
      });
    }
    return dbPromise;
  };

  // Run a single-request read/write transaction and resolve with the request result.
  const run = <T>(
    mode: IDBTransactionMode,
    exec: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const request = exec(db.transaction(storeName, mode).objectStore(storeName));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(reqError(request));
        }),
    );

  return {
    loadAll: () =>
      open().then(
        (db) =>
          new Promise<Array<[string, Uint8Array]>>((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();
            transaction.oncomplete = () => {
              const keys = keysRequest.result;
              const values = valuesRequest.result as Uint8Array[];
              resolve(keys.map((key, index) => [String(key), values[index] as Uint8Array]));
            };
            transaction.onerror = () =>
              reject(transaction.error ?? new Error('indexedDB loadAll failed'));
          }),
      ),
    put: (id, bytes) => run('readwrite', (store) => store.put(bytes, id)).then(() => undefined),
    remove: (id) => run('readwrite', (store) => store.delete(id)).then(() => undefined),
  };
}

/**
 * A minimal async keyed byte store with PREFIX range reads/deletes — the durable substrate for the
 * IndexedDB chunk backend (the durable-as-captured capture store). Keys are strings; a prefix scan uses
 * an inclusive [prefix, prefix+'￿'] key range, so fixed-width zero-padded keys (`d/<gen>/<chunk>/
 * <seq>`, `m/<gen>/<chunk>`) read/delete a chunk or generation as one range.
 */
export interface AsyncKeyedStore {
  /** Persist `bytes` under `key`, replacing any existing value. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Read every [key, bytes] whose key starts with `prefix`, ascending by key. */
  readPrefix(prefix: string): Promise<Array<[string, Uint8Array]>>;
  /** List every KEY starting with `prefix`, ascending — values NOT read (cheap `getAllKeys`, for
   *  enumerating instance prefixes during multi-instance discovery without loading the data). */
  keys(prefix: string): Promise<string[]>;
  /** Delete every key starting with `prefix`; a no-op if none match. */
  deletePrefix(prefix: string): Promise<void>;
}

/** Build an {@link AsyncKeyedStore} over IndexedDB (lazily opening the database on first use). */
export function createIdbKeyedStore(options: IdbBlobStoreOptions = {}): AsyncKeyedStore {
  const databaseName = options.databaseName ?? 'bugsee';
  const storeName = options.storeName ?? 'keyed';
  const idb = options.indexedDB ?? globalThis.indexedDB;

  let dbPromise: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (dbPromise === undefined) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = idb.open(databaseName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(storeName);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(reqError(request));
      });
    }
    return dbPromise;
  };

  // The inclusive prefix range: all keys k with prefix ≤ k ≤ prefix+'￿'. With fixed-width padded
  // keys this matches exactly the intended chunk/generation group and nothing beyond it.
  const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, `${prefix}￿`);

  return {
    put: (key, bytes) =>
      open().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const request = db
              .transaction(storeName, 'readwrite')
              .objectStore(storeName)
              .put(bytes, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(reqError(request));
          }),
      ),

    readPrefix: (prefix) =>
      open().then(
        (db) =>
          new Promise<Array<[string, Uint8Array]>>((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const range = prefixRange(prefix);
            const keysRequest = store.getAllKeys(range);
            const valuesRequest = store.getAll(range);
            transaction.oncomplete = () => {
              const keys = keysRequest.result;
              const values = valuesRequest.result as Uint8Array[];
              resolve(keys.map((key, index) => [String(key), values[index] as Uint8Array]));
            };
            transaction.onerror = () =>
              reject(transaction.error ?? new Error('indexedDB readPrefix failed'));
          }),
      ),

    keys: (prefix) =>
      open().then(
        (db) =>
          new Promise<string[]>((resolve, reject) => {
            const request = db
              .transaction(storeName, 'readonly')
              .objectStore(storeName)
              .getAllKeys(prefixRange(prefix));
            request.onsuccess = () => resolve(request.result.map((key) => String(key)));
            request.onerror = () => reject(reqError(request));
          }),
      ),

    deletePrefix: (prefix) =>
      open().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const request = db
              .transaction(storeName, 'readwrite')
              .objectStore(storeName)
              .delete(prefixRange(prefix));
            request.onsuccess = () => resolve();
            request.onerror = () => reject(reqError(request));
          }),
      ),
  };
}
