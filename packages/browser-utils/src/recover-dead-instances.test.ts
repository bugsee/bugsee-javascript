import { type Bundle, serializeBundle, type UploadPipeline } from '@bugsee/core';
import { Severity } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncBlobStore } from './idb';
import { instanceLockName } from './instance-coexistence';
import { recoverDeadInstances, recoverSiblingBundleQueue } from './recover-dead-instances';
import { createWebLockLiveness, type LockManagerLike } from './web-lock-liveness';

const aBundle = (summary: string): Bundle => ({
  request: {
    type: 'crash',
    summary,
    severity: Severity.Blocker,
    source: { mechanism: 'uncaught' },
    created_on: '2026-06-29T00:00:00Z',
    environment: {
      platform: { type: 'web', version: '1' },
      sdk: { version: '0', type: 'javascript' },
    },
  },
  body: new Uint8Array([0x50, 0x4b, 1]),
  fileName: 'recovered.zip',
});

function memBlobWith(entries: Array<[string, Uint8Array]>) {
  const map = new Map(entries);
  const store: AsyncBlobStore = {
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
  return { store, map };
}

const okPipeline = (): UploadPipeline & { enqueue: ReturnType<typeof vi.fn> } => ({
  enqueue: vi.fn(() => Promise.resolve({ ok: true })),
  flush: vi.fn(() => Promise.resolve(true)),
  drop: vi.fn(),
});

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

describe('recoverSiblingBundleQueue', () => {
  it('re-uploads a dead instance bundle and removes it on confirmed delivery', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('a prior crash'))]]);
    const pipeline = okPipeline();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect((pipeline.enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('a prior crash');
    expect(shared.map.has('dead/b1')).toBe(false); // delivered → durable copy dropped
  });

  it('keeps the bundle when delivery is NOT confirmed (retry next launch)', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('x'))]]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.resolve({ ok: false }),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(shared.map.has('dead/b1')).toBe(true); // not delivered → kept
  });

  it('purges an unparseable leftover (onError) and survives an enqueue throw', async () => {
    const onError = vi.fn();
    const shared = memBlobWith([
      ['dead/bad', new Uint8Array([1, 2, 3])], // not a serialized bundle
      ['dead/throws', serializeBundle(aBundle('y'))],
    ]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.reject(new Error('net down')),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, onError);
    expect(shared.map.has('dead/bad')).toBe(false); // unparseable → purged
    expect(shared.map.has('dead/throws')).toBe(true); // enqueue threw → kept for retry
    expect(onError).toHaveBeenCalledTimes(2); // the parse error + the enqueue throw
  });

  it('only touches the named instance prefix (never another instance bundle)', async () => {
    const shared = memBlobWith([
      ['dead/b1', serializeBundle(aBundle('dead'))],
      ['other/b2', serializeBundle(aBundle('other'))],
    ]);
    await recoverSiblingBundleQueue(shared.store, 'dead', okPipeline());
    expect(shared.map.has('dead/b1')).toBe(false); // recovered
    expect(shared.map.has('other/b2')).toBe(true); // untouched
  });

  it('swallows an unparseable leftover with the default no-op onError (no onError arg, never throws)', async () => {
    const shared = memBlobWith([['dead/bad', new Uint8Array([9, 9, 9])]]);
    await expect(
      recoverSiblingBundleQueue(shared.store, 'dead', okPipeline()),
    ).resolves.toBeUndefined();
    expect(shared.map.has('dead/bad')).toBe(false); // still purged under the default onError
  });

  it('routes a loadAll failure to onError and recovers nothing (never throws)', async () => {
    const onError = vi.fn();
    const shared: AsyncBlobStore = {
      loadAll: () => Promise.reject(new Error('idb gone')),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const pipeline = okPipeline();
    await expect(
      recoverSiblingBundleQueue(shared, 'dead', pipeline, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(pipeline.enqueue).not.toHaveBeenCalled();
  });
});
