import 'fake-indexeddb/auto';
import { type Bundle, serializeBundle, type UploadPipeline } from '@bugsee/core';
import { Severity } from '@bugsee/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoexistentBundleQueue } from './bundle-queue-coexistence';
import { createIdbBlobStore } from './idb';
import { coexistenceDatabaseName, hashToken, instanceLockName } from './instance-coexistence';
import { createWebLockLiveness, type LockManagerLike } from './web-lock-liveness';

const TOK = 'app-token';

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
  fileName: 'b.zip',
});

// In-memory Web Locks fake (node has no navigator.locks). `held()` exposes the lifetime-held (live) locks.
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
  return {
    manager,
    held: () => [...heldForever],
    kill: (name: string) => heldForever.delete(name),
  };
}

const okPipeline = (): UploadPipeline & { enqueue: ReturnType<typeof vi.fn> } => ({
  enqueue: vi.fn(() => Promise.resolve({ ok: true })),
  flush: vi.fn(() => Promise.resolve(true)),
  drop: vi.fn(),
});

// Seed a bundle into another instance's prefix within the per-token coexistence database.
async function seedSibling(idb: IDBFactory, instanceId: string, bundleId: string, b: Bundle) {
  const shared = createIdbBlobStore({ databaseName: coexistenceDatabaseName(TOK), indexedDB: idb });
  await shared.put(`${instanceId}/${bundleId}`, serializeBundle(b));
}

const rawKeys = (idb: IDBFactory) =>
  createIdbBlobStore({ databaseName: coexistenceDatabaseName(TOK), indexedDB: idb })
    .loadAll()
    .then((entries) => entries.map(([k]) => k));

afterEach(() => vi.unstubAllGlobals());

describe('createCoexistentBundleQueue — pass-through', () => {
  it('returns an explicit override and never builds a coexistence layer', async () => {
    const idb = new IDBFactory();
    const override = { put: vi.fn(), list: () => [], read: () => undefined, remove: vi.fn() };
    const pipeline = okPipeline();
    await seedSibling(idb, 'deadsib', 'b1', aBundle('orphan'));

    const queue = createCoexistentBundleQueue({
      appToken: TOK,
      persist: true,
      override,
      indexedDB: idb,
      locks: fakeLocks().manager,
    });
    expect(queue.bundleStore).toBe(override);
    await queue.recoverDeadSiblings(pipeline);
    expect(pipeline.enqueue).not.toHaveBeenCalled(); // override ⇒ no sibling recovery
    expect(await rawKeys(idb)).toContain('deadsib/b1'); // untouched
  });

  it('builds nothing when persist is false', async () => {
    const pipeline = okPipeline();
    const queue = createCoexistentBundleQueue({
      appToken: TOK,
      persist: false,
      locks: fakeLocks().manager,
    });
    expect(queue.bundleStore).toBeUndefined();
    await queue.recoverDeadSiblings(pipeline);
    expect(pipeline.enqueue).not.toHaveBeenCalled();
  });
});

describe('createCoexistentBundleQueue — persisting', () => {
  it('writes under a per-token database + per-instance prefix and holds the instance lock', async () => {
    const idb = new IDBFactory();
    const locks = fakeLocks();
    const queue = createCoexistentBundleQueue({
      appToken: TOK,
      persist: true,
      indexedDB: idb,
      locks: locks.manager,
    });
    const store = queue.bundleStore as NonNullable<typeof queue.bundleStore> & {
      whenReady: Promise<void>;
    };
    await store.whenReady;
    store.put('mine', serializeBundle(aBundle('local')));
    await Promise.resolve(); // let the async write-through settle

    const keys = await rawKeys(idb);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}\/mine$/); // <instanceId>/mine, in bugsee-<hash>

    // The instance holds exactly its own lock for the realm's lifetime (the liveness signal).
    const held = locks.held();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatch(new RegExp(`^bugsee/${hashToken(TOK)}/[0-9a-f]{32}$`));
  });

  it('recovers a DEAD sibling bundle (re-uploads + drops it) and SKIPS a LIVE sibling', async () => {
    const idb = new IDBFactory();
    const locks = fakeLocks();
    // A live sibling holds its lock; a dead one never did.
    createWebLockLiveness(locks.manager).holdSelf(instanceLockName(TOK, 'livesib'));
    await seedSibling(idb, 'deadsib', 'b1', aBundle('dead crash'));
    await seedSibling(idb, 'livesib', 'b2', aBundle('live, in flight'));

    const pipeline = okPipeline();
    const queue = createCoexistentBundleQueue({
      appToken: TOK,
      persist: true,
      indexedDB: idb,
      locks: locks.manager,
    });
    await queue.recoverDeadSiblings(pipeline);

    expect(pipeline.enqueue).toHaveBeenCalledTimes(1); // only the dead sibling
    expect((pipeline.enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('dead crash');
    const keys = await rawKeys(idb);
    expect(keys).not.toContain('deadsib/b1'); // delivered → removed
    expect(keys).toContain('livesib/b2'); // alive → left for its own instance
  });

  it('falls back to globalThis.indexedDB when none is injected', async () => {
    // No `indexedDB` option → the store opens the ambient IDB (fake-indexeddb/auto). A distinct token
    // keeps this test in its own database, away from the injected-factory tests above.
    const queue = createCoexistentBundleQueue({
      appToken: 'global-idb-tok',
      persist: true,
      locks: fakeLocks().manager,
    });
    const store = queue.bundleStore as NonNullable<typeof queue.bundleStore> & {
      whenReady: Promise<void>;
    };
    await store.whenReady;
    store.put('g', serializeBundle(aBundle('via global idb')));
    await Promise.resolve();
    expect(store.list()).toContain('g'); // round-trips through the ambient IndexedDB
  });

  it('degrades when Web Locks is unavailable: still persists locally, recovers no sibling', async () => {
    vi.stubGlobal('navigator', undefined); // no navigator.locks
    const idb = new IDBFactory();
    const onError = vi.fn();
    await seedSibling(idb, 'deadsib', 'b1', aBundle('orphan'));

    const pipeline = okPipeline();
    const queue = createCoexistentBundleQueue({
      appToken: TOK,
      persist: true,
      indexedDB: idb,
      onError, // the unavailable warning is routed here as an Error
    });
    const store = queue.bundleStore as NonNullable<typeof queue.bundleStore> & {
      whenReady: Promise<void>;
    };
    await store.whenReady;
    store.put('mine', serializeBundle(aBundle('local')));
    await Promise.resolve();
    expect((await rawKeys(idb)).some((k) => k.endsWith('/mine'))).toBe(true); // local persistence works

    await queue.recoverDeadSiblings(pipeline);
    expect(pipeline.enqueue).not.toHaveBeenCalled(); // no liveness ⇒ no cross-instance recovery
    expect(await rawKeys(idb)).toContain('deadsib/b1'); // the orphan is left untouched
    expect(onError).toHaveBeenCalledTimes(1); // the one-time unavailable warning
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('navigator.locks unavailable');
  });
});
