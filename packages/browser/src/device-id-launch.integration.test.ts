import type { HttpResponse, HttpTransport } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeviceIdAsyncStore,
  type DeviceIdCookieStorage,
  type DeviceIdEnv,
  type DeviceIdLocalStorage,
  resetBrowserDeviceIdCache,
} from './device-id';
import type { BrowserProbe } from './environment';
import { launchCore } from './launch';

const probe: BrowserProbe = {
  userAgent: () =>
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

const VALID_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

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

function fakeCookie(initial?: string): DeviceIdCookieStorage {
  let value = initial;
  return {
    get: () => value,
    set: (v) => {
      value = v;
    },
  };
}

function fakeAsyncStore(initial?: string): DeviceIdAsyncStore {
  let stored = initial;
  return {
    read: async () => stored,
    write: async (v) => {
      stored = v;
    },
  };
}

const jsonBody = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

function okTransport(): HttpTransport {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'tok' }) };
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
}

function fakeWindow() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    win: {
      addEventListener(type: string, listener: (event: Event) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: (event: Event) => void) {
        listeners.get(type)?.delete(listener);
      },
    },
  };
}

afterEach(() => {
  resetBrowserDeviceIdCache();
});

describe('device id launch integration', () => {
  it('threads the resolved device id into environment hardware.device_id', async () => {
    const deviceIdEnv: DeviceIdEnv = {
      localStorage: fakeLocalStorage({ 'bugsee.device_id': VALID_ID }),
      cookie: fakeCookie(),
      indexedDB: fakeAsyncStore(),
      cache: fakeAsyncStore(),
    };
    const { win } = fakeWindow();
    const { internals } = await launchCore('tok', {
      transport: okTransport(),
      window: win as Window,
      carrier: {},
      systemProbe: probe,
      deviceIdEnv,
      captureStore: undefined,
      persist: false,
      recover: false,
    });
    expect(internals).toBeDefined();
    expect((internals?.getEnvironment().hardware as { device_id: string }).device_id).toBe(
      VALID_ID,
    );
    expect(internals?.deviceId).toBe(VALID_ID);
  });
});
