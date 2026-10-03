import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeviceIdAsyncStore,
  type DeviceIdCookieStorage,
  type DeviceIdEnv,
  type DeviceIdLocalStorage,
  generateDeviceId,
  isValidDeviceId,
  resetBrowserDeviceIdCache,
  resolveBrowserDeviceId,
} from './device-id';

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
    indexedDB: fakeAsyncStore(),
    cache: fakeAsyncStore(),
    randomUUID: () => VALID_ID_2,
    isSecureContext: false,
    ...overrides,
  };
}

afterEach(() => {
  resetBrowserDeviceIdCache();
});

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
    const idb = fakeAsyncStore();
    const cache = fakeAsyncStore();
    const e = env({ localStorage: local, cookie, indexedDB: idb, cache });

    const id = await resolveBrowserDeviceId(e);

    expect(id).toBe(VALID_ID_2);
    expect(local.getItem('bugsee.device_id')).toBe(VALID_ID_2);
    expect(cookie.get()).toBe(VALID_ID_2);
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
});
