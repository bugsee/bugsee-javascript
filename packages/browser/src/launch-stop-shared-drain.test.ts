import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import { createMemoryCaptureStore, type HttpTransport, runLaunchRecovery } from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

vi.mock('@bugsee/replay', () => ({ registerReplay: vi.fn() }));

// The browser half: the instance lock and IndexedDB handles are released when the ONE
// shared real stop drain settles true, from whichever stop() observes it (exactly once), even after a stop(timeout)
// gave up.
// The coexistence handle is real except that, on demand, its release throws AFTER doing its work.
let releaseThrows = false;
vi.mock('@bugsee/browser-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/browser-utils')>();
  return {
    ...actual,
    createCoexistence: (...args: Parameters<typeof actual.createCoexistence>) => {
      const real = actual.createCoexistence(...args);
      return {
        ...real,
        release: () => {
          real.release();
          if (releaseThrows) throw new Error('release failed');
        },
      };
    },
  };
});
vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return { ...actual, runLaunchRecovery: vi.fn(actual.runLaunchRecovery) };
});

const jsonBody = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const ok = () => ({ status: 200, headers: {}, body: jsonBody({ access_token: 'a' }) });
/** A transport whose every request waits for `release()`. */
const gated = (): { transport: HttpTransport; release: () => void } => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    transport: async () => {
      await gate;
      return ok();
    },
    release: () => release(),
  };
};
const killTransport = (): HttpTransport => async () => ({
  status: 200,
  headers: {},
  body: jsonBody({ ok: false, error: { type: 'KillSdk', message: 'off', code: 99099 } }),
});

// A Web Locks fake that frees a lock when its holder settles (the real contract).
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

const TEST_DEVICE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
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
const opts = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window,
  transport: async () => ok(),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  replay: false,
  deviceIdEnv: {
    localStorage: { getItem: () => TEST_DEVICE_ID, setItem: () => {}, removeItem: () => {} },
    randomUUID: () => TEST_DEVICE_ID,
  },
  ...over,
});
const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
  resetBrowserDeviceIdCache();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const track = async (options: BugseeLaunchOptions): Promise<Bugsee> => {
  const client = await launch('tok', options);
  live.push(client);
  return client;
};

describe('the lock is released by whichever stop() observes the shared drain settle', () => {
  const setup = (over: Partial<BugseeLaunchOptions> = {}) => {
    const locks = realLocks();
    return {
      locks,
      options: opts({ persist: true, locks: locks.manager, indexedDB: new IDBFactory(), ...over }),
    };
  };

  it('stop() then stop(20): the 20 ms call times out, the first releases when the drain finishes', async () => {
    const g = gated();
    const { locks, options } = setup({ transport: g.transport });
    const client = await track(options);
    void client.logException(new Error('in flight'));
    const first = client.stop();
    expect(await client.stop(20)).toBe(false);
    expect(locks.held.size).toBe(1);
    g.release();
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('stop(30) times out, the upload then finishes: the lock is released with no further stop()', async () => {
    const g = gated();
    const { locks, options } = setup({ transport: g.transport });
    const client = await track(options);
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    expect(locks.held.size).toBe(1);
    g.release();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
    expect(await client.stop()).toBe(true);
  });

  it('stop(30) times out, then stop() waits for the real drain, releases and answers true', async () => {
    const g = gated();
    const { locks, options } = setup({ transport: g.transport });
    const client = await track(options);
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    const again = client.stop();
    g.release();
    expect(await again).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('a stop during the launch recovery keeps the lock until the recovery settles, then releases it alone', async () => {
    let finish: () => void = () => {};
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { locks, options } = setup();
    const client = await track(options);
    expect(await client.stop(20)).toBe(true);
    expect(locks.held.size).toBe(1);
    finish();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('a killed client is released by stop(), and a second stop is harmless', async () => {
    const { locks, options } = setup({ transport: killTransport() });
    const client = await track(options);
    await client.logException(new Error('boom'));
    await vi.waitFor(() => expect(client.isLaunched()).toBe(false));
    await client.stop();
    await client.stop();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('a hung upload keeps the lock however often stop(timeout) is called', async () => {
    const { locks, options } = setup({ transport: () => new Promise(() => {}) });
    const client = await track(options);
    void client.logException(new Error('in flight'));
    expect(await client.stop(20)).toBe(false);
    expect(await client.stop(20)).toBe(false);
    expect(locks.held.size).toBe(1);
  });

  it('a drain that settles FALSE (an undelivered notification) keeps the lock', async () => {
    const refusing: HttpTransport = async () => ({
      status: 503,
      headers: {},
      body: new Uint8Array(),
    });
    const { locks, options } = setup({ transport: refusing });
    const client = await track(options);
    client.notify('cannot be delivered');
    expect(await client.stop()).toBe(false);
    // The observer hangs off the same promise stop() just returned, and a FALSE drain does no I/O: a few
    // microtask turns run every continuation it could have (no wall-clock sleep).
    await microtasks();
    expect(locks.held.size).toBe(1);
  });

  it('commits the capture store once on the caller path and once in the observer, and a repeat stop() adds none', async () => {
    const flush = vi.fn(async () => {});
    const captureStore = Object.assign(createMemoryCaptureStore({ maxRecordingTimeMs: 1000 }), {
      flush,
    });
    const { locks, options } = setup({ captureStore });
    const client = await track(options);
    expect(await client.stop()).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0)); // release is the observer's LAST step
    expect(flush).toHaveBeenCalledTimes(2);
    await client.stop();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('the observer flushes AGAIN after the drain, before it releases (a stop(timeout) had memoized an early flush)', async () => {
    const g = gated();
    const seen: number[] = [];
    let locksRef: ReturnType<typeof realLocks> | undefined;
    const flush = vi.fn(async () => {
      seen.push(locksRef?.held.size ?? -1); // the lock count at the moment each flush runs
    });
    const captureStore = Object.assign(createMemoryCaptureStore({ maxRecordingTimeMs: 1000 }), {
      flush,
    });
    const { locks, options } = setup({ transport: g.transport, captureStore });
    locksRef = locks;
    const client = await track(options);
    void client.logException(new Error('in flight'));
    expect(await client.stop(20)).toBe(false); // flush #1 (caller path) happens now, mid-drain
    expect(flush).toHaveBeenCalledTimes(1);
    g.release();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
    expect(flush).toHaveBeenCalledTimes(2); // the observer re-flushed once the drain's own writes were done
    expect(seen).toEqual([1, 1]); // …and both ran while the lock was still held
  });

  it('a throwing onError plus a failing flush cannot become an unhandled rejection, and the lock is still released', async () => {
    const captureStore = Object.assign(createMemoryCaptureStore({ maxRecordingTimeMs: 1000 }), {
      flush: async () => {
        throw new Error('flush failed');
      },
    });
    const onError = vi.fn(() => {
      throw new Error('sink throws');
    });
    const { locks, options } = setup({ captureStore, onError });
    const client = await track(options);
    expect(await client.stop()).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
    expect(onError).toHaveBeenCalled();
  });

  it('a release() that throws in the observer is reported, never an unhandled rejection', async () => {
    const g = gated();
    const errors: unknown[] = [];
    const { options } = setup({ transport: g.transport, onError: (e) => errors.push(e) });
    const client = await track(options);
    void client.logException(new Error('in flight'));
    expect(await client.stop(20)).toBe(false); // the caller path gave up: only the observer will release
    releaseThrows = true;
    g.release();
    await vi.waitFor(() =>
      expect(errors.some((e) => (e as Error).message === 'release failed')).toBe(true),
    );
    releaseThrows = false;
  });
});
