import { describe, expect, it, vi } from 'vitest';
import {
  createWebLockLiveness,
  type LockManagerLike,
  WEB_LOCKS_UNAVAILABLE_WARNING,
} from './web-lock-liveness';

// An in-memory LockManager fake (fake-indexeddb has no Web Locks; node has no navigator.locks). `kill(name)`
// simulates a realm dying (its held-for-lifetime lock auto-released).
function fakeLocks() {
  const heldForever = new Set<string>(); // holdSelf locks (a live instance)
  const inUse = new Set<string>(); // momentarily held during a recoverIfDead callback
  const manager: LockManagerLike = {
    request(name, options, callback) {
      if (options.ifAvailable) {
        if (heldForever.has(name) || inUse.has(name)) {
          return Promise.resolve(callback(null)); // held → alive/busy
        }
        inUse.add(name);
        return Promise.resolve(callback({ name })).finally(() => inUse.delete(name));
      }
      // holdSelf: the callback returns a never-resolving promise → the lock is held for the realm's lifetime.
      heldForever.add(name);
      void callback({ name });
      return new Promise<never>(() => {}); // mirrors the real never-resolving request
    },
  };
  return { manager, kill: (name: string) => heldForever.delete(name) };
}

describe('createWebLockLiveness — available', () => {
  it('recoverIfDead SKIPS a held (alive) lock and RUNS for a released (dead) one', async () => {
    const locks = fakeLocks();
    const liveness = createWebLockLiveness(locks.manager);
    liveness.holdSelf('inst-A'); // A is alive (holds its lock)

    const aliveFn = vi.fn(() => Promise.resolve());
    await liveness.recoverIfDead('inst-A', aliveFn);
    expect(aliveFn).not.toHaveBeenCalled(); // held → alive → skipped

    locks.kill('inst-A'); // A's realm dies → its lock is released
    const deadFn = vi.fn(() => Promise.resolve());
    await liveness.recoverIfDead('inst-A', deadFn);
    expect(deadFn).toHaveBeenCalledTimes(1); // acquirable → dead → recovered
  });

  it('holds the dead sibling lock DURING recovery so a concurrent peer skips it', async () => {
    const locks = fakeLocks();
    const liveness = createWebLockLiveness(locks.manager);
    // 'inst-dead' is not held (a dead sibling). Start recovering it with a slow fn...
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const peerRan = vi.fn(() => Promise.resolve());
    const recovering = liveness.recoverIfDead('inst-dead', () => slow);
    // ...while it's in flight, a concurrent peer probing the same lock must find it busy (held) → skip.
    await liveness.recoverIfDead('inst-dead', peerRan);
    expect(peerRan).not.toHaveBeenCalled(); // the recoverer holds the lock → the peer skips
    release();
    await recovering;
  });

  it('reports available = true', () => {
    expect(createWebLockLiveness(fakeLocks().manager).available).toBe(true);
  });

  it('routes a holdSelf lock-request rejection to warn (never floats an unhandledrejection)', async () => {
    const warn = vi.fn();
    // A manager whose holdSelf (non-ifAvailable) request REJECTS (e.g. an invalid lock name).
    const rejecting: LockManagerLike = {
      request: (_name, options) =>
        options.ifAvailable
          ? Promise.resolve(undefined)
          : Promise.reject(new Error('bad lock name')),
    };
    const liveness = createWebLockLiveness(rejecting, warn);
    expect(() => liveness.holdSelf('inst-A')).not.toThrow(); // synchronous call never throws
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1)); // the rejection is swallowed → warn
    expect(warn.mock.calls[0]?.[0]).toContain('liveness lock'); // a descriptive message, not the raw reject
  });
});

describe('createWebLockLiveness — unavailable (degrade)', () => {
  it('warns ONCE on holdSelf and never cross-recovers', async () => {
    const warn = vi.fn();
    const liveness = createWebLockLiveness(undefined, warn);
    expect(liveness.available).toBe(false);
    liveness.holdSelf('inst-A');
    liveness.holdSelf('inst-A'); // a second hold must NOT warn again
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(WEB_LOCKS_UNAVAILABLE_WARNING);

    const fn = vi.fn(() => Promise.resolve());
    await liveness.recoverIfDead('inst-B', fn);
    expect(fn).not.toHaveBeenCalled(); // no liveness → no cross-recovery
  });

  it('holdSelf is a silent no-op when no warn sink is supplied', () => {
    expect(() => createWebLockLiveness(undefined).holdSelf('x')).not.toThrow();
  });
});
