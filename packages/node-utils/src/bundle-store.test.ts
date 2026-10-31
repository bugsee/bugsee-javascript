import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('createNodeBundleStore — a staged bundle is never half-written', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-bundle-atomic-'));
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the previously staged bundle intact when a re-stage fails', () => {
    // `recover()` reads `<id>.bundle` and uploads whatever body follows a parseable header, so a
    // truncated file is a corrupt bundle delivered as though valid — worse than no bundle at all.
    const store = createNodeBundleStore(dir);
    store.put('b1', new Uint8Array([1, 2, 3]));
    chmodSync(dir, 0o500); // no new entries → the temp write fails, though the file itself is writable
    expect(() => store.put('b1', new Uint8Array([9, 9, 9, 9, 9]))).toThrow();
    chmodSync(dir, 0o700);
    expect(store.read('b1')).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.list()).toEqual(['b1']);
  });

  it('never lists a temp sibling as a recoverable bundle', () => {
    const store = createNodeBundleStore(dir);
    writeFileSync(join(dir, 'b2.bundle.999.tmp'), new Uint8Array([7]));
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toContain('b2.bundle.999.tmp'); // it is there, just not offered to recovery
  });

  describe('putFrame (streamed body)', () => {
    const body = (chunks: number[][], over: Record<string, unknown> = {}) => ({
      size: chunks.reduce((n, c) => n + c.length, 0),
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield new Uint8Array(c);
        },
      }),
      bytes: async () => new Uint8Array(),
      peek: () => undefined,
      dispose: () => {},
      ...over,
    });

    it('writes header then every body chunk as one frame, readable with read()', async () => {
      const store = createNodeBundleStore(dir);
      await store.putFrame?.('f', new Uint8Array([1, 2]), body([[3, 4], [5], [6, 7]]));
      expect([...(store.read('f') ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(store.list()).toEqual(['f']);
    });

    it('replaces an existing blob of that id, and the file is owner-only', async () => {
      const store = createNodeBundleStore(dir);
      store.put('f', new Uint8Array([9, 9, 9, 9]));
      await store.putFrame?.('f', new Uint8Array([1]), body([[2]]));
      expect([...(store.read('f') ?? [])]).toEqual([1, 2]);
      const { statSync } = await import('node:fs');
      expect(statSync(join(dir, 'f.bundle')).mode & 0o777).toBe(0o600);
    });

    it('a body that fails part-way rejects, leaves no temp file, and keeps the previous blob', async () => {
      const store = createNodeBundleStore(dir);
      store.put('f', new Uint8Array([9, 9]));
      const failing = body([[1]], {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array([1]);
            throw new Error('stream broke');
          },
        }),
      });
      await expect(store.putFrame?.('f', new Uint8Array([0]), failing)).rejects.toThrow(
        'stream broke',
      );
      expect(readdirSync(dir)).toEqual(['f.bundle']);
      expect([...(store.read('f') ?? [])]).toEqual([9, 9]);
    });

    it('never makes a half-written frame visible to list() while writing', async () => {
      const store = createNodeBundleStore(dir);
      let seen: string[] = [];
      const slow = body([[1]], {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array([1]);
            seen = store.list();
            yield new Uint8Array([2]);
          },
        }),
      });
      await store.putFrame?.('f', new Uint8Array([0]), slow);
      expect(seen).toEqual([]);
      expect(store.list()).toEqual(['f']);
    });

    it('an empty body is just the header', async () => {
      const store = createNodeBundleStore(dir);
      await store.putFrame?.('f', new Uint8Array([5, 6]), body([]));
      expect([...(store.read('f') ?? [])]).toEqual([5, 6]);
    });
  });
});
