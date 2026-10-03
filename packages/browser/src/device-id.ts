// Stable, non-fingerprinting browser device id. Generated once per browser profile, persisted across
// sessions in every durable first-party store that works, with cross-store healing when values diverge.
// Resolution is cached per page; launch awaits the async stores before returning.

const LOCAL_STORAGE_KEY = 'bugsee.device_id';
const COOKIE_NAME = 'bugsee_device_id';
const IDB_DATABASE = 'bugsee-device-id';
const IDB_STORE = 'meta';
const IDB_KEY = 'device_id';
const CACHE_NAME = 'bugsee-device-id';
/** Synthetic first-party cache URL — not fetched over the network. */
const CACHE_URL = 'https://bugsee.local/device-id';

/** UUID v4 (or UUID-shaped hex) — reject garbage before trusting a stored value. */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDeviceId(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_LIKE.test(value);
}

/** Injectable storage seams for tests (no real browser required). */
export interface DeviceIdLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DeviceIdCookieStorage {
  get(): string | undefined;
  set(value: string): void;
}

export interface DeviceIdAsyncStore {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

export interface DeviceIdEnv {
  localStorage?: DeviceIdLocalStorage;
  cookie?: DeviceIdCookieStorage;
  /** Cookie Store API — async first-party cookies (Chromium); complements `document.cookie`. */
  cookieStore?: DeviceIdAsyncStore;
  indexedDB?: DeviceIdAsyncStore;
  /** Cache API — a durable first-party store separate from capture IndexedDB. */
  cache?: DeviceIdAsyncStore;
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
  /** When true, `location.protocol === 'https:'` gates the Secure cookie flag. */
  isSecureContext?: boolean;
}

let cachedDeviceId: string | undefined;
let resolutionPromise: Promise<string> | undefined;

export function peekBrowserDeviceId(): string | undefined {
  return cachedDeviceId;
}

export function resetBrowserDeviceIdCache(): void {
  cachedDeviceId = undefined;
  resolutionPromise = undefined;
}

export function generateDeviceId(env: DeviceIdEnv = {}): string {
  if (env.randomUUID !== undefined) return env.randomUUID();
  const crypto = (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  const getRandomValues = env.getRandomValues ?? crypto?.getRandomValues?.bind(crypto);
  if (getRandomValues === undefined) {
    throw new Error('crypto.getRandomValues is unavailable');
  }
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  // RFC 4122 v4
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readLocalStorage(env: DeviceIdEnv): string | undefined {
  try {
    const store = env.localStorage ?? globalThis.localStorage;
    const value = store?.getItem(LOCAL_STORAGE_KEY);
    return isValidDeviceId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseCookieValue(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = raw.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq);
    if (name !== COOKIE_NAME) continue;
    const value = decodeURIComponent(trimmed.slice(eq + 1));
    return isValidDeviceId(value) ? value : undefined;
  }
  return undefined;
}

function readCookie(env: DeviceIdEnv): string | undefined {
  try {
    if (env.cookie !== undefined) {
      const value = env.cookie.get();
      return isValidDeviceId(value) ? value : undefined;
    }
    const raw = (globalThis as { document?: { cookie?: string } }).document?.cookie;
    return parseCookieValue(raw);
  } catch {
    return undefined;
  }
}

function writeLocalStorage(env: DeviceIdEnv, value: string): void {
  try {
    const store = env.localStorage ?? globalThis.localStorage;
    store?.setItem(LOCAL_STORAGE_KEY, value);
  } catch {
    // private mode / security errors — per-store swallow
  }
}

function writeCookie(env: DeviceIdEnv, value: string): void {
  try {
    if (env.cookie !== undefined) {
      env.cookie.set(value);
      return;
    }
    const secure =
      env.isSecureContext ??
      (globalThis as { location?: { protocol?: string } }).location?.protocol === 'https:';
    const maxAge = 365 * 24 * 60 * 60;
    const encoded = encodeURIComponent(value);
    const secureFlag = secure ? '; Secure' : '';
    const doc = (globalThis as { document?: { cookie?: string } }).document;
    if (doc === undefined) return;
    doc.cookie = `${COOKIE_NAME}=${encoded}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secureFlag}`;
  } catch {
    // swallow
  }
}

async function readIndexedDB(env: DeviceIdEnv): Promise<string | undefined> {
  try {
    const store = env.indexedDB ?? createDefaultIndexedDBStore();
    const value = await store.read();
    return isValidDeviceId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeIndexedDB(env: DeviceIdEnv, value: string): Promise<void> {
  try {
    const store = env.indexedDB ?? createDefaultIndexedDBStore();
    await store.write(value);
  } catch {
    // swallow
  }
}

async function readCookieStore(env: DeviceIdEnv): Promise<string | undefined> {
  try {
    const store = env.cookieStore ?? createDefaultCookieStore();
    const value = await store.read();
    return isValidDeviceId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeCookieStore(env: DeviceIdEnv, value: string): Promise<void> {
  try {
    const store = env.cookieStore ?? createDefaultCookieStore();
    await store.write(value);
  } catch {
    // swallow
  }
}

async function readCacheStore(env: DeviceIdEnv): Promise<string | undefined> {
  try {
    const store = env.cache ?? createDefaultCacheStore();
    const value = await store.read();
    return isValidDeviceId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeCacheStore(env: DeviceIdEnv, value: string): Promise<void> {
  try {
    const store = env.cache ?? createDefaultCacheStore();
    await store.write(value);
  } catch {
    // swallow
  }
}

function pickCanonical(
  local: string | undefined,
  cookie: string | undefined,
  cookieStore: string | undefined,
  idb: string | undefined,
  cache: string | undefined,
): string | undefined {
  return local ?? cookie ?? cookieStore ?? idb ?? cache;
}

async function healStores(env: DeviceIdEnv, canonical: string): Promise<void> {
  const local = readLocalStorage(env);
  if (local !== canonical) writeLocalStorage(env, canonical);

  const cookie = readCookie(env);
  if (cookie !== canonical) writeCookie(env, canonical);

  const cookieStore = await readCookieStore(env);
  if (cookieStore !== canonical) await writeCookieStore(env, canonical);

  const idb = await readIndexedDB(env);
  if (idb !== canonical) await writeIndexedDB(env, canonical);

  const cache = await readCacheStore(env);
  if (cache !== canonical) await writeCacheStore(env, canonical);
}

async function resolveOnce(env: DeviceIdEnv): Promise<string> {
  const fromLocal = readLocalStorage(env);
  const fromCookie = readCookie(env);
  const syncCanonical = pickCanonical(fromLocal, fromCookie, undefined, undefined, undefined);
  if (syncCanonical !== undefined) {
    void healStores(env, syncCanonical);
    return syncCanonical;
  }

  const [fromCookieStore, fromIdb, fromCache] = await Promise.all([
    readCookieStore(env),
    readIndexedDB(env),
    readCacheStore(env),
  ]);
  const canonical = pickCanonical(undefined, undefined, fromCookieStore, fromIdb, fromCache);
  if (canonical !== undefined) {
    await healStores(env, canonical);
    return canonical;
  }

  const generated = generateDeviceId(env);
  await healStores(env, generated);
  return generated;
}

/** Resolve (once per page) and cache the browser device id. Launch awaits this. */
export async function resolveBrowserDeviceId(env: DeviceIdEnv = {}): Promise<string> {
  if (cachedDeviceId !== undefined) return cachedDeviceId;
  if (resolutionPromise === undefined) {
    resolutionPromise = resolveOnce(env).then((id) => {
      cachedDeviceId = id;
      return id;
    });
  }
  return resolutionPromise;
}

function createDefaultIndexedDBStore(): DeviceIdAsyncStore {
  const idb = globalThis.indexedDB;
  return {
    read: () =>
      new Promise<string | undefined>((resolve) => {
        if (idb === undefined) {
          resolve(undefined);
          return;
        }
        try {
          const request = idb.open(IDB_DATABASE, 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore(IDB_STORE);
          };
          request.onsuccess = () => {
            try {
              const db = request.result;
              const tx = db.transaction(IDB_STORE, 'readonly');
              const getReq = tx.objectStore(IDB_STORE).get(IDB_KEY);
              getReq.onsuccess = () => {
                const raw = getReq.result;
                resolve(typeof raw === 'string' ? raw : undefined);
              };
              getReq.onerror = () => resolve(undefined);
            } catch {
              resolve(undefined);
            }
          };
          request.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
    write: (value) =>
      new Promise<void>((resolve) => {
        if (idb === undefined) {
          resolve();
          return;
        }
        try {
          const request = idb.open(IDB_DATABASE, 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore(IDB_STORE);
          };
          request.onsuccess = () => {
            try {
              const db = request.result;
              const tx = db.transaction(IDB_STORE, 'readwrite');
              tx.objectStore(IDB_STORE).put(value, IDB_KEY);
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
            } catch {
              resolve();
            }
          };
          request.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  };
}

const COOKIE_STORE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function createDefaultCookieStore(): DeviceIdAsyncStore {
  const cookieStore = (globalThis as { cookieStore?: CookieStore }).cookieStore;
  return {
    read: async () => {
      if (cookieStore === undefined) return undefined;
      try {
        const entry = await cookieStore.get(COOKIE_NAME);
        const value = entry?.value;
        return typeof value === 'string' && value !== '' ? value : undefined;
      } catch {
        return undefined;
      }
    },
    write: async (value) => {
      if (cookieStore === undefined) return;
      try {
        await cookieStore.set({
          name: COOKIE_NAME,
          value,
          path: '/',
          sameSite: 'lax',
          expires: Date.now() + COOKIE_STORE_MAX_AGE_MS,
        });
      } catch {
        // swallow
      }
    },
  };
}

function createDefaultCacheStore(): DeviceIdAsyncStore {
  const caches = (globalThis as { caches?: CacheStorage }).caches;
  return {
    read: async () => {
      if (caches === undefined) return undefined;
      try {
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match(CACHE_URL);
        if (response === undefined) return undefined;
        const text = await response.text();
        return text === '' ? undefined : text;
      } catch {
        return undefined;
      }
    },
    write: async (value) => {
      if (caches === undefined) return;
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(
          CACHE_URL,
          new Response(value, { headers: { 'Content-Type': 'text/plain' } }),
        );
      } catch {
        // swallow
      }
    },
  };
}

/** Default env wiring for production launch. */
export function realDeviceIdEnv(overrides: DeviceIdEnv = {}): DeviceIdEnv {
  return overrides;
}
