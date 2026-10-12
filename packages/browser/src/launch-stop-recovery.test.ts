import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import { runLaunchRecovery } from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type BugseeLaunchOptions, launch } from './launch';

// stop() must not release the instance lock / IndexedDB while the launch-time recovery is still
// running (it may be reading or writing), and must release once it has settled.
vi.mock('@bugsee/replay', () => ({ registerReplay: vi.fn() }));
vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return { ...actual, runLaunchRecovery: vi.fn(actual.runLaunchRecovery) };
});

const probe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 (Macintosh) Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

function realLocks() {
  const held = new Set<string>();
  const manager: LockManagerLike = {
    request(name, options, callback) {
      if (options.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => held.delete(name));
    },
  };
  return { manager, held };
}

const opts = (over: Partial<BugseeLaunchOptions>): BugseeLaunchOptions => ({
  window: { addEventListener() {}, removeEventListener() {} } as unknown as Window,
  transport: async () => ({
    status: 200,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
  }),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  replay: false,
  persist: true,
  deviceIdEnv: {
    localStorage: { getItem: () => 'dev', setItem: () => {}, removeItem: () => {} },
    randomUUID: () => 'dev',
  },
  ...over,
});

afterEach(() => {
  resetBrowserDeviceIdCache();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('browser stop() and the launch-time recovery', () => {
  it('keeps the lock while the recovery is still running, bounded by the stop deadline', async () => {
    vi.mocked(runLaunchRecovery).mockImplementationOnce(() => new Promise<void>(() => {}));
    const locks = realLocks();
    const client = await launch('tok', opts({ locks: locks.manager, indexedDB: new IDBFactory() }));
    expect(locks.held.size).toBe(1);
    // Deterministic, no wall clock: only the deadline timer is faked, advanced in 20 ms steps.
    // If stop() waited for the never-settling recovery (or used a longer deadline) this would never resolve.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const stopping = client.stop(20).then((drained) => {
        settled = true;
        return drained;
      });
      // The deadline timer is armed a few async steps into stop(): advance in deadline-sized steps, at most 5
      // (100 ms of fake time in all), so a longer or missing deadline fails instead of passing slowly; the
      // setImmediate lets fake-indexeddb's own (unfaked) macrotasks run between steps.
      for (let step = 0; step < 5 && !settled; step++) {
        await vi.advanceTimersByTimeAsync(20);
        await new Promise<void>((resolve) =>
          (globalThis as unknown as { setImmediate(cb: () => void): void }).setImmediate(resolve),
        );
      }
      expect(settled).toBe(true);
      expect(await stopping).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(locks.held.size).toBe(1); // recovery may still be reading/writing: not dead yet
  });

  it('releases its deadline timer once the recovery wins the race', async () => {
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const locks = realLocks();
    const client = await launch('tok', opts({ locks: locks.manager, indexedDB: new IDBFactory() }));
    expect(await client.stop(60_000)).toBe(true);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('with no deadline, waits for the recovery and then releases the lock', async () => {
    let finish: () => void = () => {};
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const locks = realLocks();
    const client = await launch('tok', opts({ locks: locks.manager, indexedDB: new IDBFactory() }));
    let settled = false;
    const stopping = client.stop().then((drained) => {
      settled = true;
      return drained;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(locks.held.size).toBe(1);
    finish();
    expect(await stopping).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });
});
