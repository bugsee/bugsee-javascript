import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeviceIdAsyncStore,
  type DeviceIdCookieStorage,
  type DeviceIdEnv,
  type DeviceIdLocalStorage,
  generateDeviceId,
  isValidDeviceId,
  peekBrowserDeviceId,
  realDeviceIdEnv,
  resetBrowserDeviceIdCache,
  resolveBrowserDeviceId,
} from './device-id';

const CACHE_URL = 'https://bugsee.local/device-id';

const VALID_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const VALID_ID_2 = 'b2c3d4e5-f6a7-4890-b123-456789abcdef';
const GARBAGE = 'not-a-uuid';

function fakeLocalStorage(initial: Record<string, string> = {}): DeviceIdLocalStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function fakeCookie(initial?: string): DeviceIdCookieStorage & { raw: () => string } {
  let value = initial;
  return {
    get: () => value,
    set: (v) => {
      value = v;
    },
    raw: () => value ?? '',
  };
}

function fakeAsyncStore(
  initial?: string,
): DeviceIdAsyncStore & { value: () => string | undefined } {
  let stored = initial;
  return {
    read: async () => stored,
    write: async (v) => {
      stored = v;
    },
    value: () => stored,
  };
}

function env(overrides: Partial<DeviceIdEnv> = {}): DeviceIdEnv {
  return {
    localStorage: fakeLocalStorage(),
    cookie: fakeCookie(),
    cookieStore: fakeAsyncStore(),
    indexedDB: fakeAsyncStore(),
    cache: fakeAsyncStore(),
    randomUUID: () => VALID_ID_2,
    isSecureContext: false,
    ...overrides,
  };
}

function fakeGlobalCookieStore(initial?: string) {
  let value = initial;
  return {
    get: async (name: string) => {
      if (name !== 'bugsee_device_id') return undefined;
      return value === undefined ? undefined : { value };
    },
    set: async (options: { name: string; value: string }) => {
      if (options.name === 'bugsee_device_id') value = options.value;
    },
    value: () => value,
  };
}

function stubGlobal<K extends keyof typeof globalThis>(
  key: K,
  value: (typeof globalThis)[K],
): void {
  vi.stubGlobal(key as string, value);
}

afterEach(() => {
  resetBrowserDeviceIdCache();
  vi.unstubAllGlobals();
});

async function seedIndexedDB(value: string): Promise<void> {
  const idb = globalThis.indexedDB;
  if (idb === undefined) throw new Error('indexedDB is not stubbed');
  await new Promise<void>((resolve, reject) => {
    const request = idb.open('bugsee-device-id', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => {
      const tx = request.result.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(value, 'device_id');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function readIndexedDBValue(): Promise<string | undefined> {
  const idb = globalThis.indexedDB;
  if (idb === undefined) return undefined;
  return await new Promise((resolve, reject) => {
    const request = idb.open('bugsee-device-id', 1);
    request.onsuccess = () => {
      const tx = request.result.transaction('meta', 'readonly');
      const getReq = tx.objectStore('meta').get('device_id');
      getReq.onsuccess = () => resolve(getReq.result as string | undefined);
      getReq.onerror = () => reject(getReq.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function fakeCaches(
  storage: Map<string, string> = new Map(),
  options: { openThrows?: boolean; textThrows?: boolean } = {},
): CacheStorage {
  return {
    delete: async () => false,
    has: async () => false,
    keys: async () => [],
    match: async () => undefined,
    open: async () => {
      if (options.openThrows) throw new Error('cache open failed');
      return {
        addAll: async () => undefined,
        delete: async () => false,
        keys: async () => [],
        match: async (url: string) => {
          const text = storage.get(url);
          if (text === undefined) return undefined;
          return {
            text: async () => {
              if (options.textThrows) throw new Error('cache text failed');
              return text;
            },
          } as Response;
        },
        matchAll: async () => [],
        put: async (url: string, response: Response) => {
          storage.set(url, await response.text());
        },
      } as Cache;
    },
  } as CacheStorage;
}

describe('isValidDeviceId', () => {
  it('accepts a UUID v4 and rejects garbage', () => {
    expect(isValidDeviceId(VALID_ID)).toBe(true);
    expect(isValidDeviceId(GARBAGE)).toBe(false);
    expect(isValidDeviceId('')).toBe(false);
    expect(isValidDeviceId(null)).toBe(false);
  });
});

describe('generateDeviceId', () => {
  it('uses randomUUID when available', () => {
    expect(generateDeviceId({ randomUUID: () => VALID_ID })).toBe(VALID_ID);
  });

  it('uses global crypto.getRandomValues when randomUUID is not injected', () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = i + 1;
    stubGlobal('crypto', {
      getRandomValues: (out: Uint8Array) => {
        out.set(bytes);
        return out;
      },
    } as Crypto);
    const id = generateDeviceId({});
    expect(isValidDeviceId(id)).toBe(true);
  });

  it('throws when crypto.getRandomValues is unavailable', () => {
    stubGlobal('crypto', undefined as unknown as Crypto);
    expect(() => generateDeviceId({})).toThrow('crypto.getRandomValues is unavailable');
  });

  it('falls back to getRandomValues as a UUID string', () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = i;
    const id = generateDeviceId({
      getRandomValues: (out) => {
        out.set(bytes);
        return out;
      },
    });
    expect(isValidDeviceId(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('resolveBrowserDeviceId', () => {
  it('generates and writes to all stores when none have a value', async () => {
    const local = fakeLocalStorage();
    const cookie = fakeCookie();
    const cookieStore = fakeAsyncStore();
    const idb = fakeAsyncStore();
    const cache = fakeAsyncStore();
    const e = env({ localStorage: local, cookie, cookieStore, indexedDB: idb, cache });

    const id = await resolveBrowserDeviceId(e);

    expect(id).toBe(VALID_ID_2);
    expect(local.getItem('bugsee.device_id')).toBe(VALID_ID_2);
    expect(cookie.get()).toBe(VALID_ID_2);
    expect(cookieStore.value()).toBe(VALID_ID_2);
    expect(idb.value()).toBe(VALID_ID_2);
    expect(cache.value()).toBe(VALID_ID_2);
  });

  it('prefers localStorage on reload and backfills cookie and async stores', async () => {
    const local = fakeLocalStorage({ 'bugsee.device_id': VALID_ID });
    const cookie = fakeCookie();
    const idb = fakeAsyncStore();
    const cache = fakeAsyncStore();
    const e = env({ localStorage: local, cookie, indexedDB: idb, cache });

    const id = await resolveBrowserDeviceId(e);
    expect(id).toBe(VALID_ID);
    expect(cookie.get()).toBe(VALID_ID);
    await vi.waitFor(() => {
      expect(idb.value()).toBe(VALID_ID);
      expect(cache.value()).toBe(VALID_ID);
    });
  });

  it('uses the cookie when localStorage throws and backfills other stores', async () => {
    const cookie = fakeCookie(VALID_ID);
    const idb = fakeAsyncStore();
    const cache = fakeAsyncStore();
    const local: DeviceIdLocalStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const e = env({ localStorage: local, cookie, indexedDB: idb, cache });

    const id = await resolveBrowserDeviceId(e);
    expect(id).toBe(VALID_ID);
    expect(cookie.get()).toBe(VALID_ID);
    await vi.waitFor(() => {
      expect(idb.value()).toBe(VALID_ID);
      expect(cache.value()).toBe(VALID_ID);
    });
  });

  it('ignores garbage stored values and generates a new id when every store is invalid', async () => {
    const local = fakeLocalStorage({ 'bugsee.device_id': GARBAGE });
    const cookie = fakeCookie(GARBAGE);
    const idb = fakeAsyncStore(GARBAGE);
    const cache = fakeAsyncStore(GARBAGE);
    const e = env({ localStorage: local, cookie, indexedDB: idb, cache });

    const id = await resolveBrowserDeviceId(e);
    expect(id).toBe(VALID_ID_2);
    expect(isValidDeviceId(local.getItem('bugsee.device_id'))).toBe(true);
  });

  it('returns the same id on two reads (cached per page)', async () => {
    const e = env({ localStorage: fakeLocalStorage({ 'bugsee.device_id': VALID_ID }) });
    const first = await resolveBrowserDeviceId(e);
    const second = await resolveBrowserDeviceId(e);
    expect(first).toBe(second);
    expect(first).toBe(VALID_ID);
  });

  it('recovers from indexedDB when sync stores are empty', async () => {
    const idb = fakeAsyncStore(VALID_ID);
    const e = env({ indexedDB: idb });
    const id = await resolveBrowserDeviceId(e);
    expect(id).toBe(VALID_ID);
    expect(e.localStorage?.getItem('bugsee.device_id')).toBe(VALID_ID);
  });

  it('recovers from cookieStore when sync stores are empty and heals the other stores', async () => {
    const cookieStore = fakeAsyncStore(VALID_ID);
    const local = fakeLocalStorage();
    const cookie = fakeCookie();
    const idb = fakeAsyncStore();
    const cache = fakeAsyncStore();
    const id = await resolveBrowserDeviceId({
      localStorage: local,
      cookie,
      cookieStore,
      indexedDB: idb,
      cache,
      randomUUID: () => VALID_ID_2,
    });
    expect(id).toBe(VALID_ID);
    expect(local.getItem('bugsee.device_id')).toBe(VALID_ID);
    expect(cookie.get()).toBe(VALID_ID);
    expect(idb.value()).toBe(VALID_ID);
    expect(cache.value()).toBe(VALID_ID);
  });

  it('swallows cookieStore read and write failures', async () => {
    const throwing: DeviceIdAsyncStore = {
      read: async () => {
        throw new Error('cookieStore read failed');
      },
      write: async () => {
        throw new Error('cookieStore write failed');
      },
    };
    const id = await resolveBrowserDeviceId(
      env({ cookieStore: throwing, randomUUID: () => VALID_ID_2 }),
    );
    expect(id).toBe(VALID_ID_2);
  });

  it('exposes the cached id through peekBrowserDeviceId after resolution', async () => {
    expect(peekBrowserDeviceId()).toBeUndefined();
    const e = env({ localStorage: fakeLocalStorage({ 'bugsee.device_id': VALID_ID }) });
    await resolveBrowserDeviceId(e);
    expect(peekBrowserDeviceId()).toBe(VALID_ID);
  });

  it('swallows async store read failures', async () => {
    const throwing: DeviceIdAsyncStore = {
      read: async () => {
        throw new Error('idb read failed');
      },
      write: async () => {},
    };
    const id = await resolveBrowserDeviceId(
      env({ indexedDB: throwing, cache: throwing, randomUUID: () => VALID_ID_2 }),
    );
    expect(id).toBe(VALID_ID_2);
  });

  it('reads from global localStorage and document.cookie when not injected', async () => {
    const ls = fakeLocalStorage({ 'bugsee.device_id': VALID_ID });
    stubGlobal('localStorage', ls);
    stubGlobal('document', { cookie: '' });
    const id = await resolveBrowserDeviceId({ randomUUID: () => VALID_ID_2 });
    expect(id).toBe(VALID_ID);
  });

  it('parses a device id from document.cookie when sync stores are otherwise empty', async () => {
    stubGlobal('document', {
      cookie: `session=abc; bugsee_device_id=${encodeURIComponent(VALID_ID)}; path=/`,
    });
    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      randomUUID: () => VALID_ID_2,
    });
    expect(id).toBe(VALID_ID);
  });

  it('ignores document cookies without a valid bugsee device id', async () => {
    stubGlobal('document', {
      cookie: `session=abc; malformed; bugsee_device_id=${GARBAGE}`,
    });
    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      randomUUID: () => VALID_ID_2,
    });
    expect(id).toBe(VALID_ID_2);
  });

  it('ignores document cookies that omit the bugsee device id name entirely', async () => {
    stubGlobal('document', { cookie: 'session=abc; malformed' });
    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      randomUUID: () => VALID_ID_2,
    });
    expect(id).toBe(VALID_ID_2);
  });

  it('swallows cookie read failures from an injected cookie store', async () => {
    const cookie: DeviceIdCookieStorage = {
      get: () => {
        throw new Error('cookie blocked');
      },
      set: () => {},
    };
    const id = await resolveBrowserDeviceId(env({ cookie, randomUUID: () => VALID_ID_2 }));
    expect(id).toBe(VALID_ID_2);
  });

  it('writes the cookie through document when no cookie seam is injected', async () => {
    let cookie = '';
    stubGlobal('document', {
      set cookie(value: string) {
        cookie = value;
      },
      get cookie() {
        return cookie;
      },
    });
    stubGlobal('location', { protocol: 'http:' });
    await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      randomUUID: () => VALID_ID_2,
    });
    expect(cookie).toContain(`bugsee_device_id=${encodeURIComponent(VALID_ID_2)}`);
  });
});

describe('realDeviceIdEnv', () => {
  it('returns the overrides unchanged', () => {
    const local = fakeLocalStorage();
    expect(realDeviceIdEnv({ localStorage: local })).toEqual({ localStorage: local });
  });
});

describe('default indexedDB store', () => {
  it('reads a persisted id, heals sync stores, and writes on generation', async () => {
    stubGlobal('indexedDB', new IDBFactory());
    await seedIndexedDB(VALID_ID);

    const local = fakeLocalStorage();
    const cookie = fakeCookie();
    const id = await resolveBrowserDeviceId({
      localStorage: local,
      cookie,
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID);
    expect(local.getItem('bugsee.device_id')).toBe(VALID_ID);
    expect(cookie.get()).toBe(VALID_ID);
  });

  it('generates and persists when indexedDB is empty', async () => {
    stubGlobal('indexedDB', new IDBFactory());

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID_2);
    expect(await readIndexedDBValue()).toBe(VALID_ID_2);
  });

  it('no-ops when indexedDB is missing', async () => {
    stubGlobal('indexedDB', undefined as unknown as IDBFactory);

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID_2);
  });

  it('swallows indexedDB open errors', async () => {
    stubGlobal('indexedDB', {
      open: () => {
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
          result: null,
        };
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    } as IDBFactory);

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });
    expect(id).toBe(VALID_ID_2);
  });

  it('swallows indexedDB get errors', async () => {
    stubGlobal('indexedDB', {
      open: () => {
        const db = {
          transaction: () => {
            const tx = {
              objectStore: () => ({
                get: () => {
                  const getReq = {
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                  };
                  queueMicrotask(() => getReq.onerror?.());
                  return getReq;
                },
                put: () => {
                  queueMicrotask(() => tx.oncomplete?.());
                },
              }),
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
            };
            return tx;
          },
          createObjectStore: () => ({}),
        };
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
          result: db,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as IDBFactory);

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });
    expect(id).toBe(VALID_ID_2);
  });

  it('swallows synchronous indexedDB open failures and transaction throws while reading', async () => {
    stubGlobal('indexedDB', {
      open: () => {
        throw new Error('sync open failed');
      },
    } as IDBFactory);
    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);

    resetBrowserDeviceIdCache();
    stubGlobal('indexedDB', {
      open: () => {
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
          result: {
            transaction: () => {
              throw new Error('transaction failed');
            },
            createObjectStore: () => ({}),
          },
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as IDBFactory);
    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);
  });

  it('swallows synchronous indexedDB open failures while writing', async () => {
    let opens = 0;
    stubGlobal('indexedDB', {
      open: () => {
        opens += 1;
        if (opens > 1) {
          throw new Error('sync open failed on write');
        }
        const db = {
          transaction: (_store: string, _mode: string) => {
            const tx = {
              objectStore: () => ({
                get: () => {
                  const getReq = {
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                    result: undefined,
                  };
                  queueMicrotask(() => getReq.onsuccess?.());
                  return getReq;
                },
                put: () => {
                  queueMicrotask(() => tx.oncomplete?.());
                },
              }),
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
            };
            return tx;
          },
          createObjectStore: () => ({}),
        };
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
          result: db,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as IDBFactory);
    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);
  });

  it('swallows indexedDB transaction throws while writing', async () => {
    stubGlobal('indexedDB', {
      open: () => {
        const db = {
          transaction: (_store: string, mode: string) => {
            if (mode === 'readwrite') {
              throw new Error('transaction failed on write');
            }
            const tx = {
              objectStore: () => ({
                get: () => {
                  const getReq = {
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                    result: undefined,
                  };
                  queueMicrotask(() => getReq.onsuccess?.());
                  return getReq;
                },
                put: () => {
                  queueMicrotask(() => tx.oncomplete?.());
                },
              }),
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
            };
            return tx;
          },
          createObjectStore: () => ({}),
        };
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
          result: db,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as IDBFactory);
    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);
  });

  it('swallows indexedDB write transaction errors', async () => {
    stubGlobal('indexedDB', {
      open: () => {
        const db = {
          transaction: () => {
            const tx = {
              objectStore: () => ({
                get: () => {
                  const getReq = {
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                    result: undefined,
                  };
                  queueMicrotask(() => getReq.onsuccess?.());
                  return getReq;
                },
                put: () => {},
              }),
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
            };
            queueMicrotask(() => tx.onerror?.());
            return tx;
          },
          createObjectStore: () => ({}),
        };
        const request = {
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
          result: db,
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    } as IDBFactory);

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });
    expect(id).toBe(VALID_ID_2);
  });
});

describe('default cookieStore', () => {
  it('reads a persisted id and heals sync stores', async () => {
    const store = fakeGlobalCookieStore(VALID_ID);
    stubGlobal('cookieStore', store);

    const local = fakeLocalStorage();
    const id = await resolveBrowserDeviceId({
      localStorage: local,
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID);
    expect(local.getItem('bugsee.device_id')).toBe(VALID_ID);
  });

  it('generates and persists when cookieStore is empty', async () => {
    const store = fakeGlobalCookieStore();
    stubGlobal('cookieStore', store);

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID_2);
    expect(store.value()).toBe(VALID_ID_2);
  });

  it('no-ops when cookieStore is missing', async () => {
    stubGlobal('cookieStore', undefined as unknown as CookieStore);

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID_2);
  });

  it('swallows cookieStore get and set failures', async () => {
    stubGlobal('cookieStore', {
      get: async () => {
        throw new Error('get failed');
      },
      set: async () => {
        throw new Error('set failed');
      },
    });

    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);

    resetBrowserDeviceIdCache();
    stubGlobal('cookieStore', {
      get: async () => ({ value: '' }),
      set: async () => {
        throw new Error('set failed');
      },
    });
    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);
  });
});

describe('default cache store', () => {
  it('reads a persisted id and heals sync stores', async () => {
    const storage = new Map([[CACHE_URL, VALID_ID]]);
    stubGlobal('caches', fakeCaches(storage));

    const local = fakeLocalStorage();
    const id = await resolveBrowserDeviceId({
      localStorage: local,
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID);
    expect(local.getItem('bugsee.device_id')).toBe(VALID_ID);
  });

  it('generates and persists when the cache is empty', async () => {
    const storage = new Map<string, string>();
    stubGlobal('caches', fakeCaches(storage));

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID_2);
    expect(storage.get(CACHE_URL)).toBe(VALID_ID_2);
  });

  it('treats an empty cached body as absent', async () => {
    const storage = new Map([[CACHE_URL, '']]);
    stubGlobal('caches', fakeCaches(storage));

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID_2);
  });

  it('no-ops when caches is missing', async () => {
    stubGlobal('caches', undefined as unknown as CacheStorage);

    const id = await resolveBrowserDeviceId({
      localStorage: fakeLocalStorage(),
      cookie: fakeCookie(),
      randomUUID: () => VALID_ID_2,
    });

    expect(id).toBe(VALID_ID_2);
  });

  it('swallows cache read and write failures', async () => {
    stubGlobal('caches', fakeCaches(new Map(), { openThrows: true }));
    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);

    resetBrowserDeviceIdCache();
    stubGlobal('caches', fakeCaches(new Map([[CACHE_URL, VALID_ID]]), { textThrows: true }));
    expect(
      await resolveBrowserDeviceId({
        localStorage: fakeLocalStorage(),
        cookie: fakeCookie(),
        randomUUID: () => VALID_ID_2,
      }),
    ).toBe(VALID_ID_2);
  });
});
