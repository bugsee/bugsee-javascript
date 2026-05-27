import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredEntry } from '@bugsee/core';
import { createFileCaptureStore } from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeFileStorageAdapter } from './file-storage-adapter';
import { remove } from './fs-storage';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-fsa-test-'));
});
afterEach(() => {
  remove(root);
});

describe('createNodeFileStorageAdapter', () => {
  it('creates the directory on construction', () => {
    const dir = join(root, 'nested', 'store');
    createNodeFileStorageAdapter(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('append then read round-trips text under the directory', () => {
    const adapter = createNodeFileStorageAdapter(root);
    adapter.append('log', 'line-1\n');
    adapter.append('log', 'line-2\n');
    expect(adapter.read('log')).toBe('line-1\nline-2\n');
  });

  it('read returns undefined for an absent stream', () => {
    const adapter = createNodeFileStorageAdapter(root);
    expect(adapter.read('missing')).toBeUndefined();
  });

  it('names lists the streams written so far', () => {
    const adapter = createNodeFileStorageAdapter(root);
    adapter.append('log', 'a\n');
    adapter.append('network', 'b\n');
    expect(adapter.names().sort()).toEqual(['log', 'network']);
  });

  it('remove deletes a stream', () => {
    const adapter = createNodeFileStorageAdapter(root);
    adapter.append('log', 'a\n');
    adapter.remove('log');
    expect(adapter.read('log')).toBeUndefined();
    expect(adapter.names()).toEqual([]);
  });

  // Integration: the core file store works end-to-end over the real node:fs adapter.
  it('drives core createFileCaptureStore over real disk', async () => {
    const store = createFileCaptureStore(createNodeFileStorageAdapter(root));
    const a: StoredEntry = { type: 'log', timestamp: 1, serialized: '{"m":"a"}' };
    const b: StoredEntry = { type: 'network', timestamp: 2, serialized: '{"u":"x"}' };
    store.add(a);
    store.add(b);
    const snap = await store.snapshot().drainAll();
    expect(snap.get('log')).toEqual([a]);
    expect(snap.get('network')).toEqual([b]);
  });
});
