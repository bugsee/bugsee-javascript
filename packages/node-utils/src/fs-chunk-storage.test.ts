import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredEntry } from '@bugsee/core';
import { createFileCaptureStore } from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsChunkStorage } from './fs-chunk-storage';
import { ensureDir, remove } from './fs-storage';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-fscs-test-'));
});
afterEach(() => {
  remove(root);
});

describe('createFsChunkStorage', () => {
  it('creates the root directory on construction', () => {
    const dir = join(root, 'nested', 'capture');
    createFsChunkStorage(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('append accumulates within a (generation, chunk, file) and lays out gen/chunk dirs', () => {
    const s = createFsChunkStorage(root);
    s.append(1717000000000, 0, 'log', 'a\n');
    s.append(1717000000000, 0, 'log', 'b\n');
    expect(s.read(1717000000000, 0, 'log')).toBe('a\nb\n');
    // zero-padded directory names so a lexical listing sorts numerically.
    expect(statSync(join(root, '1717000000000', '000000000000', 'log')).isFile()).toBe(true);
  });

  it('write replaces, read returns undefined for an absent file/chunk/generation', () => {
    const s = createFsChunkStorage(root);
    s.append(5, 0, 'meta', 'old');
    s.write(5, 0, 'meta', 'new');
    expect(s.read(5, 0, 'meta')).toBe('new');
    expect(s.read(5, 0, 'missing')).toBeUndefined();
    expect(s.read(5, 9, 'meta')).toBeUndefined();
    expect(s.read(9, 0, 'meta')).toBeUndefined();
  });

  it('files lists a chunk’s files (and [] for an absent chunk)', () => {
    const s = createFsChunkStorage(root);
    s.write(5, 0, 'meta', 'm');
    s.append(5, 0, 'log', 'l');
    expect(s.files(5, 0).sort()).toEqual(['log', 'meta']);
    expect(s.files(5, 9)).toEqual([]);
  });

  it('chunks + generations list numeric dir names and skip foreign entries', () => {
    const s = createFsChunkStorage(root);
    s.write(5, 2, 'log', 'x');
    s.write(5, 0, 'log', 'x');
    s.write(7, 0, 'log', 'x');
    const gen5Dir = String(5).padStart(13, '0'); // the real (padded) generation-5 directory
    writeFileSync(join(root, 'not-a-generation'), 'junk'); // a foreign, non-numeric root entry
    ensureDir(join(root, '12.5')); // a fractional name: numeric but NOT an integer (Number.isInteger guard)
    ensureDir(join(root, gen5Dir, 'not-a-chunk')); // a foreign, non-numeric chunk dir under gen 5
    ensureDir(join(root, gen5Dir, '1.5')); // a fractional chunk name (Number.isInteger guard)
    expect(s.chunks(5).sort((a, b) => a - b)).toEqual([0, 2]); // 1.5 excluded
    expect(s.generations().sort((a, b) => a - b)).toEqual([5, 7]); // 12.5 excluded
  });

  it('removeChunk deletes the whole chunk dir; removeGeneration deletes the generation', () => {
    const s = createFsChunkStorage(root);
    s.write(5, 0, 'log', 'a');
    s.write(5, 1, 'log', 'b');
    s.write(7, 0, 'log', 'c');
    s.removeChunk(5, 0);
    expect(s.chunks(5)).toEqual([1]);
    s.removeGeneration(5);
    expect(s.generations()).toEqual([7]);
  });

  // Integration: the core file store works end-to-end over the real node:fs chunk storage.
  it('drives core createFileCaptureStore over real disk (data + durable meta survive)', async () => {
    const storage = createFsChunkStorage(root);
    const store = createFileCaptureStore(storage, { generation: 42 });
    const a: StoredEntry = { type: 'log', timestamp: 1, serialized: '{"m":"a"}' };
    const b: StoredEntry = { type: 'network', timestamp: 2, serialized: '{"u":"x"}' };
    store.add(a);
    store.add(b);
    const snap = await store.snapshot().drainAll();
    expect(snap.get('log')).toEqual([a]);
    expect(snap.get('network')).toEqual([b]);
    // The durable meta file was written to disk for the open part (recovery prerequisite).
    expect(JSON.parse(storage.read(42, 0, 'meta') as string)).toMatchObject({ n: 0, e: null });
  });
});
