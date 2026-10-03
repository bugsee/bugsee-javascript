import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import type { BundleStore, LaunchRecoveryOptions } from '@bugsee/core';
import { runLaunchRecovery } from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserDeviceIdCache, type DeviceIdLocalStorage } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

const TEST_DEVICE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

function testDeviceIdLocalStorage(): DeviceIdLocalStorage {
  const data = new Map([['bugsee.device_id', TEST_DEVICE_ID]]);
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

// The two arguments `launch()` hands core's `runLaunchRecovery` are pure WIRING: neither has a
// behavioural consequence this tier can observe on its own (`pipeline` only under a retryable failure —
// see the sibling behavioural test in `launch.test.ts`; `shared: true` not at all, because this launch's
// own bundle namespace is fresh every time, so holding it back only changes WHEN an empty queue is read).
// They are therefore pinned here, against the call. Core's `launch-recovery.test.ts` owns the semantics.
vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return { ...actual, runLaunchRecovery: vi.fn(actual.runLaunchRecovery) };
});

vi.mock('@bugsee/replay', () => ({ registerReplay: vi.fn() }));

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

const fakeWindow = () =>
  ({ addEventListener: () => {}, removeEventListener: () => {} }) as unknown as Window;

/** A Web Locks fake in which every name is free — no sibling is live. */
const freeLocks: LockManagerLike = {
  request(name, options, callback) {
    if (options.ifAvailable) return Promise.resolve(callback({ name }));
    void callback({ name });
    return new Promise<never>(() => {});
  },
};

const memBundleStore = (): BundleStore => {
  const map = new Map<string, Uint8Array>();
  return {
    put: (id, bytes) => void map.set(id, bytes),
    list: () => [...map.keys()],
    read: (id) => map.get(id),
    remove: (id) => void map.delete(id),
  };
};

const clients: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop(0)));
  resetBrowserDeviceIdCache();
  vi.mocked(runLaunchRecovery).mockClear();
  vi.restoreAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const options = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  window: fakeWindow(),
  transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  scheduler: { setInterval: () => 'h', clearInterval: () => {} },
  indexedDB: new IDBFactory(),
  locks: freeLocks,
  deviceIdEnv: {
    localStorage: testDeviceIdLocalStorage(),
    randomUUID: () => TEST_DEVICE_ID,
    ...(over.deviceIdEnv ?? {}),
  },
  ...over,
});

/** The single `runLaunchRecovery` call this launch made. */
const recoveryArgs = async (over: Partial<BugseeLaunchOptions>): Promise<LaunchRecoveryOptions> => {
  clients.push(await launch('tok', options(over)));
  expect(runLaunchRecovery).toHaveBeenCalledTimes(1);
  return vi.mocked(runLaunchRecovery).mock.calls[0]?.[0] as LaunchRecoveryOptions;
};

describe('launch — the recovery wiring handed to core', () => {
  it('passes the BASE pipeline, never the durable queue, with an injected bundle store', async () => {
    const args = await recoveryArgs({ bundleStore: memBundleStore(), persist: true });

    expect(args.queue).toBeDefined(); // there IS a durable queue to get this wrong with
    expect(args.pipeline).not.toBe(args.queue);
    // Structural, so it also rejects some OTHER durable pipeline: a base pipeline has no `recover`.
    expect((args.pipeline as { recover?: unknown }).recover).toBeUndefined();
  });

  it('passes the BASE pipeline, never the durable queue, with the per-instance IndexedDB queue', async () => {
    const args = await recoveryArgs({ persist: true });

    expect(args.queue).toBeDefined();
    expect(args.pipeline).not.toBe(args.queue);
    expect((args.pipeline as { recover?: unknown }).recover).toBeUndefined();
  });

  it('marks the queue SHARED only when the bundle store is the integrator’s', async () => {
    // false is the direction that decides ordering for every default launch: a per-instance queue is
    // this launch's own, fresh, and must be drained up front rather than held back for the scan.
    expect((await recoveryArgs({ persist: true })).shared).toBe(false);
  });

  it('marks an INJECTED bundle store as shared, so the dead-sibling scan gets first refusal', async () => {
    expect((await recoveryArgs({ bundleStore: memBundleStore(), persist: true })).shared).toBe(true);
  });
});
