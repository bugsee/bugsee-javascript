import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeBundleStore } from './bundle-store';

describe('createNodeBundleStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-bundlestore-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips bundle bytes through put + read', () => {
    const store = createNodeBundleStore(dir);
    const bytes = new Uint8Array([0x50, 0x4b, 9, 8, 7]);
    store.put('abc', bytes);
    expect([...(store.read('abc') ?? [])]).toEqual([...bytes]);
  });

  it('creates the directory if it does not exist', () => {
    const nested = join(dir, 'pending');
    const store = createNodeBundleStore(nested); // must not throw
    store.put('x', new Uint8Array([1]));
    expect(store.read('x')).toBeDefined();
  });

  it('lists the ids of stored bundles (suffix stripped), ignoring foreign files', () => {
    const store = createNodeBundleStore(dir);
    store.put('one', new Uint8Array([1]));
    store.put('two', new Uint8Array([2]));
    writeFileSync(join(dir, 'not-a-bundle.txt'), 'x'); // a foreign file in the dir
    expect(store.list().sort()).toEqual(['one', 'two']);
  });

  it('returns undefined when reading an absent id', () => {
    expect(createNodeBundleStore(dir).read('missing')).toBeUndefined();
  });

  it('remove deletes the bundle (gone from list and read)', () => {
    const store = createNodeBundleStore(dir);
    store.put('gone', new Uint8Array([1]));
    store.remove('gone');
    expect(store.list()).toEqual([]);
    expect(store.read('gone')).toBeUndefined();
  });

  it('remove is a no-op for an absent id', () => {
    expect(() => createNodeBundleStore(dir).remove('nope')).not.toThrow();
  });

  it('keeps multiple bundles independent', () => {
    const store = createNodeBundleStore(dir);
    store.put('a', new Uint8Array([10]));
    store.put('b', new Uint8Array([20]));
    expect([...(store.read('a') ?? [])]).toEqual([10]);
    expect([...(store.read('b') ?? [])]).toEqual([20]);
    store.remove('a');
    expect(store.read('a')).toBeUndefined();
    expect([...(store.read('b') ?? [])]).toEqual([20]); // b untouched
  });
});
