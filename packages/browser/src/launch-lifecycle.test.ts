import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import {
  BugseeStatus,
  createMemoryCaptureStore,
  getCarrier,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  LifecycleEvents,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  getStatus,
  launch,
  launchCore,
  relaunch,
} from './launch';

// Lifecycle (launch -> stop -> launch) behaviour of the browser composition root: status, relaunch, the
// introspectable launch options, and — the point — that a repeat cycle leaves nothing behind.

vi.mock('@bugsee/replay', () => ({ registerReplay: vi.fn() }));

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

// A window/document fake that counts live listeners per type.
function fakeTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target = {
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    total: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const okTransport = (): HttpTransport =>
  vi.fn(
    async (_url: string, _options: HttpRequestOptions = {}): Promise<HttpResponse> => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
    }),
  );

const opts = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  window: fakeTarget().target as unknown as Window,
  transport: okTransport(),
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

// An IDBFactory counting open connections.
function countingIdb(real: IDBFactory) {
  let open = 0;
  const idb = {
    open: (name: string, version?: number) => {
      const request = real.open(name, version);
      request.addEventListener('success', () => {
        open += 1;
        const db = request.result;
        const close = db.close.bind(db);
        db.close = () => {
          open -= 1;
          close();
        };
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { idb, open: () => open };
}

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop()));
  resetBrowserDeviceIdCache();
  vi.unstubAllGlobals();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const track = async (token: string, options: BugseeLaunchOptions) => {
  const client = await launch(token, options);
  live.push(client);
  return client;
};

describe('status', () => {
  it('is Stopped before any launch', () => {
    expect(getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('is Launching while the async launch is in flight, then Launched, Stopping while draining, Stopped', async () => {
    const pending = launchCore('tok', opts());
    expect(getStatus()).toBe(BugseeStatus.Launching);
    const { client } = await pending;
    live.push(client);
    expect(getStatus()).toBe(BugseeStatus.Launched);
    expect(client.getStatus()).toBe(BugseeStatus.Launched);

    const stopping = client.stop();
    expect(getStatus()).toBe(BugseeStatus.Stopping);
    await stopping;
    expect(getStatus()).toBe(BugseeStatus.Stopped);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('stays Stopping until the capture store has flushed, and a relaunch during it keeps its own status', async () => {
    let release!: () => void;
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    store.flush = () => new Promise<void>((r) => (release = r));
    const client = await track('tok', opts({ captureStore: store }));
    const stopping = client.stop();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(getStatus()).toBe(BugseeStatus.Stopping);

    const second = await track('tok', opts()); // launch while the old one is still draining
    expect(getStatus()).toBe(BugseeStatus.Launched);
    release();
    await stopping;
    expect(getStatus()).toBe(BugseeStatus.Launched); // the old stop must not clobber the new client's state
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
  });

  it('falls back to Stopped when the launch throws', async () => {
    const bad = opts({ persist: true });
    Object.defineProperty(bad, 'indexedDB', {
      get(): IDBFactory {
        throw new Error('no idb');
      },
    });
    await expect(launchCore('tok', bad)).rejects.toThrow('no idb');
    expect(getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('a repeat launch while launched does not disturb the status', async () => {
    const first = await track('tok', opts());
    const onError = vi.fn();
    const again = await launch('tok', opts({ onError }));
    expect(again).toBe(first);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(getStatus()).toBe(BugseeStatus.Launched);
  });

  it('stopping a client that no longer owns the slot leaves the newer client and its status alone', async () => {
    const stale = await track('tok', opts());
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__; // the slot is reset under it
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    store.flush = () => new Promise<void>(() => {}); // newer's stop() never finishes draining
    const newer = await track('tok', opts({ captureStore: store }));
    void newer.stop();
    expect(getStatus()).toBe(BugseeStatus.Stopping);
    await stale.stop();
    expect(getStatus()).toBe(BugseeStatus.Stopping); // the stale stop settled without touching it
  });

  it('a second stop() after a relaunch does not evict the newer client', async () => {
    const first = await track('tok', opts());
    await first.stop();
    const second = await track('tok', opts());
    await first.stop(); // stale, repeated stop
    expect(getCarrier().status).toBe(BugseeStatus.Launched); // the carrier state was not rewritten either
    expect(getStatus()).toBe(BugseeStatus.Launched);
    expect(await launch('tok', opts({ onError: () => {} }))).toBe(second); // still the singleton
  });
});

describe('launch -> stop -> launch cycles leave nothing behind', () => {
  it('3 cycles: window/document listeners, the fetch patch, the Web Lock and IDB connections all return to baseline', async () => {
    const win = fakeTarget();
    const doc = fakeTarget();
    const originalFetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', originalFetch);
    const locks = realLocks();
    const real = countingIdb(new IDBFactory());
    const options = (): BugseeLaunchOptions =>
      opts({
        window: win.target as unknown as Window,
        document: doc.target as unknown as Document,
        captureNetwork: true,
        persist: true,
        locks: locks.manager,
        indexedDB: real.idb,
      });

    let runningListeners = -1;
    for (let cycle = 0; cycle < 3; cycle++) {
      const client = await launch('tok', options());
      expect(client.getStatus()).toBe(BugseeStatus.Launched);
      expect(globalThis.fetch).not.toBe(originalFetch); // patched exactly once…
      await globalThis.fetch('https://example.test/');
      expect(originalFetch).toHaveBeenCalledTimes(cycle + 1); // …so each request reaches the app's fetch once
      expect(locks.held.size).toBe(1);
      const listeners = win.total() + doc.total();
      expect(listeners).toBeGreaterThan(0);
      if (runningListeners === -1) runningListeners = listeners;
      expect(listeners).toBe(runningListeners); // no accumulation across cycles

      await client.stop();
      expect(getStatus()).toBe(BugseeStatus.Stopped);
      expect(win.total() + doc.total()).toBe(0);
      expect(globalThis.fetch).toBe(originalFetch); // patch removed
      await vi.waitFor(() => expect(locks.held.size).toBe(0));
      await vi.waitFor(() => expect(real.open()).toBe(0));
      expect(getCarrier().client).toBeUndefined();
    }
  });

  it('stop() with a deadline does not wait out a slow launch-time recovery scan', async () => {
    const locks = realLocks();
    const idb = new IDBFactory();
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const never = new Promise<void>(() => {});
    // A bundle store whose hydration never completes keeps the launch recovery pending forever.
    const bundleStore = {
      put: () => {},
      list: () => [],
      read: () => undefined,
      remove: () => {},
      whenReady: never,
    };
    const client = await launch(
      'tok',
      opts({
        persist: true,
        locks: locks.manager,
        indexedDB: idb,
        captureStore: store,
        bundleStore,
      }),
    );
    // Deterministic, no wall clock: only the deadline timer is faked, advanced in 20 ms steps.
    // If stop() waited for the never-settling scan (or used a longer deadline) this would never resolve.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const stopping = client.stop(20).then((drained) => {
        settled = true;
        return drained;
      });
      // The deadline timer is armed a few async steps into stop(): advance in deadline-sized steps, at most 5
      // (100 ms of fake time in all), so a longer or missing deadline fails instead of passing slowly.
      for (let step = 0; step < 5 && !settled; step++) {
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(settled).toBe(true);
      expect(await stopping).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('a stopped instance is recovered by the NEXT launch as a dead sibling (its lock was released)', async () => {
    const locks = realLocks();
    const idb = new IDBFactory();
    const base = { persist: true, locks: locks.manager, indexedDB: idb };
    const first = await launch('tok', opts(base));
    await first.stop();
    const onError = vi.fn();
    const second = await track('tok', opts({ ...base, onError }));
    expect(second).not.toBe(first);
    expect(onError).not.toHaveBeenCalled();
    expect(locks.held.size).toBe(1); // only the live instance holds a lock
  });

  it('flush failure during stop is routed to onError and does not break the shutdown', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    store.flush = () => Promise.reject(new Error('commit failed'));
    const onError = vi.fn();
    const client = await launch('tok', opts({ captureStore: store, onError }));
    expect(await client.stop()).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'commit failed' }));
    expect(getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('stop() on a client that is no longer launched (killed) releases the slot and reports Stopped', async () => {
    const client = await launch('tok', opts());
    // Simulate the kill-state: the core client is no longer launched but still owns the slot.
    vi.spyOn(client, 'isLaunched').mockReturnValue(false);
    expect(await client.stop()).toBe(true);
    expect(getStatus()).toBe(BugseeStatus.Stopped);
    expect(getCarrier().client).toBeUndefined();
  });
});

describe('stop() releases the instance lock and IndexedDB only when it is SAFE to (L7, L14)', () => {
  const never = (): HttpTransport => () => new Promise(() => {});
  // The collector's KILL_SDK verdict (99099) arrives as a v2 envelope; every call answers with it.
  const killTransport = (): HttpTransport => async () => ({
    status: 200,
    headers: {},
    body: new TextEncoder().encode(
      JSON.stringify({ ok: false, error: { type: 'KillSdk', message: 'off', code: 99099 } }),
    ),
  });

  it('L7: a drain that timed out keeps the lock and the IDB connections (the upload may still run)', async () => {
    const locks = realLocks();
    const real = countingIdb(new IDBFactory());
    const client = await launch(
      'tok',
      opts({ persist: true, locks: locks.manager, indexedDB: real.idb, transport: never() }),
    );
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    expect(locks.held.size).toBe(1); // another tab must NOT see this instance as dead and re-upload
    expect(real.open()).toBeGreaterThan(0);
    expect(getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('L7: a clean drain with the recovery settled still releases the lock and the connections', async () => {
    const locks = realLocks();
    const real = countingIdb(new IDBFactory());
    const client = await launch(
      'tok',
      opts({ persist: true, locks: locks.manager, indexedDB: real.idb }),
    );
    expect(await client.stop()).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
    await vi.waitFor(() => expect(real.open()).toBe(0));
  });

  it('R2L-3: a client.launch() while the stop is draining is refused, and the stop still releases the lock', async () => {
    const locks = realLocks();
    const onError = vi.fn();
    const client = await launch(
      'tok',
      opts({ persist: true, locks: locks.manager, indexedDB: new IDBFactory(), onError }),
    );
    const stopping = client.stop();
    client.launch(); // core would restart WITHOUT the page-hide flush, the carrier slot or the lock
    await stopping;
    expect(client.isLaunched()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/) }),
    );
    await vi.waitFor(() => expect(locks.held.size).toBe(0)); // nothing is writing: safe to release
  });

  it('R2L-3: after stop(), a refused client.launch() leaves the process free for a NEW client (no two-client state)', async () => {
    const first = await launch('tok', opts({ onError: () => {} }));
    await first.stop();
    first.launch();
    const second = await track('tok', opts());
    expect(second).not.toBe(first);
    expect(getCarrier().client).toBe(second);
    expect(first.isLaunched()).toBe(false);
    expect(getStatus()).toBe(BugseeStatus.Launched);
  });

  it('R2L-1: a hung stop(timeout) then a repeat stop(timeout) keeps the lock: the upload may still run', async () => {
    const locks = realLocks();
    const client = await launch(
      'tok',
      opts({
        persist: true,
        locks: locks.manager,
        indexedDB: new IDBFactory(),
        transport: never(),
      }),
    );
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    expect(await client.stop(30)).toBe(false); // used to answer true at once and release the lock below
    expect(locks.held.size).toBe(1);
  });

  it('L14: stop() on a KILLED client still releases the lock and the connections', async () => {
    const locks = realLocks();
    const real = countingIdb(new IDBFactory());
    const onError = vi.fn();
    const client = await launch(
      'tok',
      opts({
        persist: true,
        locks: locks.manager,
        indexedDB: real.idb,
        transport: killTransport(),
        onError,
      }),
    );
    await client.logException(new Error('boom'));
    await vi.waitFor(() => expect(client.isLaunched()).toBe(false)); // the collector killed the SDK
    expect(locks.held.size).toBe(1); // still held until stop()
    await client.stop();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
    await vi.waitFor(() => expect(real.open()).toBe(0));
    expect(getStatus()).toBe(BugseeStatus.Stopped);
  });
});

describe('launch options introspection', () => {
  it('getLaunchOptions is host over defaults by canonical key; getHostLaunchOptions only what the host set', async () => {
    const client = await track('tok', opts({ captureLogs: false, maxRecordingTime: 30 }));
    const effective = client.getLaunchOptions();
    expect(effective[BugseeOption.CaptureLogs]).toBe(false); // host value
    expect(effective[BugseeOption.Duration]).toBe(30); // host value
    expect(effective[BugseeOption.CaptureNetwork]).toBe(false); // the test harness sets captureNetwork: false
    expect(effective[BugseeOption.CaptureSystemEvents]).toBe(true); // default
    expect(effective[BugseeOption.CaptureViewHierarchy]).toBe(true); // browser default
    expect(client.getHostLaunchOptions()).toMatchObject({
      [BugseeOption.CaptureLogs]: false,
      [BugseeOption.Duration]: 30,
    });
    expect(client.getHostLaunchOptions()).not.toHaveProperty(BugseeOption.CaptureSystemEvents);
  });

  it('never exposes secrets: no token, no transport/headers, only registered canonical keys', async () => {
    const client = await track('SECRET-APP-TOKEN', opts({ endpoint: 'https://x.test' }));
    for (const view of [client.getLaunchOptions(), client.getHostLaunchOptions()]) {
      expect(JSON.stringify(view)).not.toContain('SECRET-APP-TOKEN');
      for (const key of Object.keys(view)) expect(key).toMatch(/^com\.bugsee\.option\./);
    }
    // Only the harness's own captureNetwork:false is host-supplied; endpoint/transport/token are not options.
    expect(Object.keys(client.getHostLaunchOptions())).toEqual([BugseeOption.CaptureNetwork]);
  });

  it('the host options are replaced on each launch, not merged', async () => {
    const first = await launch('tok', opts({ captureLogs: false }));
    expect(first.getHostLaunchOptions()).toHaveProperty([BugseeOption.CaptureLogs], false);
    await first.stop();
    const second = await track('tok', opts());
    expect(second.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureLogs]);
    expect(second.getLaunchOptions()[BugseeOption.CaptureLogs]).toBe(true);
  });
});

describe('relaunch', () => {
  it('rejects before any launch', async () => {
    await expect(relaunch()).rejects.toThrow(/before launch/);
  });

  it('stops the current client, then launches a FRESH one with the same token and DEFAULT options (L10)', async () => {
    const first = await launch('tok-1', opts({ captureLogs: false }));
    const second = await relaunch();
    live.push(second);
    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
    expect(getStatus()).toBe(BugseeStatus.Launched);
    // Like Android and iOS: no options means defaults, so the earlier `captureLogs: false` is gone...
    expect(second.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureLogs]);
    // ...and the integration seams are kept (see the transport test below).
  });

  it('keeps the injected transport across a no-options relaunch (the seam, not a Bugsee option)', async () => {
    const transport = okTransport();
    await launch('tok-1', opts({ transport }));
    const second = await relaunch();
    live.push(second);
    vi.mocked(transport).mockClear();
    second.log('x');
    await second.upload({ summary: 's' });
    expect(transport).toHaveBeenCalled();
  });

  it('the lifecycle listener passed as an option sees Launching/Launched, and survives relaunch (L1)', async () => {
    const seen: string[] = [];
    await launch('tok', opts({ lifecycleEventsListener: (type) => seen.push(type) }));
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
    seen.length = 0;
    const second = await relaunch();
    live.push(second);
    expect(seen).toEqual([
      LifecycleEvents.Stopping,
      LifecycleEvents.Stopped,
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
    ]);
  });

  it('a blackout in force is still in force on the relaunched client (V2)', async () => {
    const first = await launch('tok', opts());
    first.startBlackout();
    const second = await relaunch();
    live.push(second);
    expect(second.isBlackout()).toBe(true);
    second.endBlackout();
    expect(second.isBlackout()).toBe(false);
  });

  describe('the carrier-shared input source follows the CURRENT client blackout (R2V-3)', () => {
    // A document fake with emit(); wheel frames are driven by hand through requestAnimationFrame.
    function wheelRig() {
      const listeners = new Map<string, Set<(event: unknown) => void>>();
      const document = {
        addEventListener: (t: string, l: (e: unknown) => void) => {
          const set = listeners.get(t) ?? new Set();
          set.add(l);
          listeners.set(t, set);
        },
        removeEventListener: (t: string, l: (e: unknown) => void) => {
          listeners.get(t)?.delete(l);
        },
      };
      const frames: Array<() => void> = [];
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
      return {
        document: document as unknown as Document,
        turn: (deltaY: number) => {
          for (const l of listeners.get('wheel') ?? []) {
            l({ deltaX: 0, deltaY, deltaMode: 0, clientX: 1, clientY: 1, buttons: 0 });
          }
        },
        flush: () => {
          for (const cb of frames.splice(0)) cb();
        },
      };
    }
    const sourceOf = (carrier: object) =>
      getCarrier(carrier).interceptors.get('browser-input') as {
        onAny: (l: (stage: string, e: unknown) => void) => () => void;
      };

    it('a wheel turn during a blackout begun on the relaunched client is never flushed after it ends', async () => {
      const carrier = {};
      const rig = wheelRig();
      await launch('tok', opts({ carrier, document: rig.document }));
      const second = await relaunch(opts({ carrier, document: rig.document }));
      live.push(second);
      const seen: unknown[] = [];
      const off = sourceOf(carrier).onAny((_s, e) => seen.push(e));
      second.startBlackout();
      rig.turn(40);
      second.endBlackout();
      rig.flush();
      expect(seen).toEqual([]);
      off();
    });

    it('a relaunch DURING a blackout still drops wheel turns, and capture resumes after it ends', async () => {
      const carrier = {};
      const rig = wheelRig();
      const first = await launch('tok', opts({ carrier, document: rig.document }));
      first.startBlackout();
      const second = await relaunch(opts({ carrier, document: rig.document }));
      live.push(second);
      const seen: Array<{ scrollY?: number }> = [];
      const off = sourceOf(carrier).onAny((_s, e) => seen.push(e as { scrollY?: number }));
      rig.turn(40);
      rig.flush();
      expect(seen).toEqual([]);
      second.endBlackout();
      rig.turn(3);
      rig.flush();
      expect(seen.map((e) => e.scrollY)).toEqual([3]);
      off();
    });
  });

  it('a relaunch with startInBlackout over a CARRIED blackout does not announce a second BlackoutStarted (R2V-11)', async () => {
    const seen: string[] = [];
    const listener = (type: string) => seen.push(type);
    const first = await launch('tok', opts({ lifecycleEventsListener: listener }));
    first.startBlackout();
    seen.length = 0;
    const second = await relaunch(opts({ startInBlackout: true }));
    live.push(second);
    expect(second.isBlackout()).toBe(true);
    expect(seen).not.toContain(LifecycleEvents.BlackoutStarted);
  });

  it('uses NEW options when given (they replace the previous host options)', async () => {
    await launch('tok', opts({ captureLogs: false }));
    const second = await relaunch(opts({ maxRecordingTime: 15 }));
    live.push(second);
    expect(second.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureLogs]);
    expect(second.getLaunchOptions()[BugseeOption.Duration]).toBe(15);
  });

  it('3 relaunches in a row leave exactly one live client and no accumulated listeners', async () => {
    const win = fakeTarget();
    await launch('tok', opts({ window: win.target as unknown as Window }));
    const baseline = win.total();
    for (let i = 0; i < 3; i++) {
      const next = await relaunch(opts({ window: win.target as unknown as Window }));
      live.push(next);
      expect(win.total()).toBe(baseline);
    }
  });

  it('a relaunch during an in-flight launch waits for it, stops that client and builds one with the NEW options (L13)', async () => {
    const inFlight = launch('tok', opts());
    const relaunched = relaunch(opts({ maxRecordingTime: 15 }));
    const first = await inFlight;
    const second = await relaunched;
    live.push(second);
    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
    expect(second.getLaunchOptions()[BugseeOption.Duration]).toBe(15);
  });

  it('records the build as in flight while it runs, clears it when it settles, and ignores a repeat launch (L13)', async () => {
    const building = launch('tok', opts());
    expect(getCarrier().pendingLaunch).toBeDefined();
    live.push(await building);
    expect(getCarrier().pendingLaunch).toBeUndefined();
    const repeat = launch('tok', opts());
    expect(getCarrier().pendingLaunch).toBeUndefined(); // the singleton exists: nothing is being built
    await repeat;
  });
});
