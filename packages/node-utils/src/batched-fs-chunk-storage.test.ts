import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileChunkBackend } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createBatchedFsChunkStorage } from './batched-fs-chunk-storage';

const dirs: string[] = [];
const mkRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-batched-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GEN = 1;
const CHUNK = 0;
// The on-disk path the storage writes for (GEN, CHUNK, file).
const diskPath = (root: string, file: string): string =>
  join(root, '0000000000001', '000000000000', file);
const rawLines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];

describe('createBatchedFsChunkStorage', () => {
  it('BUFFERS appends — nothing on disk until flushSync', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(GEN, CHUNK, 'log', 'a\n');
    s.append(GEN, CHUNK, 'log', 'b\n');

    expect(rawLines(diskPath(root, 'log'))).toEqual([]); // buffered, not yet written
    s.flushSync?.();
    expect(rawLines(diskPath(root, 'log'))).toEqual(['a', 'b']); // one writev landed both
    s.dispose?.();
  });

  it('read() flushes first, so a reader sees everything buffered', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(GEN, CHUNK, 'log', 'x\n');
    expect(s.read(GEN, CHUNK, 'log')).toBe('x\n'); // flush-on-read
    expect(rawLines(diskPath(root, 'log'))).toEqual(['x']); // and it's actually on disk now
    s.dispose?.();
  });

  it('flushes automatically at the high-water mark', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 8 });
    s.append(GEN, CHUNK, 'log', 'aaaa\n'); // 5 bytes — under HWM, buffered
    expect(rawLines(diskPath(root, 'log'))).toEqual([]);
    s.append(GEN, CHUNK, 'log', 'bbbb\n'); // total 10 ≥ 8 → flush
    expect(rawLines(diskPath(root, 'log'))).toEqual(['aaaa', 'bbbb']);
    s.dispose?.();
  });

  it('an oversized single entry flushes on its own', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 16 });
    s.append(GEN, CHUNK, 'log', `${'z'.repeat(100)}\n`); // single entry > HWM → immediate write
    expect(rawLines(diskPath(root, 'log'))).toEqual(['z'.repeat(100)]);
    s.dispose?.();
  });

  it('sealChunk flushes + closes the chunk handles', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(GEN, CHUNK, 'log', 'sealed\n'); // buffered
    s.sealChunk?.(GEN, CHUNK);
    expect(rawLines(diskPath(root, 'log'))).toEqual(['sealed']); // flushed on seal
    s.dispose?.();
  });

  it('dispose flushes + closes everything', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(GEN, CHUNK, 'log', 'd1\n');
    s.append(GEN, CHUNK, 'network', 'd2\n');
    s.dispose?.();
    expect(rawLines(diskPath(root, 'log'))).toEqual(['d1']);
    expect(rawLines(diskPath(root, 'network'))).toEqual(['d2']);
  });

  it('removeChunk / removeGeneration close handles then delete the dirs', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(GEN, CHUNK, 'log', 'r\n');
    s.removeChunk(GEN, CHUNK);
    expect(existsSync(diskPath(root, 'log'))).toBe(false);
    s.append(2, 5, 'log', 'g\n');
    s.removeGeneration(2);
    expect(existsSync(join(root, '0000000000002'))).toBe(false);
    s.dispose?.();
  });

  it('write() replaces straight-through and coexists with buffered appends to other files', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(GEN, CHUNK, 'log', 'keep\n'); // buffered append to the data file
    s.write(GEN, CHUNK, 'meta', '{"n":0}'); // meta write lands immediately
    expect(s.read(GEN, CHUNK, 'meta')).toBe('{"n":0}');
    expect(s.read(GEN, CHUNK, 'log')).toBe('keep\n'); // the append survived
    s.dispose?.();
  });

  it('splits a flush larger than IOV_MAX into multiple writev calls (all entries survive)', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 100 * 1024 * 1024 }); // never auto-flush
    for (let i = 0; i < 1500; i++) s.append(GEN, CHUNK, 'log', `${i}\n`); // > IOV_MAX (1024) segments
    s.flushSync?.();
    expect(rawLines(diskPath(root, 'log'))).toHaveLength(1500);
    expect(rawLines(diskPath(root, 'log'))[1499]).toBe('1499');
    s.dispose?.();
  });

  it('lists generations + chunks by their numeric dir names', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(3, 7, 'log', 'a\n');
    s.append(3, 9, 'log', 'b\n');
    s.append(5, 0, 'log', 'c\n');
    s.dispose?.();
    expect(s.generations().sort((a, b) => a - b)).toEqual([3, 5]);
    expect(s.chunks(3).sort((a, b) => a - b)).toEqual([7, 9]);
    expect(s.chunks(99)).toEqual([]); // absent generation
  });

  it('round-trips through the real file chunk backend (append → snapshot reads it back)', async () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    const backend = createFileChunkBackend(s, { generation: GEN, cleanOtherGenerations: false });
    backend.openPart({ generation: GEN, number: 0 }, GEN);
    backend.appendEntry(
      { generation: GEN, number: 0 },
      { type: 'log', timestamp: 1, serialized: JSON.stringify({ timestamp: 1, data: 'hi' }) },
    );
    backend.closePart({ generation: GEN, number: 0 }, GEN + 10, 0);
    // snapshot reads the (buffered-then-flushed) data file via storage.read → sees the entry.
    const snap = backend.snapshot([
      { ref: { generation: GEN, number: 0 }, count: Number.MAX_SAFE_INTEGER },
    ]);
    const records = await snap.drainAll();
    snap.release();
    const logs = records.get('log') ?? [];
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]?.serialized ?? '{}').data).toBe('hi');
    s.dispose?.();
  });
});
