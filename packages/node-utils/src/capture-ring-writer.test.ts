import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileChunkBackend } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocCaptureRing, RingProducer } from './capture-ring';
import { encodePathId } from './capture-ring-drainer';
import {
  type CaptureRingWriterOptions,
  createCaptureRingWriter,
  createSyncRingWorker,
  type RingWorker,
  type RingWorkerArgs,
} from './capture-ring-writer';

const GEN = 1;
const FILE_TYPES = ['log', 'network', 'traces.system']; // index 0/1/2

const dirs: string[] = [];
const mkRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-ring-writer-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mk = (root: string, over: Partial<CaptureRingWriterOptions> = {}) =>
  createCaptureRingWriter(root, { generation: GEN, fileTypes: FILE_TYPES, ...over });

// The on-disk path the writer/worker uses for (GEN, chunk, file).
const diskPath = (root: string, chunk: number, file: string): string =>
  join(root, '0000000000001', `00000000000${chunk}`, file);

describe('createSyncRingWorker + CaptureRingWriter', () => {
  it('append → flushSync → read sees the frame; nothing on disk until a flush (buffered in the ring)', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', '1\thello\n');
    expect(existsSync(diskPath(root, 0, 'log'))).toBe(false); // buffered in the ring, not yet drained
    s.flushSync?.();
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('1\thello\n'); // worker drained it
    s.dispose?.();
  });

  it('read() flushes first, so a buffered append is visible', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', '2\tx\n');
    expect(s.read(GEN, 0, 'log')).toBe('2\tx\n'); // flush-on-read
    s.dispose?.();
  });

  it('demuxes appends to the right files by type, preserving per-file order', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', 'L1\n');
    s.append(GEN, 0, 'network', 'N1\n');
    s.append(GEN, 0, 'log', 'L2\n');
    s.flushSync?.();
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('L1\nL2\n');
    expect(readFileSync(diskPath(root, 0, 'network'), 'utf8')).toBe('N1\n');
    s.dispose?.();
  });

  it('append round-trips MULTI-BYTE utf-8 exactly (the *3 reserve bound + the encodeInto byte length)', () => {
    // char-length !== byte-length here, so it pins both the upper-bound reserve (a `length` reserve would
    // truncate) AND committing `written` not `dataStr.length` (a char-count commit → a wrong frame length).
    const root = mkRoot();
    const s = mk(root);
    const payload = '日本語\tcafé€ — \u{1F680}\n'; // CJK (3B) + accent (2B) + euro (3B) + astral emoji (4B)
    s.append(GEN, 0, 'log', payload);
    s.flushSync?.();
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe(payload);
    s.dispose?.();
  });

  it('write() replaces a file straight-through on the MAIN thread (meta), independent of the ring', () => {
    const root = mkRoot();
    const s = mk(root);
    s.write(GEN, 0, 'meta', '{"n":0}');
    expect(s.read(GEN, 0, 'meta')).toBe('{"n":0}'); // no flush needed — main wrote it
    s.dispose?.();
  });

  it('sealChunk flushes the chunk then closes its handles (a later append reopens)', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', 'sealed\n');
    s.sealChunk?.(GEN, 0);
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('sealed\n'); // flushed on seal
    s.append(GEN, 0, 'log', 'more\n'); // reopens
    s.flushSync?.();
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('sealed\nmore\n');
    s.dispose?.();
  });

  it('removeChunk closes handles + deletes the chunk dir; removeGeneration deletes the gen', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', 'r\n');
    s.flushSync?.();
    s.removeChunk(GEN, 0);
    expect(existsSync(diskPath(root, 0, 'log'))).toBe(false);
    s.append(GEN, 5, 'log', 'g\n');
    s.flushSync?.();
    s.removeGeneration(GEN);
    expect(existsSync(join(root, '0000000000001'))).toBe(false);
    s.dispose?.();
  });

  it('lists chunks + generations + files by their on-disk names', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', 'a\n');
    s.append(GEN, 2, 'network', 'b\n');
    s.write(GEN, 0, 'meta', 'm');
    s.flushSync?.();
    expect(s.chunks(GEN).sort((a, b) => a - b)).toEqual([0, 2]);
    expect(s.generations()).toEqual([GEN]);
    expect(new Set(s.files(GEN, 0))).toEqual(new Set(['log', 'meta']));
    s.dispose?.();
  });

  it('read of an absent file returns undefined', () => {
    const root = mkRoot();
    const s = mk(root);
    expect(s.read(GEN, 0, 'log')).toBeUndefined();
    s.dispose?.();
  });

  it('an unknown file type (not in fileTypes) falls back to a MAIN-thread append', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'crash', 'boom\n'); // 'crash' not in FILE_TYPES → main-thread append, no flush needed
    expect(readFileSync(diskPath(root, 0, 'crash'), 'utf8')).toBe('boom\n');
    s.dispose?.();
  });

  it('a foreign generation in append falls back to a MAIN-thread append (the live worker writes only its own)', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(99, 0, 'log', 'foreign\n'); // gen 99 ≠ the writer's gen 1
    expect(readFileSync(join(root, '0000000000099', '000000000000', 'log'), 'utf8')).toBe(
      'foreign\n',
    );
    s.dispose?.();
  });

  it('a known-type record too big for the ring falls back to a MAIN-thread append (oversized)', () => {
    const root = mkRoot();
    const s = mk(root, { ringCapacity: 64 }); // tiny ring: a 100-byte record can never fit
    s.append(GEN, 0, 'log', `${'B'.repeat(100)}\n`); // oversized for the ring → main-thread append
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe(`${'B'.repeat(100)}\n`);
    s.dispose?.();
  });

  it('swallows a worker error through the default no-op onError (no onError supplied)', () => {
    const root = mkRoot();
    const fakeFactory = (args: RingWorkerArgs): RingWorker => {
      args.onError(new Error('worker boom')); // exercise the writer's default sink
      return { flushAndWait: vi.fn(), closeChunk: vi.fn(), closeAll: vi.fn(), stop: vi.fn() };
    };
    expect(() => mk(root, { workerFactory: fakeFactory })).not.toThrow();
  });

  it('round-trips through the real file chunk backend (append → snapshot reads it back)', async () => {
    const root = mkRoot();
    const s = mk(root);
    const backend = createFileChunkBackend(s, { generation: GEN, cleanOtherGenerations: false });
    backend.openPart({ generation: GEN, number: 0 }, GEN);
    backend.appendEntry(
      { generation: GEN, number: 0 },
      { type: 'log', timestamp: 1, serialized: JSON.stringify({ timestamp: 1, data: 'hi' }) },
    );
    backend.closePart({ generation: GEN, number: 0 }, GEN + 10, 0);
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

  it('uses the injected workerFactory (the seam the worker_threads impl swaps into)', () => {
    const root = mkRoot();
    const flushAndWait = vi.fn();
    const stop = vi.fn();
    const fakeFactory = (args: RingWorkerArgs): RingWorker => {
      expect(args.captureDir).toBe(root);
      expect(args.generation).toBe(GEN);
      expect(args.fileTypes).toEqual(FILE_TYPES);
      return { flushAndWait, closeChunk: vi.fn(), closeAll: vi.fn(), stop };
    };
    const s = mk(root, { workerFactory: fakeFactory });
    s.flushSync?.();
    expect(flushAndWait).toHaveBeenCalledTimes(1);
    s.dispose?.();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('drives the worker control protocol: seal/removeChunk close the chunk; removeGeneration/dispose close all', () => {
    const root = mkRoot();
    const w = { flushAndWait: vi.fn(), closeChunk: vi.fn(), closeAll: vi.fn(), stop: vi.fn() };
    const s = mk(root, { workerFactory: () => w });

    s.sealChunk?.(GEN, 3);
    expect(w.flushAndWait).toHaveBeenCalledTimes(1); // seal flushes the chunk first…
    expect(w.closeChunk).toHaveBeenCalledWith(3); // …then closes its handles

    s.removeChunk(GEN, 4);
    expect(w.closeChunk).toHaveBeenCalledWith(4); // removeChunk releases the worker's fds before deleting

    s.removeChunk(99, 4); // a FOREIGN generation must NOT touch the worker
    expect(w.closeChunk).toHaveBeenCalledTimes(2); // still only the two own-gen closes

    s.removeGeneration(GEN);
    expect(w.closeAll).toHaveBeenCalledTimes(1); // removing the own gen closes everything

    s.removeGeneration(7); // a foreign gen: pure fs, no worker
    expect(w.closeAll).toHaveBeenCalledTimes(1);

    s.dispose?.();
    expect(w.stop).toHaveBeenCalledTimes(1);
  });

  it('append fallback: a disk error on the main-thread append routes to onError, never throws into the caller', () => {
    // The mainAppend fallback (unknown type / foreign gen / oversized) runs on the MAIN thread — reached
    // synchronously from interceptors + the tick — so a broken disk must NEVER throw out of append.
    const root = mkRoot();
    const errors: unknown[] = [];
    const s = mk(root, {
      onError: (e) => errors.push(e),
      open: () => {
        throw new Error('EROFS main-append');
      },
    });
    expect(() => s.append(GEN, 0, 'crash', 'boom\n')).not.toThrow(); // 'crash' ∉ fileTypes → mainAppend
    expect(errors.map((e) => (e as Error).message)).toEqual(['EROFS main-append']);
    expect(s.read(GEN, 0, 'crash')).toBeUndefined(); // SHED, not silently retained
    s.dispose?.();
  });

  it('append fallback: a write/close failure on the opened fd is fully contained (the finally-close guard)', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    const s = mk(root, {
      onError: (e) => errors.push(e),
      open: () => 999, // a bogus fd → writeSync AND the finally closeSync both fail (EBADF), both contained
    });
    expect(() => s.append(GEN, 0, 'crash', 'x\n')).not.toThrow();
    expect(errors).toHaveLength(2); // the write error AND the close error are both routed, never thrown
    s.dispose?.();
  });

  it('write: a disk error on the meta write routes to onError, never throws into the caller (the tick)', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    const s = mk(root, {
      onError: (e) => errors.push(e),
      writeFile: () => {
        throw new Error('ENOSPC meta');
      },
    });
    expect(() => s.write(GEN, 0, 'meta', '{}')).not.toThrow();
    expect(errors.map((e) => (e as Error).message)).toEqual(['ENOSPC meta']);
    s.dispose?.();
  });

  it('removeChunk / removeGeneration: a disk error deleting the dir routes to onError, never throws (eviction)', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    const s = mk(root, {
      onError: (e) => errors.push(e),
      removeDir: () => {
        throw new Error('EIO unlink');
      },
    });
    expect(() => s.removeChunk(GEN, 0)).not.toThrow();
    expect(() => s.removeGeneration(GEN)).not.toThrow();
    expect(errors).toHaveLength(2);
    s.dispose?.();
  });

  it('A1: creates data files 0600 + chunk dirs 0700 (no group/other access — captured data is private)', () => {
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', 'm\n');
    s.flushSync?.();
    const file = diskPath(root, 0, 'log');
    expect(statSync(file).mode & 0o077).toBe(0); // data file: owner-only
    expect(statSync(join(file, '..')).mode & 0o077).toBe(0); // chunk dir: owner-only
    s.dispose?.();
  });

  it('createSyncRingWorker is the default worker (drains on the main thread)', () => {
    // No workerFactory → the sync worker is used; a flush drains to disk.
    const root = mkRoot();
    const s = mk(root);
    s.append(GEN, 0, 'log', 'default-worker\n');
    s.flushSync?.();
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('default-worker\n');
    s.dispose?.();
  });

  it('createSyncRingWorker directly: drains, closes a chunk, closes all', () => {
    const root = mkRoot();
    const onError = vi.fn();
    const { data, control } = allocCaptureRing(4096);
    const flags = new SharedArrayBuffer(16);
    const args: RingWorkerArgs = {
      data,
      control,
      flags,
      captureDir: root,
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError,
    };
    const worker = createSyncRingWorker(args);
    const p = new RingProducer(data, control);
    const enc = new TextEncoder();
    const frame = enc.encode('Z\n');
    const view = p.reserve(frame.length) as Uint8Array;
    view.set(frame);
    p.commit(encodePathId(0, 0), frame.length); // chunk 0, type 0 = 'log'
    worker.flushAndWait(1000);
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('Z\n');
    worker.closeChunk(0);
    worker.closeAll();
    worker.stop();
    expect(onError).not.toHaveBeenCalled();
  });
});
