import { describe, expect, it } from 'vitest';
import type { AsyncBlobStore } from './idb';
import {
  coexistenceDatabaseName,
  createPrefixedBlobStore,
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
