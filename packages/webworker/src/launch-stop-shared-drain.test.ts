import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import { createMemoryCaptureStore, type HttpTransport, runLaunchRecovery } from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, type BugseeWorkerLaunchOptions, launch } from './launch';

// Review round 3 (H1), webworker half: R3L-1. The instance lock and IndexedDB handles are released when the ONE
// shared real stop drain settles true, from whichever stop() observes it (exactly once), even after a stop(timeout)
// gave up.
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

const opts = (over: Partial<BugseeWorkerLaunchOptions> = {}): BugseeWorkerLaunchOptions => ({
  transport: async () => ok(),
  carrier: {},
  detectCrashes: false,
  platformType: 'service-worker',
  ...over,
});
const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const track = (options: BugseeWorkerLaunchOptions): Bugsee => {
  const client = launch('tok', options);
  live.push(client);
  return client;
};

describe('R3L-1 — the lock is released by whichever stop() observes the shared drain settle', () => {
  const setup = (over: Partial<BugseeWorkerLaunchOptions> = {}) => {
    const locks = realLocks();
    return {
      locks,
      options: opts({ persist: true, locks: locks.manager, indexedDB: new IDBFactory(), ...over }),
    };
  };

  it('stop() then stop(20): the 20 ms call times out, the first releases when the drain finishes', async () => {
    const g = gated();
    const { locks, options } = setup({ transport: g.transport });
    const client = track(options);
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
    const client = track(options);
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
    const client = track(options);
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
    const client = track(options);
    expect(await client.stop(20)).toBe(true);
    expect(locks.held.size).toBe(1);
    finish();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('a killed client is released by stop(), and a second stop() is harmless', async () => {
    const { locks, options } = setup({ transport: killTransport() });
    const client = track(options);
    await client.logException(new Error('boom'));
    await vi.waitFor(() => expect(client.isLaunched()).toBe(false));
    await client.stop();
    await client.stop();
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
  });

  it('a hung upload keeps the lock however often stop(timeout) is called', async () => {
    const { locks, options } = setup({ transport: () => new Promise(() => {}) });
    const client = track(options);
    void client.logException(new Error('in flight'));
    expect(await client.stop(20)).toBe(false);
    expect(await client.stop(20)).toBe(false);
    expect(locks.held.size).toBe(1);
  });

  it('commits the capture store exactly once per stop, however many paths observe the drain', async () => {
    const flush = vi.fn(async () => {});
    const captureStore = Object.assign(createMemoryCaptureStore({ maxRecordingTimeMs: 1000 }), {
      flush,
    });
    const { locks, options } = setup({ captureStore });
    const client = track(options);
    expect(await client.stop()).toBe(true);
    await vi.waitFor(() => expect(locks.held.size).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
