import {
  closeSync as closeSyncReal,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writevSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileChunkBackend } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createBatchedFsChunkStorage, type WritevFn } from './batched-fs-chunk-storage';

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

  it('splits a flush larger than IOV_MAX into multiple writev calls, preserving order (all entries survive)', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 100 * 1024 * 1024 }); // never auto-flush
    for (let i = 0; i < 1500; i++) s.append(GEN, CHUNK, 'log', `${i}\n`); // > IOV_MAX (1024) segments
    s.flushSync?.();
    // Assert the FULL ordered sequence (not just count + tail) so a reorder/duplicate across the split seam fails.
    expect(rawLines(diskPath(root, 'log'))).toEqual(
      Array.from({ length: 1500 }, (_, i) => String(i)),
    );
    s.dispose?.();
  });

  it('flushSync flushes ALL open files, not just the first', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1 << 30 }); // never auto-flush
    s.append(GEN, CHUNK, 'log', 'L\n');
    s.append(GEN, CHUNK, 'network', 'N\n');
    s.append(GEN, CHUNK, 'trace', 'T\n');
    s.flushSync?.();
    expect(rawLines(diskPath(root, 'log'))).toEqual(['L']);
    expect(rawLines(diskPath(root, 'network'))).toEqual(['N']);
    expect(rawLines(diskPath(root, 'trace'))).toEqual(['T']);
    s.dispose?.();
  });

  it('honors writev SHORT writes mid-segment AND across a full segment boundary (no truncation/duplication)', () => {
    const root = mkRoot();
    // Two genuine partial writes to the real fd: first exactly 5 bytes (the whole first segment — exercising
    // the skip-full-segment loop with consumed landing on a boundary), then 3 bytes (mid second segment),
    // then the rest. Covers both the on-boundary (consumed === 0) and mid-segment (consumed > 0) short-write cases.
    const sizes = [5, 3];
    let call = 0;
    const writev: WritevFn = (fd, buffers) => {
      const all = Buffer.concat(buffers.map((b) => Buffer.from(b)));
      const n = sizes[call++];
      if (n !== undefined) {
        return writeSync(fd, all, 0, Math.min(n, all.length)); // partial: write only n bytes, report n
      }
      return writevSync(fd, buffers as NodeJS.ArrayBufferView[]);
    };
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1 << 30, writev });
    s.append(GEN, CHUNK, 'log', 'aaaa\n'); // 5 bytes
    s.append(GEN, CHUNK, 'log', 'bbbb\n'); // 5 bytes → total 10; flushed across several short writes
    s.flushSync?.();
    expect(rawLines(diskPath(root, 'log'))).toEqual(['aaaa', 'bbbb']); // intact, no truncation, no duplication
    s.dispose?.();
  });

  it('routes a close() failure to onError without throwing (the entry is still dropped)', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    let closed = false;
    const s = createBatchedFsChunkStorage(root, {
      highWaterMark: 1 << 30,
      onError: (e) => errors.push(e),
      close: (fd) => {
        closeSyncReal(fd); // really close so no fd leaks in the test…
        closed = true;
        throw new Error('close failed'); // …but report a failure to exercise the catch
      },
    });
    s.append(GEN, CHUNK, 'log', 'c\n');
    expect(() => s.dispose?.()).not.toThrow();
    expect(closed).toBe(true);
    expect(errors.some((e) => (e as Error).message === 'close failed')).toBe(true);
  });

  it('a partial write THEN a throw mid-drain does NOT duplicate the already-written prefix on retry', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    let call = 0;
    const writev: WritevFn = (fd, buffers) => {
      call++;
      const all = Buffer.concat(buffers.map((b) => Buffer.from(b)));
      if (call === 1) return writeSync(fd, all, 0, 4); // 4 bytes actually land ('aaaa')…
      if (call === 2) throw new Error('ENOSPC mid-drain'); // …then the very next writev fails
      return writevSync(fd, buffers as NodeJS.ArrayBufferView[]);
    };
    const s = createBatchedFsChunkStorage(root, {
      highWaterMark: 1 << 30,
      writev,
      onError: (e) => errors.push(e),
    });
    s.append(GEN, CHUNK, 'log', 'aaaa\n'); // 5 bytes
    s.append(GEN, CHUNK, 'log', 'bbbb\n'); // 5 bytes
    s.flushSync?.(); // 'aaaa' lands, then the drain throws → onError; only the UNWRITTEN tail stays buffered
    expect(errors).toHaveLength(1);
    s.flushSync?.(); // retry writes ONLY the tail — not the whole buffer again
    expect(rawLines(diskPath(root, 'log'))).toEqual(['aaaa', 'bbbb']); // exactly once: no duplicated 'aaaa'
    s.dispose?.();
  });

  it('a flush failure is routed to onError, the buffer is KEPT for retry, and other files still flush', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    let failNext = true; // throw on the FIRST writev only (the first file flushed), succeed after
    const writev: WritevFn = (fd, buffers) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return writevSync(fd, buffers as NodeJS.ArrayBufferView[]);
    };
    const s = createBatchedFsChunkStorage(root, {
      highWaterMark: 1 << 30,
      writev,
      onError: (e) => errors.push(e),
    });
    s.append(GEN, CHUNK, 'log', 'L\n');
    s.append(GEN, CHUNK, 'network', 'N\n');
    s.flushSync?.(); // first file's writev throws → onError + buffer kept; the second still flushes
    expect(errors).toHaveLength(1);
    // Insertion order is log→network, so log's flush is the one that threw (kept) and network flushed anyway.
    expect(rawLines(diskPath(root, 'log'))).toEqual([]); // the failed file's data is KEPT, not lost…
    expect(rawLines(diskPath(root, 'network'))).toEqual(['N']); // …and a later file still flushed (resilient)
    s.flushSync?.(); // retry — the kept buffer now lands (the data was NOT lost)
    expect(rawLines(diskPath(root, 'log'))).toEqual(['L']);
    expect(rawLines(diskPath(root, 'network'))).toEqual(['N']);
    s.dispose?.();
  });

  it('bails out (does not hang) when the writev sink makes no progress — routes to onError, keeps the buffer', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    let calls = 0;
    const s = createBatchedFsChunkStorage(root, {
      highWaterMark: 1 << 30,
      onError: (e) => errors.push(e),
      writev: (fd, buffers) => {
        calls++;
        if (calls === 1) return 0; // a stuck sink: non-empty batch, zero bytes written → must NOT spin
        return writevSync(fd, buffers as NodeJS.ArrayBufferView[]);
      },
    });
    s.append(GEN, CHUNK, 'log', 'progress\n');
    s.flushSync?.(); // no-progress → throws inside writeAll → caught → onError, buffer kept (no hang)
    expect(errors).toHaveLength(1);
    expect(rawLines(diskPath(root, 'log'))).toEqual([]); // nothing written yet (kept for retry)
    s.flushSync?.(); // retry — the real writev now lands it
    expect(rawLines(diskPath(root, 'log'))).toEqual(['progress']);
    s.dispose?.();
  });

  it('dispose never throws even when a flush fails — the fd is still closed, the error routed', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    const writev: WritevFn = () => {
      throw new Error('always broken');
    };
    const s = createBatchedFsChunkStorage(root, {
      highWaterMark: 1 << 30,
      writev,
      onError: (e) => errors.push(e),
    });
    s.append(GEN, CHUNK, 'log', 'x\n');
    expect(() => s.dispose?.()).not.toThrow(); // closePath flushes (fails → onError) but always closes the fd
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('append: a disk error opening the data file routes to onError and sheds — never throws into the caller', () => {
    // append is reached SYNCHRONOUSLY from interceptors (console.log → capture → add → appendEntry) and
    // from the capture tick; a mid-run broken/full disk must NEVER throw into that path (it would crash
    // the host app or escape as an uncaughtException). It sheds the entry and reports via onError instead.
    const root = mkRoot();
    const errors: unknown[] = [];
    const s = createBatchedFsChunkStorage(root, {
      onError: (e) => errors.push(e),
      open: () => {
        throw new Error('EROFS open');
      },
    });
    expect(() => s.append(GEN, CHUNK, 'log', 'x\n')).not.toThrow();
    expect(errors.map((e) => (e as Error).message)).toEqual(['EROFS open']);
    expect(s.read(GEN, CHUNK, 'log')).toBeUndefined(); // SHED, not silently retained/buffered for a later flush
    s.dispose?.();
  });

  it('write: a disk error replacing the file routes to onError, never throws into the caller (the tick)', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    const s = createBatchedFsChunkStorage(root, {
      onError: (e) => errors.push(e),
      writeFile: () => {
        throw new Error('ENOSPC write');
      },
    });
    expect(() => s.write(GEN, CHUNK, 'meta', '{}')).not.toThrow();
    expect(errors.map((e) => (e as Error).message)).toEqual(['ENOSPC write']);
    s.dispose?.();
  });

  it('removeChunk / removeGeneration: a disk error deleting the dir routes to onError, never throws (eviction)', () => {
    const root = mkRoot();
    const errors: unknown[] = [];
    const s = createBatchedFsChunkStorage(root, {
      onError: (e) => errors.push(e),
      removeDir: () => {
        throw new Error('EIO unlink');
      },
    });
    expect(() => s.removeChunk(GEN, CHUNK)).not.toThrow();
    expect(() => s.removeGeneration(GEN)).not.toThrow();
    expect(errors).toHaveLength(2); // both eviction paths reported, neither threw
    s.dispose?.();
  });

  it('A1: creates data files 0600 + chunk dirs 0700 (no group/other access — captured data is private)', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    s.append(GEN, CHUNK, 'log', 'm\n');
    s.flushSync?.();
    const file = diskPath(root, 'log');
    expect(statSync(file).mode & 0o077).toBe(0); // data file: owner-only
    expect(statSync(join(file, '..')).mode & 0o077).toBe(0); // chunk dir: owner-only
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

  it('works with all default options (real writevSync/closeSync, default HWM + no-op onError)', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root); // no options at all
    s.append(GEN, CHUNK, 'log', 'default\n');
    expect(s.read(GEN, CHUNK, 'log')).toBe('default\n'); // real writevSync flush-on-read
    s.dispose?.(); // real closeSync
    expect(rawLines(diskPath(root, 'log'))).toEqual(['default']);
  });

  it('a flush failure with NO onError supplied is silently swallowed by the default sink (never throws)', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, {
      highWaterMark: 1 << 30,
      writev: () => {
        throw new Error('broken');
      },
    });
    s.append(GEN, CHUNK, 'log', 'z\n');
    expect(() => s.flushSync?.()).not.toThrow(); // default no-op onError absorbs it
    s.dispose?.();
  });

  it('read() returns undefined for a file that does not exist', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1024 });
    expect(s.read(GEN, CHUNK, 'never-written')).toBeUndefined();
    s.dispose?.();
  });

  it('sealChunk closes only the sealed chunk’s handles, leaving another open chunk’s buffer intact', () => {
    const root = mkRoot();
    const s = createBatchedFsChunkStorage(root, { highWaterMark: 1 << 30 });
    s.append(GEN, 0, 'log', 'chunk0\n'); // open chunk 0
    s.append(GEN, 1, 'log', 'chunk1\n'); // open chunk 1 (a path NOT under chunk 0)
    s.sealChunk?.(GEN, 0); // flush+close ONLY chunk 0; chunk 1 must stay buffered
    expect(rawLines(diskPath(root, 'log'))).toEqual(['chunk0']); // chunk 0 flushed
    expect(rawLines(join(root, '0000000000001', '000000000001', 'log'))).toEqual([]); // chunk 1 still buffered
    s.dispose?.();
    expect(rawLines(join(root, '0000000000001', '000000000001', 'log'))).toEqual(['chunk1']); // flushed on dispose
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
