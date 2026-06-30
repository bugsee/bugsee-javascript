import { describe, expect, it } from 'vitest';
import type { AsyncBlobStore, AsyncKeyedStore } from './idb';
import {
  coexistenceDatabaseName,
  createPrefixedBlobStore,
  createPrefixedKeyedStore,
  hashToken,
  instanceLockName,
  makeInstanceId,
  splitInstanceKey,
} from './instance-coexistence';

function memBlob() {
  const map = new Map<string, Uint8Array>();
  const store: AsyncBlobStore = {
    loadAll: () => Promise.resolve([...map.entries()]),
    put: (id, bytes) => {
      map.set(id, bytes);
      return Promise.resolve();
    },
    remove: (id) => {
      map.delete(id);
      return Promise.resolve();
    },
  };
  return { store, map };
}

describe('hashToken / database + lock names', () => {
  it('is deterministic + 8 hex chars; different tokens (almost always) differ', () => {
    expect(hashToken('tok-A')).toBe(hashToken('tok-A')); // stable
    expect(hashToken('tok-A')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashToken('tok-A')).not.toBe(hashToken('tok-B')); // namespaces different apps apart
  });

  it('builds the per-token database + per-instance lock names', () => {
    const h = hashToken('tok');
    expect(coexistenceDatabaseName('tok')).toBe(`bugsee-${h}`);
    expect(instanceLockName('tok', 'inst-1')).toBe(`bugsee/${h}/inst-1`);
  });
});

describe('makeInstanceId', () => {
  it('returns a non-empty hex id with no slash (a safe key prefix), unique per call', () => {
    const a = makeInstanceId();
    const b = makeInstanceId();
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a).not.toContain('/');
    expect(a).not.toBe(b);
  });
});

describe('splitInstanceKey', () => {
  it('splits "<instanceId>/<id>" and ignores keys with no leading instance segment', () => {
    expect(splitInstanceKey('inst-9/bundle-3')).toEqual({ instanceId: 'inst-9', id: 'bundle-3' });
    expect(splitInstanceKey('inst-9/a/b')).toEqual({ instanceId: 'inst-9', id: 'a/b' }); // first slash only
    expect(splitInstanceKey('nope')).toBeUndefined(); // no slash
    expect(splitInstanceKey('/leading')).toBeUndefined(); // empty instance segment
  });
});

describe('createPrefixedBlobStore', () => {
  it('prefixes put/remove and prefix-filters + strips loadAll (instance A never sees B)', async () => {
    const shared = memBlob();
    const a = createPrefixedBlobStore(shared.store, 'A');
    const b = createPrefixedBlobStore(shared.store, 'B');

    await a.put('one', new Uint8Array([1]));
    await b.put('two', new Uint8Array([2]));
    expect([...shared.map.keys()].sort()).toEqual(['A/one', 'B/two']); // physically prefixed in the shared store

    expect(await a.loadAll()).toEqual([['one', new Uint8Array([1])]]); // A sees only its own, un-prefixed
    expect(await b.loadAll()).toEqual([['two', new Uint8Array([2])]]);

    await a.remove('one');
    expect([...shared.map.keys()]).toEqual(['B/two']); // removing A's id only touched A's prefix
    expect(await a.loadAll()).toEqual([]);
  });
});

function memKeyed() {
  const map = new Map<string, Uint8Array>();
  const matches = (prefix: string) =>
    [...map.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1));
  const store: AsyncKeyedStore = {
    put: (key, bytes) => {
      map.set(key, bytes);
      return Promise.resolve();
    },
    readPrefix: (prefix) => Promise.resolve(matches(prefix).map(([k, v]) => [k, v])),
    keys: (prefix) => Promise.resolve(matches(prefix).map(([k]) => k)),
    deletePrefix: (prefix) => {
      for (const [key] of matches(prefix)) {
        map.delete(key);
      }
      return Promise.resolve();
    },
  };
  return { store, map };
}

describe('createPrefixedKeyedStore', () => {
  it('prefixes put/readPrefix/keys/deletePrefix and strips on read (instance A never sees B)', async () => {
    const shared = memKeyed();
    const a = createPrefixedKeyedStore(shared.store, 'A');
    const b = createPrefixedKeyedStore(shared.store, 'B');

    await a.put('d/5/0', new Uint8Array([1]));
    await a.put('m/5/0', new Uint8Array([2]));
    await b.put('d/5/0', new Uint8Array([9])); // same inner key, different instance

    expect([...shared.map.keys()].sort()).toEqual(['A/d/5/0', 'A/m/5/0', 'B/d/5/0']); // physically prefixed

    expect(await a.readPrefix('d/')).toEqual([['d/5/0', new Uint8Array([1])]]); // A's own, un-prefixed
    expect(await a.keys('')).toEqual(['A/d/5/0', 'A/m/5/0'].map((k) => k.slice(2))); // ['d/5/0','m/5/0']
    expect(await b.readPrefix('d/')).toEqual([['d/5/0', new Uint8Array([9])]]); // B's, isolated

    await a.deletePrefix('d/');
    expect([...shared.map.keys()].sort()).toEqual(['A/m/5/0', 'B/d/5/0']); // only A's d/ range removed
  });
});
