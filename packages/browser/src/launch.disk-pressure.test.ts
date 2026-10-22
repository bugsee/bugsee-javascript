import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import {
  CaptureStoreToken,
  createMemoryCaptureStore,
  DiskPressureToken,
  type StoredEntry,
} from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeviceIdLocalStorage, resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// C7 WIRING through the real browser launch: where a DURABLE (IndexedDB) store exists, ONE DiskPressure is built BY DEFAULT
// (iOS runs the protection always; `diskProtection: false` opts out), fed by the window's `navigator.storage.estimate()`
// headroom and handed to the store with its health hooks. `captureDiskSpace` is only the telemetry: the `capture`
// trace's disk states, which exist only while rrweb replay is configured and the recorder is real.
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

const MB = 1024 * 1024;
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
  const store = createMemoryCaptureStore();
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
/** A launch with the default DURABLE store (IndexedDB over the injected factory). */
const durable = (
  over: Partial<BugseeLaunchOptions> = {},
  estimate?: { usage: number; quota: number },
) => setup({ persist: true, captureStore: undefined, ...over }, estimate);

const launched = async (options: BugseeLaunchOptions): Promise<Bugsee> => {
  const client = await launch('tok', options);
  clients.push(client);
  return client;
};

const captureStates = async (store: {
  snapshot(): { drainAll(): Promise<Map<string, StoredEntry[]>>; release(): void };
}): Promise<string[]> => {
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
const statesOf = (client: Bugsee) => captureStates(client.getService(CaptureStoreToken));

describe('launch — the `capture` trace (C7)', () => {
  it('writes active once the replay recorder is real, then follows blackout both ways', async () => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
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
    const h = durable({ captureDiskSpace: true });
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    client.startBlackout();
    h.state.quota = 5 * MB;
    h.tick();
    await settle();
    expect(await statesOf(client)).toEqual([]);
  });

  it('writes no capture trace when replay is off, even with the telemetry on and a low disk (no recorder, no claim)', async () => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
    const h = durable({ replay: false, captureDiskSpace: true });
    const client = await launched(h.options);
    await settle();
    h.state.quota = 5 * MB;
    h.tick();
    await settle();
    expect(registerReplay).not.toHaveBeenCalled();
    expect(client.getService(DiskPressureToken).level()).toBe('none'); // the protection still applies
    expect(await statesOf(client)).toEqual([]);
  });

  it('writes none when the host owns the name (WebView / Electron renderer)', async () => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
    const h = setup({ hostOwnedTraces: ['capture'] });
    await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    expect(await captureStates(h.store)).toEqual([]);
  });

  it('with the telemetry on, writes the disk states from storage headroom (they outrank blackout) and recovers with hysteresis', async () => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
    const h = durable({ captureDiskSpace: true });
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    h.state.quota = 40 * MB; // headroom 40 MiB: low
    h.tick();
    await settle();
    client.startBlackout();
    h.state.quota = 5 * MB; // 5 MiB: none
    h.tick();
    await settle();
    h.state.quota = 55 * MB; // 55 MiB: still low (needs 20 MiB to leave none)
    h.tick();
    await settle();
    h.state.quota = 900 * MB;
    h.tick();
    await settle();
    expect(await statesOf(client)).toEqual([
      'active',
      'low_disk_space',
      'no_disk_space',
      'low_disk_space',
      'blackout',
    ]);
  });

  it('without the telemetry the protection still runs but the trace carries NO disk states', async () => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
    const h = durable();
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    h.state.quota = 5 * MB;
    h.tick();
    await settle();
    expect(client.getService(DiskPressureToken).level()).toBe('none');
    expect(await statesOf(client)).toEqual(['active']);
  });
});

describe('launch — disk-pressure protection (C7)', () => {
  it('is ON by default with a durable store, fed by quota - usage, polling every 30 s once headroom is under 500 MiB', async () => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
    const h = durable({}, { usage: 0, quota: 900 * MB });
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

  it('diskProtection:false opts out: no pressure and no extra polling', async () => {
    const h = durable({ diskProtection: false });
    const client = await launched(h.options);
    expect(() => client.getService(DiskPressureToken)).toThrow();
    expect(h.intervals.map((i) => i.ms)).not.toContain(30_000);
  });

  it.each([
    'false',
    0,
    null,
    'no',
  ])('diskProtection %j is not a boolean false: the protection stays ON', async (v) => {
    const h = durable({ diskProtection: v as unknown as boolean, onError: () => {} });
    const client = await launched(h.options);
    expect(client.getService(DiskPressureToken)).toBeDefined();
    await client.stop(0);
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('is absent when persist is off and the store is the in-memory default (no IndexedDB view at all)', async () => {
    const h = setup({ persist: false, captureStore: undefined });
    const client = await launched(h.options);
    expect(() => client.getService(DiskPressureToken)).toThrow();
  });

  it('is absent when an injected captureStore replaces the IndexedDB store, even with persist on', async () => {
    const h = setup({ persist: true });
    const client = await launched(h.options);
    expect(() => client.getService(DiskPressureToken)).toThrow();
  });

  it('is absent with no durable store (persist off, or an injected captureStore): nothing is persisted, nothing polled', async () => {
    const h = setup(); // an injected in-memory captureStore
    const client = await launched(h.options);
    expect(() => client.getService(DiskPressureToken)).toThrow();
    h.state.quota = 5 * MB;
    h.tick();
    await settle();
    expect(h.intervals.map((i) => i.ms)).not.toContain(30_000); // no fast-cadence seams without a pressure to feed
  });

  it('captureDiskSpace with no durable store says so ONCE through onError', async () => {
    const onError = vi.fn();
    const h = setup({ captureDiskSpace: true, onError });
    await launched(h.options);
    const mine = onError.mock.calls.filter((c) =>
      /captureDiskSpace needs a durable capture store/.test(String((c[0] as Error).message)),
    );
    expect(mine).toHaveLength(1);
  });

  it('captureDiskSpace with no durable store and no onError stays silent', async () => {
    const h = setup({ captureDiskSpace: true });
    await expect(launched(h.options)).resolves.toBeDefined();
  });

  it('a launch without the telemetry is not told anything about it', async () => {
    const onError = vi.fn();
    const h = setup({ onError });
    await launched(h.options);
    expect(
      onError.mock.calls.some((c) => /captureDiskSpace/.test(String((c[0] as Error).message))),
    ).toBe(false);
  });

  it('the feed alone arms the poll on the launch scheduler (no system traces needed)', async () => {
    const h = durable({ captureSystemTraces: false });
    await launched(h.options);
    await settle();
    expect(h.estimateFn).toHaveBeenCalled();
    expect(h.intervals.map((i) => i.ms)).toContain(300_000);
  });

  it('an unusable estimate never creates pressure', async () => {
    const h = durable();
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

  it('hands the pressure and the health hooks to the IndexedDB store: a refused write pins none, a healthy reading does not undo it, a successful write does', async () => {
    const onError = vi.fn();
    const h = durable({ onError });
    const client = await launched(h.options);
    const given = idbStoreSpy.mock.calls.at(-1)?.[0] as {
      diskPressure?: unknown;
      onError?: unknown;
      onWriteFailure: (e: unknown) => void;
      onWriteRecovered: () => void;
    };
    const pressure = client.getService(DiskPressureToken);
    expect(given.diskPressure).toBe(pressure);
    expect(given.onError).toBe(onError); // host reporting is untouched
    given.onWriteFailure(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }));
    expect(pressure.level()).toBe('none');
    h.state.quota = 900 * MB;
    h.tick();
    await settle();
    expect(pressure.level()).toBe('none');
    given.onWriteRecovered();
    expect(pressure.level()).toBe('normal');
  });

  it('gives the IndexedDB store neither pressure nor hooks when the protection is off', async () => {
    const h = durable({ diskProtection: false });
    await launched(h.options);
    const given = idbStoreSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(given.diskPressure).toBeUndefined();
    expect(given.onWriteFailure).toBeUndefined();
  });

  it('restarts the replay recorder when persistence resumes (a fresh FullSnapshot after the unpersisted gap)', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    const h = durable();
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    h.state.quota = 30 * MB; // low: replay stops being persisted
    h.tick();
    await settle();
    expect(checkout).not.toHaveBeenCalled();
    h.state.quota = 5 * MB; // none: still gated, nothing to restart
    h.tick();
    await settle();
    h.state.quota = 40 * MB; // none -> low: still gated
    h.tick();
    await settle();
    expect(checkout).not.toHaveBeenCalled();
    h.state.quota = 900 * MB; // normal: persistence resumes
    h.tick();
    await settle();
    expect(checkout).toHaveBeenCalledTimes(1);
    h.state.quota = 800 * MB; // already normal: nothing more
    h.tick();
    await settle();
    expect(checkout).toHaveBeenCalledTimes(1);
    await client.stop(0);
  });

  it('a launch that starts already under pressure restarts the recorder on its first recovery', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    const h = durable({}, { usage: 0, quota: 30 * MB });
    await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    h.state.quota = 900 * MB;
    h.tick();
    await settle();
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it('stop() releases the poll and the recorder hook: later ticks no longer move the state or restart anything', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    const h = durable();
    const client = await launched(h.options);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await settle();
    h.state.quota = 30 * MB;
    h.tick();
    await settle();
    await client.stop(0);
    h.state.quota = 900 * MB;
    h.tick();
    await settle();
    expect(checkout).not.toHaveBeenCalled();
    expect(client.getService(DiskPressureToken).level()).toBe('low'); // the feed is released
    const pressure = client.getService(DiskPressureToken);
    pressure.noteWriteRecovered(); // low -> still low (no pin): nothing
    pressure.noteWriteError({ code: 'ENOSPC' });
    pressure.noteWriteRecovered();
    pressure.observe(900 * MB);
    expect(checkout).not.toHaveBeenCalled(); // the recorder hook is released too
  });
});
