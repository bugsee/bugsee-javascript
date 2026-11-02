import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import { CaptureStoreToken, type createMemoryCaptureStore } from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeviceIdLocalStorage, resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// BGSVIEWER-12 wiring: the replay checkout cadence follows the configured window (so a base always exists at the
// window start), and a byte-cap drop of the whole replay restarts the recorder (debounced) for a fresh base.
const { registerReplay } = vi.hoisted(() => ({ registerReplay: vi.fn() }));
vi.mock('@bugsee/replay', () => ({ registerReplay }));

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

const clients: Bugsee[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.stop(0)));
  resetBrowserDeviceIdCache();
  vi.clearAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

let now = 1_000_000;
const clock = { wallNow: () => now, monotonicNow: () => now };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

function opts(over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions {
  return {
    window: { addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window,
    document: {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Document,
    transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    systemProbe: probe,
    captureNetwork: false,
    captureViewHierarchy: false,
    captureInteractions: false,
    persist: false,
    clock,
    indexedDB: new IDBFactory(),
    locks: freeLocks,
    deviceIdEnv: { localStorage: deviceIdLocalStorage(), randomUUID: () => DEVICE_ID },
    ...over,
  };
}
const launched = async (o: BugseeLaunchOptions): Promise<Bugsee> => {
  const client = await launch('tok', o);
  clients.push(client);
  await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
  return client;
};
const cadenceFor = async (over: Partial<BugseeLaunchOptions>): Promise<unknown> => {
  registerReplay.mockReturnValue({ checkout: vi.fn() });
  await launched(opts(over));
  return (registerReplay.mock.calls[0]?.[2] as { checkoutEveryNms?: number }).checkoutEveryNms;
};

describe('launch — replay checkout cadence follows the recording window', () => {
  it('is half the window when that is under a minute', async () => {
    expect(await cadenceFor({ maxRecordingTime: 20 } as Partial<BugseeLaunchOptions>)).toBe(10_000);
  });
  it('stays at one minute for a long window', async () => {
    expect(await cadenceFor({ maxRecordingTime: 300 } as Partial<BugseeLaunchOptions>)).toBe(
      60_000,
    );
  });
  it('is never below five seconds', async () => {
    expect(await cadenceFor({ maxRecordingTime: 4 } as Partial<BugseeLaunchOptions>)).toBe(5000);
  });
  it('ignores an explicit undefined or non-positive replay.checkoutEveryNms (the derived cadence stays)', async () => {
    for (const bad of [undefined, 0, -1, Number.NaN, '45000']) {
      registerReplay.mockClear();
      expect(
        await cadenceFor({
          maxRecordingTime: 20,
          replay: { checkoutEveryNms: bad },
        } as Partial<BugseeLaunchOptions>),
      ).toBe(10_000);
      await Promise.all(clients.splice(0).map((c) => c.stop(0)));
    }
  });
  it('falls back to the longest cadence for a non-finite window', async () => {
    expect(await cadenceFor({ maxRecordingTime: Number.NaN } as Partial<BugseeLaunchOptions>)).toBe(
      60_000,
    );
  });
  it('lets an explicit replay.checkoutEveryNms win', async () => {
    expect(
      await cadenceFor({
        maxRecordingTime: 20,
        replay: { checkoutEveryNms: 45_000 },
      } as Partial<BugseeLaunchOptions>),
    ).toBe(45_000);
  });
});

describe('launch — a dropped replay restarts the recorder', () => {
  // maxDataSize is in MB: an anchored 1.2 MB replay segment plus a log overflows a 1 MB cap with nothing else to shed.
  const overflow = (store: ReturnType<typeof createMemoryCaptureStore>): void => {
    store.add({ type: 'replay', timestamp: now, serialized: 'x'.repeat(1.2 * MB), anchor: true });
    store.tick(now + 1000);
    store.add({ type: 'log', timestamp: now, serialized: '{}' });
  };

  it('asks the recorder for a fresh base, and not again within the quiet period', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    const client = await launched(opts({ maxDataSize: 1 } as Partial<BugseeLaunchOptions>));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    await flush();
    const store = client.getService(CaptureStoreToken);
    overflow(store);
    await flush();
    expect(checkout).toHaveBeenCalledTimes(1);
    now += 1000;
    overflow(store); // another full drop inside the quiet period: suppressed (no snapshot storm)
    await flush();
    expect(checkout).toHaveBeenCalledTimes(1);
    now += 5000;
    overflow(store);
    await flush();
    expect(checkout).toHaveBeenCalledTimes(2);
  });

  it('backs off while resets keep coming (an oversized snapshot cannot loop every 5 s), and recovers after a quiet spell', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    const client = await launched(opts({ maxDataSize: 1 } as Partial<BugseeLaunchOptions>));
    await flush();
    const store = client.getService(CaptureStoreToken);
    const fire = async (): Promise<void> => {
      overflow(store);
      await flush();
    };
    await fire(); // 1st: immediately
    now += 4999;
    await fire(); // inside the 5 s base interval: suppressed
    now += 1;
    await fire(); // exactly 5 s: allowed (2nd)
    expect(checkout).toHaveBeenCalledTimes(2);
    now += 5000;
    await fire(); // the interval has doubled to 10 s: suppressed
    expect(checkout).toHaveBeenCalledTimes(2);
    now += 5000;
    await fire(); // 10 s since the 2nd: allowed (3rd)
    expect(checkout).toHaveBeenCalledTimes(3);
    now += 11 * 60_000; // a long quiet spell resets the backoff
    await fire();
    now += 5000;
    await fire(); // base interval again
    expect(checkout).toHaveBeenCalledTimes(5);
  });

  it('a quiet spell of exactly ten minutes is not yet long enough to restart the backoff', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    const client = await launched(opts({ maxDataSize: 1 } as Partial<BugseeLaunchOptions>));
    await flush();
    const store = client.getService(CaptureStoreToken);
    const fire = async (): Promise<void> => {
      overflow(store);
      await flush();
    };
    await fire();
    now += 5000;
    await fire(); // interval is now 10 s
    now += 600_000;
    await fire(); // gap == 10 min: the backoff continues (20 s)
    now += 5000;
    await fire(); // suppressed under a 20 s interval
    expect(checkout).toHaveBeenCalledTimes(3);
  });

  it('does not spend the budget on a reset that arrives before the recorder exists', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    const client = await launch('tok', opts({ maxDataSize: 1 } as Partial<BugseeLaunchOptions>));
    clients.push(client);
    const store = client.getService(CaptureStoreToken);
    overflow(store); // the lazy replay import has not resolved yet: nothing to restart, nothing spent
    await flush();
    expect(registerReplay).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    overflow(store); // same instant: still the first restart the launch can honour
    await flush();
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no recorder exists (DOM-less host)', async () => {
    registerReplay.mockReturnValue(undefined);
    const client = await launched(opts({ maxDataSize: 1 } as Partial<BugseeLaunchOptions>));
    await flush();
    expect(() => overflow(client.getService(CaptureStoreToken))).not.toThrow();
    await flush();
  });
});

describe('launch — a host can restart the recorder (onReplayRestart)', () => {
  it('hands the host a restart that asks the recorder for a fresh base, with no backoff of its own', async () => {
    const checkout = vi.fn();
    registerReplay.mockReturnValue({ checkout });
    let restart: (() => void) | undefined;
    await launched(
      opts({ onReplayRestart: (fn: () => void) => (restart = fn) } as Partial<BugseeLaunchOptions>),
    );
    await flush();
    expect(restart).toBeTypeOf('function');
    restart?.();
    restart?.(); // the host owns the pacing (the Electron main gates it): every call is a checkout
    expect(checkout).toHaveBeenCalledTimes(2);
  });

  it('is a no-op before the recorder exists and when there is none (DOM-less host)', async () => {
    registerReplay.mockReturnValue(undefined);
    let restart: (() => void) | undefined;
    await launched(
      opts({ onReplayRestart: (fn: () => void) => (restart = fn) } as Partial<BugseeLaunchOptions>),
    );
    await flush();
    expect(() => restart?.()).not.toThrow();
  });

  it('a throwing host callback is reported and never fails the launch', async () => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
    const onError = vi.fn();
    await launched(
      opts({
        onError,
        onReplayRestart: () => {
          throw new Error('host broke');
        },
      } as Partial<BugseeLaunchOptions>),
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'host broke' }));
  });
});

describe('launch — the default byte cap is the one the store enforces', () => {
  // 24 closed parts of 1 MB each: a 20 MB cap must drop the oldest, a 30 MB cap must keep all of them.
  const fill = (store: ReturnType<typeof createMemoryCaptureStore>): void => {
    for (let i = 0; i < 24; i++) {
      store.add({ type: 'log', timestamp: now + i, serialized: `${i}:${'x'.repeat(MB)}` });
      store.tick(now + (i + 1) * 1000);
    }
  };
  const kept = async (over: Partial<BugseeLaunchOptions>): Promise<number> => {
    registerReplay.mockReturnValue({ checkout: vi.fn() });
    const client = await launched(opts(over));
    const store = client.getService(CaptureStoreToken);
    fill(store);
    let count = 0;
    await vi.waitFor(async () => {
      count = ((await store.snapshot().drainAll()).get('log') ?? []).length;
      expect(count).toBeGreaterThan(0);
    });
    return count;
  };

  it('keeps about 20 MB when the window is in memory', async () => {
    const n = await kept({ persist: false });
    expect(n).toBeGreaterThanOrEqual(19);
    expect(n).toBeLessThanOrEqual(20);
  });

  it('keeps all 24 MB with the durable store (30 MB cap)', async () => {
    expect(
      await kept({
        persist: true,
        indexedDB: new IDBFactory(),
        locks: freeLocks,
        diskProtection: false,
      } as Partial<BugseeLaunchOptions>),
    ).toBe(24);
  });

  it('an explicit maxDataSize is the cap, durable or not', async () => {
    const n = await kept({
      persist: true,
      indexedDB: new IDBFactory(),
      locks: freeLocks,
      maxDataSize: 10,
      diskProtection: false,
    } as Partial<BugseeLaunchOptions>);
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(10);
  });
});
