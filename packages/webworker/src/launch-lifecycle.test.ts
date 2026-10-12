import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import {
  BugseeStatus,
  createMemoryCaptureStore,
  getCarrier,
  getProcessStatus,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  LifecycleEvents,
  relaunchWith,
  runLaunchRecovery,
  setProcessLifecycleEventsListener,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, type BugseeWorkerLaunchOptions, launch } from './launch';

// Lifecycle parity with the browser/node tiers (review L7/L9): the carrier slot is cleared only by the
// client that still owns it, the coexistence lock + IndexedDB handles are released on stop (only when
// that is safe), the introspectable launch options work, and the status/relaunch state is recorded.

vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return { ...actual, runLaunchRecovery: vi.fn(actual.runLaunchRecovery) };
});

const jsonBody = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const okTransport = (): HttpTransport =>
  vi.fn(
    async (_url: string, _options: HttpRequestOptions = {}): Promise<HttpResponse> => ({
      status: 200,
      headers: {},
      body: jsonBody({ access_token: 'a' }),
    }),
  );

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

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const opts = (over: Partial<BugseeWorkerLaunchOptions> = {}): BugseeWorkerLaunchOptions => ({
  transport: okTransport(),
  carrier: {},
  detectCrashes: false,
  ...over,
});
const track = (options: BugseeWorkerLaunchOptions, token = 'tok'): Bugsee => {
  const client = launch(token, options);
  live.push(client);
  return client;
};

describe('webworker carrier slot', () => {
  it('stop() clears the slot it owns and reports Stopped', async () => {
    const carrier = {};
    const client = track(opts({ carrier }));
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Launched);
    const stopping = client.stop();
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Stopping);
    await stopping;
    expect(getCarrier(carrier).client).toBeUndefined();
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Stopped);
  });

  it('a stale stop() does not evict (or stop the status of) a relaunched client', async () => {
    const carrier = {};
    const first = track(opts({ carrier }));
    await first.stop();
    const second = track(opts({ carrier }));
    await first.stop(); // stale, repeated
    expect(getCarrier(carrier).client).toBe(second);
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Launched);
  });

  it('a relaunch while the previous stop is draining keeps its own client and status', async () => {
    const carrier = {};
    const first = track(opts({ carrier }));
    const stopping = first.stop();
    const second = track(opts({ carrier }));
    await stopping;
    expect(getCarrier(carrier).client).toBe(second);
    expect(getCarrier(carrier).status).toBe(BugseeStatus.Launched); // the slot's own status, not the client's
  });

  it('records the launch so relaunchWith() can start a fresh client with the same token', async () => {
    const carrier = {};
    const first = track(opts({ carrier }), 'tok-1');
    expect(getCarrier(carrier).lastLaunch?.appToken).toBe('tok-1');
    const second = await relaunchWith(launch, opts({ carrier }), carrier);
    live.push(second);
    expect(second).not.toBe(first);
    expect(getCarrier(carrier).client).toBe(second);
  });
});

describe('webworker launch options introspection (L9)', () => {
  it('getLaunchOptions is host over defaults by canonical key; getHostLaunchOptions only what the host set', () => {
    const client = track(opts({ captureLogs: false, maxRecordingTime: 30 }));
    const effective = client.getLaunchOptions();
    expect(effective[BugseeOption.CaptureLogs]).toBe(false);
    expect(effective[BugseeOption.Duration]).toBe(30);
    expect(effective[BugseeOption.CaptureSystemEvents]).toBeDefined();
    expect(client.getHostLaunchOptions()).toMatchObject({
      [BugseeOption.CaptureLogs]: false,
      [BugseeOption.Duration]: 30,
    });
    expect(client.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureSystemEvents]);
  });
});

describe('webworker stop() releases the coexistence lock and IndexedDB only when SAFE (L9)', () => {
  const persisted = (over: Partial<BugseeWorkerLaunchOptions> = {}) => {
    const locks = realLocks();
    return {
      locks,
      options: opts({
        platformType: 'service-worker',
        persist: true,
        locks: locks.manager,
        indexedDB: new IDBFactory(),
        ...over,
      }),
    };
  };

  it('a clean stop releases the instance lock', async () => {
    const { locks, options } = persisted();
    const client = track(options);
    expect(locks.held.size).toBe(1);
    expect(await client.stop()).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('a drain that timed out keeps the lock (the upload may still run)', async () => {
    const { locks, options } = persisted({ transport: () => new Promise(() => {}) });
    const client = track(options);
    await new Promise((resolve) => setTimeout(resolve, 50)); // the launch recovery has settled by now
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    expect(locks.held.size).toBe(1);
  });

  it('keeps the lock while the launch recovery is still running (bounded by the stop deadline)', async () => {
    vi.mocked(runLaunchRecovery).mockImplementationOnce(() => new Promise<void>(() => {}));
    const { locks, options } = persisted();
    const client = track(options);
    expect(await client.stop(20)).toBe(true);
    expect(locks.held.size).toBe(1);
  });

  it('with no deadline waits for the recovery, then releases the lock', async () => {
    let finish: () => void = () => {};
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { locks, options } = persisted();
    const client = track(options);
    let settled = false;
    const stopping = client.stop().then((drained) => {
      settled = true;
      return drained;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    finish();
    expect(await stopping).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('releases its deadline timer once the recovery wins the race', async () => {
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { options } = persisted();
    const client = track(options);
    expect(await client.stop(60_000)).toBe(true);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('R2L-3: a client.launch() while the stop drains is refused, and the stop still releases the lock', async () => {
    const onError = vi.fn();
    const { locks, options } = persisted({ onError });
    const client = track(options);
    const stopping = client.stop();
    client.launch(); // core would restart without the carrier slot and the lock handling
    await stopping;
    expect(client.isLaunched()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/) }),
    );
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('R2L-1: a hung stop(timeout) then a repeat stop(timeout) keeps the lock (the upload may still run)', async () => {
    const { locks, options } = persisted({ transport: () => new Promise(() => {}) });
    const client = track(options);
    await new Promise((resolve) => setTimeout(resolve, 50));
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    expect(await client.stop(30)).toBe(false);
    expect(locks.held.size).toBe(1);
  });

  it('R2L-10: stop() flushes the capture store BEFORE it closes IndexedDB (a launched client only)', async () => {
    const order: string[] = [];
    const captureStore = Object.assign(createMemoryCaptureStore({ maxRecordingTimeMs: 1000 }), {
      flush: async () => void order.push('flush'),
    });
    const { locks, options } = persisted({ captureStore });
    const client = track(options);
    const held = locks.held;
    const stopping = client.stop();
    await stopping;
    await vi.waitFor(() => expect(held.size).toBe(0));
    expect(order).toEqual(['flush']);
  });

  it('R2L-10: a flush that throws goes to onError and the stop still completes', async () => {
    const onError = vi.fn();
    const captureStore = Object.assign(createMemoryCaptureStore({ maxRecordingTimeMs: 1000 }), {
      flush: async () => {
        throw new Error('flush failed');
      },
    });
    const { options } = persisted({ captureStore, onError });
    const client = track(options);
    await expect(client.stop()).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'flush failed' }));
  });
});

describe('R2L-4 — the worker observes its own lifecycle', () => {
  it('the lifecycleEventsListener option sees Launching and Launched', () => {
    const seen: string[] = [];
    track(opts({ lifecycleEventsListener: (type) => seen.push(type) }));
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('without a carrier option the process carrier is globalThis: a listener set BEFORE launch sees it, and survives a relaunch', async () => {
    const seen: string[] = [];
    setProcessLifecycleEventsListener((type) => seen.push(type));
    track({ transport: okTransport(), detectCrashes: false });
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
    seen.length = 0;
    const second = await relaunchWith(launch, { transport: okTransport(), detectCrashes: false });
    live.push(second);
    expect(seen).toEqual([
      LifecycleEvents.Stopping,
      LifecycleEvents.Stopped,
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
    ]);
  });

  it('a blackout carries across a relaunch instead of ending at the new client', async () => {
    const carrier = {};
    const first = track(opts({ carrier }));
    first.startBlackout();
    const second = await relaunchWith(launch, opts({ carrier }), carrier);
    live.push(second);
    expect(second.isBlackout()).toBe(true);
  });
});
