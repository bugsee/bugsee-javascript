import { describe, expect, it, vi } from 'vitest';
import type { AsyncBlobStore } from './idb';
import { instanceLockName } from './instance-coexistence';
import { recoverDeadInstances } from './recover-dead-instances';
import { createWebLockLiveness, type LockManagerLike } from './web-lock-liveness';

// In-memory Web Locks fake (see web-lock-liveness.test): kill(name) = a realm died (its lock released).
function fakeLocks() {
  const heldForever = new Set<string>();
  const inUse = new Set<string>();
  const manager: LockManagerLike = {
    request(name, options, callback) {
      if (options.ifAvailable) {
        if (heldForever.has(name) || inUse.has(name)) {
          return Promise.resolve(callback(null));
        }
        inUse.add(name);
        return Promise.resolve(callback({ name })).finally(() => inUse.delete(name));
      }
      heldForever.add(name);
      void callback({ name });
      return new Promise<never>(() => {});
    },
  };
  return { manager, kill: (name: string) => heldForever.delete(name) };
}

function sharedWith(keys: string[]): AsyncBlobStore {
  const map = new Map(keys.map((k) => [k, new Uint8Array([1])] as [string, Uint8Array]));
  return {
    loadAll: () => Promise.resolve([...map.entries()]),
    put: (id, b) => {
      map.set(id, b);
      return Promise.resolve();
    },
    remove: (id) => {
      map.delete(id);
      return Promise.resolve();
    },
  };
}

const TOK = 'app-token';

describe('recoverDeadInstances', () => {
  it('recovers a DEAD sibling and skips a LIVE one and self', async () => {
    const locks = fakeLocks();
    const liveness = createWebLockLiveness(locks.manager);
    liveness.holdSelf(instanceLockName(TOK, 'live')); // a live sibling holds its lock
    // 'dead' never held a lock (its realm is gone); 'self' is us; 'live' is alive.
    const shared = sharedWith(['self/b1', 'live/b2', 'dead/b3', 'dead/b4', 'orphanKeyNoInstance']);
    const recoverInstance = vi.fn(() => Promise.resolve());

    await recoverDeadInstances({
      shared,
      selfInstanceId: 'self',
      appToken: TOK,
      liveness,
      recoverInstance,
    });

    expect(recoverInstance).toHaveBeenCalledTimes(1); // only the dead sibling
    expect(recoverInstance).toHaveBeenCalledWith('dead'); // grouped (b3+b4) → recovered once
    expect(recoverInstance).not.toHaveBeenCalledWith('live'); // alive → skipped
    expect(recoverInstance).not.toHaveBeenCalledWith('self'); // self → skipped
  });

  it('does not cross-recover when liveness is unavailable (degrade)', async () => {
    const liveness = createWebLockLiveness(undefined); // no navigator.locks
    const recoverInstance = vi.fn(() => Promise.resolve());
    await recoverDeadInstances({
      shared: sharedWith(['dead/b1']),
      selfInstanceId: 'self',
      appToken: TOK,
      liveness,
      recoverInstance,
    });
    expect(recoverInstance).not.toHaveBeenCalled();
  });

  it('routes a loadAll failure to onError and skips recovery (never throws)', async () => {
    const onError = vi.fn();
    const recoverInstance = vi.fn(() => Promise.resolve());
    const shared: AsyncBlobStore = {
      loadAll: () => Promise.reject(new Error('idb gone')),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    await expect(
      recoverDeadInstances({
        shared,
        selfInstanceId: 'self',
        appToken: TOK,
        liveness: createWebLockLiveness(fakeLocks().manager),
        recoverInstance,
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(recoverInstance).not.toHaveBeenCalled();
  });

  it('swallows errors with the default no-op onError when none is provided (never throws)', async () => {
    const shared: AsyncBlobStore = {
      loadAll: () => Promise.reject(new Error('idb gone')),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    await expect(
      recoverDeadInstances({
        shared,
        selfInstanceId: 'self',
        appToken: TOK,
        liveness: createWebLockLiveness(fakeLocks().manager),
        recoverInstance: vi.fn(() => Promise.resolve()),
        // no onError → exercises the default no-op
      }),
    ).resolves.toBeUndefined();
  });

  it('isolates a per-sibling recovery failure to onError (others still recover)', async () => {
    const locks = fakeLocks();
    const onError = vi.fn();
    const recoverInstance = vi.fn((id: string) =>
      id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(),
    );
    await recoverDeadInstances({
      shared: sharedWith(['bad/b1', 'good/b2']),
      selfInstanceId: 'self',
      appToken: TOK,
      liveness: createWebLockLiveness(locks.manager),
      recoverInstance,
      onError,
    });
    expect(recoverInstance).toHaveBeenCalledWith('good'); // the good sibling still recovered
    expect(onError).toHaveBeenCalledTimes(1); // the bad one's failure isolated
  });
});
