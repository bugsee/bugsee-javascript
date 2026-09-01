import 'fake-indexeddb/auto';
import type { WindowEvents } from '@bugsee/browser';
import type { LockManagerLike } from '@bugsee/browser-utils';
import type { BundleStore, LaunchRecoveryOptions, Scheduler } from '@bugsee/core';
import { runLaunchRecovery } from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BugseeWorkerLaunchOptions, launch } from './launch';

// The two arguments `launch()` hands core's `runLaunchRecovery` are pure WIRING: neither has a
// behavioural consequence this tier can observe on its own (`pipeline` only under a retryable failure —
// see the sibling behavioural test in `launch.test.ts`; `shared: true` not at all, because this
// activation's own bundle namespace is fresh every time, so holding it back only changes WHEN an empty
// queue is read). They are pinned here, against the call. Core's `launch-recovery.test.ts` owns the
// semantics.
vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return { ...actual, runLaunchRecovery: vi.fn(actual.runLaunchRecovery) };
});

const inertScheduler: Scheduler = {
  setInterval: () => 0 as unknown as ReturnType<Scheduler['setInterval']>,
  clearInterval: () => {},
};

const fakeScope: WindowEvents = { addEventListener: () => {}, removeEventListener: () => {} };

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

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop(0)));
  vi.mocked(runLaunchRecovery).mockClear();
  vi.restoreAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const options = (over: Partial<BugseeWorkerLaunchOptions> = {}): BugseeWorkerLaunchOptions => ({
  transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  scheduler: inertScheduler,
  captureNetwork: false,
  globalScope: fakeScope,
  platformType: 'service-worker', // persists ⇒ there IS a durable queue to get the wiring wrong with
  indexedDB: new IDBFactory(),
  locks: freeLocks,
  ...over,
});

/** The single `runLaunchRecovery` call this launch made. */
const recoveryArgs = (over: Partial<BugseeWorkerLaunchOptions>): LaunchRecoveryOptions => {
  clients.push(launch('tok', options(over)));
  expect(runLaunchRecovery).toHaveBeenCalledTimes(1);
  return vi.mocked(runLaunchRecovery).mock.calls[0]?.[0] as LaunchRecoveryOptions;
};

describe('launch — the recovery wiring handed to core', () => {
  it('passes the BASE pipeline, never the durable queue, with an injected bundle store', () => {
    const args = recoveryArgs({ bundleStore: memBundleStore() });

    expect(args.queue).toBeDefined(); // there IS a durable queue to get this wrong with
    expect(args.pipeline).not.toBe(args.queue);
    // Structural, so it also rejects some OTHER durable pipeline: a base pipeline has no `recover`.
    expect((args.pipeline as { recover?: unknown }).recover).toBeUndefined();
  });

  it('passes the BASE pipeline, never the durable queue, with the per-instance IndexedDB queue', () => {
    const args = recoveryArgs({});

    expect(args.queue).toBeDefined();
    expect(args.pipeline).not.toBe(args.queue);
    expect((args.pipeline as { recover?: unknown }).recover).toBeUndefined();
  });

  it('marks the queue SHARED only when the bundle store is the integrator’s', () => {
    // false is the direction that decides ordering for every default activation: a per-instance queue is
    // this launch's own, fresh, and must be drained up front rather than held back for the scan.
    expect(recoveryArgs({}).shared).toBe(false);
  });

  it('marks an INJECTED bundle store as shared, so the dead-sibling scan gets first refusal', () => {
    expect(recoveryArgs({ bundleStore: memBundleStore() }).shared).toBe(true);
  });
});
