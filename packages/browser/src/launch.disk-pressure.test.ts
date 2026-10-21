import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import {
  type CaptureStore,
  createMemoryCaptureStore,
  DiskPressureToken,
  type StoredEntry,
} from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeviceIdLocalStorage, resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// C7 WIRING through the real browser launch: `captureDiskSpace` builds one DiskPressure fed by the window's
// `navigator.storage.estimate()` headroom, hands it to the IndexedDB store (error sink included), and drives the
// `capture` trace, which exists only while rrweb replay is configured and records only once the recorder is real.
const { registerReplay } = vi.hoisted(() => ({ registerReplay: vi.fn() }));
vi.mock('@bugsee/replay', () => ({ registerReplay }));
const { idbStoreSpy } = vi.hoisted(() => ({ idbStoreSpy: vi.fn() }));
vi.mock('@bugsee/browser-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/browser-utils')>();
  return {
    ...actual,
    createIdbChunkCaptureStore: (...args: Parameters<typeof actual.createIdbChunkCaptureStore>) => {
      idbStoreSpy(args[1]);
      return actual.createIdbChunkCaptureStore(...args);
    },
  };
});

const MB = 1_000_000;
const DEVICE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const probe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};
const deviceIdLocalStorage = (): DeviceIdLocalStorage => {
  const data = new Map([['bugsee.device_id', DEVICE_ID]]);
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const freeLocks: LockManagerLike = {
  request(name, options, callback) {
    if (options.ifAvailable) return Promise.resolve(callback({ name }));
    void callback({ name });
    return new Promise<never>(() => {});
  },
};
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const clients: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop(0)));
  resetBrowserDeviceIdCache();
  vi.clearAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

function setup(over: Partial<BugseeLaunchOptions> = {}, estimate = { usage: 0, quota: 900 * MB }) {
  const store: CaptureStore = createMemoryCaptureStore();
  const state = { ...estimate };
  const estimateFn = vi.fn(async () => ({ usage: state.usage, quota: state.quota }));
  const intervals: Array<{ cb: () => void; ms: number }> = [];
  const window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    navigator: { storage: { estimate: estimateFn, persisted: async () => false } },
  } as unknown as Window;
  const document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
  const options: BugseeLaunchOptions = {
    window,
    document,
    transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    systemProbe: probe,
    captureNetwork: false,
    captureViewHierarchy: false,
    captureInteractions: false,
    scheduler: {
      setInterval: (cb: () => void, ms: number) => {
        intervals.push({ cb, ms });
        return intervals.length;
      },
      clearInterval: () => {},
    },
    indexedDB: new IDBFactory(),
    locks: freeLocks,
    deviceIdEnv: { localStorage: deviceIdLocalStorage(), randomUUID: () => DEVICE_ID },
    captureStore: store,
    ...over,
  };
  return {
    options,
    store,
    state,
    estimateFn,
    intervals,
    tick: () => {
      for (const i of intervals) i.cb();
    },
  };
}

const launched = async (options: BugseeLaunchOptions): Promise<Bugsee> => {
  const client = await launch('tok', options);
  clients.push(client);
  return client;
};

const captureStates = async (store: CaptureStore): Promise<string[]> => {
  const snap = store.snapshot();
  const all = await snap.drainAll();
  snap.release();
  return (all.get('traces.system') ?? [])
    .map(
      (r: StoredEntry) =>
        (JSON.parse(r.serialized) as { data: { name?: string; value?: { state?: string } } }).data,
    )
    .filter((e) => e.name === 'capture')
    .map((e) => e.value?.state as string);
};

describe('launch — the `capture` trace (C7)', () => {
  it('writes active once the replay recorder is real, then follows blackout both ways', async () => {
    registerReplay.mockReturnValue({});
    const h = setup();
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    client.startBlackout();
    client.endBlackout();
    await settle();
    expect(await captureStates(h.store)).toEqual(['active', 'blackout', 'active']);
  });

  it('writes NOTHING before the recorder exists, and never claims active when replay did not start (DOM-less)', async () => {
    registerReplay.mockReturnValue(undefined);
    const h = setup();
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    client.startBlackout();
    await settle();
    expect(await captureStates(h.store)).toEqual([]);
  });

  it('writes no capture trace when replay is off', async () => {
    registerReplay.mockReturnValue({});
    const h = setup({ replay: false });
    const client = await launched(h.options);
    client.startBlackout();
    await settle();
    expect(registerReplay).not.toHaveBeenCalled();
    expect(await captureStates(h.store)).toEqual([]);
  });

  it('writes no capture trace on a replay-less launch even when the disk is low (no visual capture, no `capture`)', async () => {
    registerReplay.mockReturnValue({});
    const h = setup({ replay: false, captureDiskSpace: true });
    const client = await launched(h.options);
    await settle();
    h.state.quota = 5 * MB;
    h.tick();
    await settle();
    expect(client.getService(DiskPressureToken).level()).toBe('none'); // the protection still applies
    expect(await captureStates(h.store)).toEqual([]);
  });

  it('writes none when the host owns the name (WebView / Electron renderer)', async () => {
    registerReplay.mockReturnValue({});
    const h = setup({ hostOwnedTraces: ['capture'] });
    await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    expect(await captureStates(h.store)).toEqual([]);
  });

  it('writes the disk states from storage headroom, which outrank blackout, and recovers with hysteresis', async () => {
    registerReplay.mockReturnValue({});
    const h = setup({ captureDiskSpace: true });
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    h.state.quota = 40 * MB; // headroom 40 MB: low
    h.tick();
    await settle();
    client.startBlackout();
    h.state.quota = 5 * MB; // headroom 5 MB: none
    h.tick();
    await settle();
    h.state.quota = 55 * MB; // 55 MB: still low (needs 20 MB to leave none)
    h.tick();
    await settle();
    h.state.quota = 900 * MB;
    h.tick();
    await settle();
    expect(await captureStates(h.store)).toEqual([
      'active',
      'low_disk_space',
      'no_disk_space',
      'low_disk_space',
      'blackout',
    ]);
  });
});

describe('launch — captureDiskSpace pressure (C7)', () => {
  it('is registered, fed by quota - usage, and polls every 30 s once headroom is under 500 MB', async () => {
    registerReplay.mockReturnValue({});
    const h = setup({ captureDiskSpace: true }, { usage: 0, quota: 900 * MB });
    const client = await launched(h.options);
    await settle();
    const pressure = client.getService(DiskPressureToken);
    expect(pressure.level()).toBe('normal');
    expect(h.intervals.map((i) => i.ms)).not.toContain(30_000);
    h.state.quota = 400 * MB;
    h.tick();
    await settle();
    expect(h.intervals.map((i) => i.ms)).toContain(30_000);
    h.state.usage = 360 * MB;
    h.tick();
    await settle();
    expect(pressure.level()).toBe('low');
  });

  it('the feed alone arms the poll on the launch scheduler (no system traces needed)', async () => {
    const h = setup({ captureDiskSpace: true, captureSystemTraces: false });
    await launched(h.options);
    await settle();
    expect(h.estimateFn).toHaveBeenCalled();
    expect(h.intervals.map((i) => i.ms)).toContain(300_000);
  });

  it('is absent without the opt-in (and for a non-boolean-true value): no pressure, no extra polling', async () => {
    for (const v of [undefined, false, 'true', 1, null]) {
      const h = setup({
        ...(v === undefined ? {} : { captureDiskSpace: v as unknown as boolean }),
      });
      const client = await launched(h.options);
      expect(() => client.getService(DiskPressureToken), String(v)).toThrow();
      expect(
        h.intervals.map((i) => i.ms),
        String(v),
      ).not.toContain(30_000);
    }
  });

  it('an unusable estimate never creates pressure', async () => {
    const h = setup({ captureDiskSpace: true });
    const client = await launched(h.options);
    await settle();
    for (const bad of [
      { usage: Number.NaN, quota: 5 * MB },
      { usage: 10 * MB, quota: 5 * MB }, // usage over quota: padding, ignored
      { usage: 1, quota: undefined as unknown as number },
    ]) {
      Object.assign(h.state, bad);
      h.tick();
      await settle();
      expect(client.getService(DiskPressureToken).level()).toBe('normal');
    }
  });

  it('hands the pressure to the IndexedDB store and routes its error sink through noteWriteError', async () => {
    const onError = vi.fn();
    const h = setup({ captureDiskSpace: true, persist: true, onError, captureStore: undefined });
    const client = await launched(h.options);
    const given = idbStoreSpy.mock.calls.at(-1)?.[0] as {
      diskPressure?: unknown;
      onError?: (e: unknown) => void;
    };
    expect(given.diskPressure).toBe(client.getService(DiskPressureToken));
    const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    given.onError?.(quota);
    expect(client.getService(DiskPressureToken).level()).toBe('none');
    expect(onError).toHaveBeenCalledWith(quota);
  });

  it('works without a host onError (the sink still pins, nothing throws)', async () => {
    const h = setup({ captureDiskSpace: true, persist: true, captureStore: undefined });
    const client = await launched(h.options);
    const given = idbStoreSpy.mock.calls.at(-1)?.[0] as { onError?: (e: unknown) => void };
    expect(() => given.onError?.({ name: 'QuotaExceededError' })).not.toThrow();
    expect(client.getService(DiskPressureToken).level()).toBe('none');
  });

  it('gives the IndexedDB store no pressure without the opt-in', async () => {
    const h = setup({ persist: true, captureStore: undefined });
    await launched(h.options);
    expect(
      (idbStoreSpy.mock.calls.at(-1)?.[0] as { diskPressure?: unknown }).diskPressure,
    ).toBeUndefined();
  });

  it('stop() releases the poll: later ticks no longer move the state', async () => {
    const h = setup({ captureDiskSpace: true });
    const client = await launched(h.options);
    await settle();
    await client.stop(0);
    h.state.quota = 5 * MB;
    h.tick();
    await settle();
    expect(client.getService(DiskPressureToken).level()).toBe('normal');
  });
});
