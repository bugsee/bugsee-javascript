import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileChunkBackend } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocCaptureRing, RingProducer } from './capture-ring';
import { encodePathId } from './capture-ring-drainer';
import { createCaptureRingWriter, type RingWorkerArgs } from './capture-ring-writer';
import { createFsChunkStorage } from './fs-chunk-storage';
import { createWorkerThreadRingWorker } from './worker-ring-worker';

const GEN = 1;
const FILE_TYPES = ['log', 'network'];
const dirs: string[] = [];
const mkRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-wt-ring-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const diskPath = (root: string, chunk: number, file: string): string =>
  join(root, '0000000000001', `00000000000${chunk}`, file);

describe('createWorkerThreadRingWorker (real worker_threads)', () => {
  it('drains the shared ring to disk OFF the host thread (flush-and-ack handshake)', () => {
    const root = mkRoot();
    const { data, control } = allocCaptureRing(64 * 1024);
    const flags = new SharedArrayBuffer(16);
    const onError = vi.fn();
    const args: RingWorkerArgs = {
      data,
      control,
      flags,
      captureDir: root,
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError,
    };
    const worker = createWorkerThreadRingWorker(args);
    const p = new RingProducer(data, control);
    const enc = new TextEncoder();
    const put = (chunk: number, ti: number, s: string): void => {
      const b = enc.encode(s);
      const v = p.reserve(b.length) as Uint8Array;
      v.set(b);
      p.commit(encodePathId(chunk, ti), b.length);
    };
    put(0, 0, 'L1\n'); // log
    put(0, 1, 'N1\n'); // network
    put(0, 0, 'L2\n'); // log
    worker.flushAndWait(3000); // BLOCKS until the real worker drained everything (real Atomics handshake)
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('L1\nL2\n'); // off-thread writes landed, ordered
    expect(readFileSync(diskPath(root, 0, 'network'), 'utf8')).toBe('N1\n');
    worker.closeChunk(0);
    worker.stop(); // shutdown handshake + bounded terminate
    expect(onError).not.toHaveBeenCalled();
  });

  it('works end-to-end as the CaptureRingWriter’s workerFactory (off-thread ChunkStorage)', () => {
    const root = mkRoot();
    const s = createCaptureRingWriter(root, {
      generation: GEN,
      fileTypes: FILE_TYPES,
      workerFactory: createWorkerThreadRingWorker,
    });
    s.append(GEN, 0, 'log', '7\thi\n');
    s.append(GEN, 1, 'network', '8\treq\n');
    s.flushSync?.(); // real off-thread flush-and-ack
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('7\thi\n');
    expect(readFileSync(diskPath(root, 1, 'network'), 'utf8')).toBe('8\treq\n');
    expect(s.read(GEN, 0, 'log')).toBe('7\thi\n'); // read flushes first
    s.dispose?.();
  });

  it('drop-storm: a real worker drains while the producer drop-oldests — every survivor on disk is INTACT', async () => {
    // Stress the cross-thread drop-oldest + read-cursor protection (C1/C2): a small ring forces constant
    // drops while the worker is concurrently mid-writev. Each frame self-describes its id twice; a torn read
    // (the producer overwriting a frame the worker is reading) would corrupt a line. With the claim-verify +
    // CAS fix, every line that lands is intact.
    const root = mkRoot();
    const { data, control } = allocCaptureRing(2048); // tiny → heavy drop-oldest
    const flags = new SharedArrayBuffer(16);
    const onError = vi.fn();
    const worker = createWorkerThreadRingWorker({
      data,
      control,
      flags,
      captureDir: root,
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError,
    });
    const p = new RingProducer(data, control);
    const enc = new TextEncoder();
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const N = 4000;
    for (let id = 1; id <= N; id++) {
      const s = `${id}:${String(id).padStart(10, '0')}\n`; // id, colon, the SAME id padded → self-check
      const b = enc.encode(s);
      const v = p.reserve(b.length);
      if (v === null) continue; // transiently undroppable (consumer mid-read) — skip
      v.set(b);
      p.commit(encodePathId(0, 0), b.length);
      if (id % 200 === 0) await sleep(1); // let the worker drain concurrently (maximize the race window)
    }
    worker.flushAndWait(3000); // drain the residual
    worker.stop();

    const text = readFileSync(diskPath(root, 0, 'log'), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(50); // a meaningful number of survivors landed
    expect(p.dropped).toBeGreaterThan(0); // and the drop path was genuinely exercised
    for (const line of lines) {
      const m = /^(\d+):(\d+)$/.exec(line);
      expect(m, `corrupt/torn line: ${JSON.stringify(line)}`).not.toBeNull(); // well-formed
      expect(Number((m as RegExpExecArray)[1])).toBe(Number((m as RegExpExecArray)[2])); // both ids agree → intact
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it('B1: off-thread-written capture is RECOVERABLE by the plain fs reader (worker → crash → recover)', async () => {
    // The headline off-thread guarantee: a process that captured via captureWriter:'worker' and then died
    // is recovered on the NEXT launch by the plain fs reader. Prove the off-thread on-disk format is byte-
    // compatible with the recovery reader (it was previously only ASSUMED — recovery is otherwise tested
    // exclusively against the batched/fs writer's output).
    const root = mkRoot();
    const writer = createCaptureRingWriter(root, {
      generation: GEN,
      fileTypes: FILE_TYPES,
      workerFactory: createWorkerThreadRingWorker,
    });
    const backend = createFileChunkBackend(writer, {
      generation: GEN,
      cleanOtherGenerations: false,
    });
    backend.openPart({ generation: GEN, number: 0 }, GEN);
    backend.appendEntry(
      { generation: GEN, number: 0 },
      { type: 'log', timestamp: 1, serialized: JSON.stringify({ timestamp: 1, data: 'crash-bc' }) },
    );
    backend.appendEntry(
      { generation: GEN, number: 0 },
      {
        type: 'network',
        timestamp: 2,
        serialized: JSON.stringify({ timestamp: 2, data: { url: 'u' } }),
      },
    );
    backend.closePart({ generation: GEN, number: 0 }, GEN + 1, 0); // seal → off-thread flush-and-ack to disk
    writer.dispose?.(); // the process ends; the I/O worker stops

    // NEXT launch: a FRESH plain fs reader (exactly what recovery uses) reads the off-thread-written chunks.
    const recovery = createFileChunkBackend(createFsChunkStorage(root), {
      generation: GEN,
      cleanOtherGenerations: false,
    });
    const parts = await recovery.listParts(GEN);
    const snap = recovery.snapshot(
      parts.map((pt) => ({
        ref: { generation: GEN, number: pt.number },
        count: Number.MAX_SAFE_INTEGER,
      })),
    );
    const records = await snap.drainAll();
    snap.release();
    expect(JSON.parse((records.get('log') ?? [])[0]?.serialized ?? '{}').data).toBe('crash-bc');
    expect(JSON.parse((records.get('network') ?? [])[0]?.serialized ?? '{}').data).toEqual({
      url: 'u',
    });
  });

  it('B2: closeChunk with frames still PENDING in the ring does not lose them (the worker reopens)', () => {
    const root = mkRoot();
    const { data, control } = allocCaptureRing(64 * 1024);
    const flags = new SharedArrayBuffer(16);
    const onError = vi.fn();
    const worker = createWorkerThreadRingWorker({
      data,
      control,
      flags,
      captureDir: root,
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError,
    });
    const p = new RingProducer(data, control);
    const enc = new TextEncoder();
    const put = (s: string): void => {
      const b = enc.encode(s);
      const v = p.reserve(b.length) as Uint8Array;
      v.set(b);
      p.commit(encodePathId(0, 0), b.length);
    };
    put('A\n');
    put('B\n');
    worker.closeChunk(0); // close BEFORE draining — frames are (very likely) still in the ring
    put('C\n'); // and keep producing into the just-closed chunk
    worker.flushAndWait(3000); // the worker reopens the fd and drains everything — nothing lost
    worker.stop();
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('A\nB\nC\n'); // all three survived, in order
    expect(onError).not.toHaveBeenCalled();
  });

  it('B2: a frame committed after the last flush is persisted by stop() (the shutdown final-drain)', () => {
    const root = mkRoot();
    const { data, control } = allocCaptureRing(8192);
    const flags = new SharedArrayBuffer(16);
    const onError = vi.fn();
    const worker = createWorkerThreadRingWorker({
      data,
      control,
      flags,
      captureDir: root,
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError,
    });
    const p = new RingProducer(data, control);
    const enc = new TextEncoder();
    const b = enc.encode('LAST\n');
    const v = p.reserve(b.length) as Uint8Array;
    v.set(b);
    p.commit(encodePathId(0, 0), b.length);
    worker.stop(); // NO prior flush — stop()'s shutdown drain must still persist the committed frame
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('LAST\n');
    expect(onError).not.toHaveBeenCalled();
  });

  it('B3: maxDataSize-style eviction over the real off-thread worker (removeChunk drains+closes+deletes)', () => {
    const root = mkRoot();
    const s = createCaptureRingWriter(root, {
      generation: GEN,
      fileTypes: FILE_TYPES,
      workerFactory: createWorkerThreadRingWorker,
    });
    s.append(GEN, 0, 'log', 'old\n');
    s.flushSync?.();
    expect(existsSync(diskPath(root, 0, 'log'))).toBe(true);
    s.removeChunk(GEN, 0); // drain + worker.closeChunk + delete — exercised against the REAL worker
    expect(existsSync(diskPath(root, 0, 'log'))).toBe(false); // the evicted chunk is gone
    s.append(GEN, 1, 'log', 'new\n'); // the writer + worker keep working after an eviction
    s.flushSync?.();
    expect(readFileSync(diskPath(root, 1, 'log'), 'utf8')).toBe('new\n');
    s.dispose?.();
  });

  it('A1: the worker creates files 0600 + dirs 0700 (no group/other access)', () => {
    const root = mkRoot();
    const { data, control } = allocCaptureRing(8192);
    const flags = new SharedArrayBuffer(16);
    const worker = createWorkerThreadRingWorker({
      data,
      control,
      flags,
      captureDir: root,
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError: vi.fn(),
    });
    const p = new RingProducer(data, control);
    const enc = new TextEncoder();
    const b = enc.encode('M\n');
    const v = p.reserve(b.length) as Uint8Array;
    v.set(b);
    p.commit(encodePathId(0, 0), b.length);
    worker.flushAndWait(3000);
    worker.stop();
    const file = diskPath(root, 0, 'log');
    expect(statSync(file).mode & 0o077).toBe(0); // data file: no group/other access
    expect(statSync(join(file, '..')).mode & 0o077).toBe(0); // chunk dir: no group/other access
  });

  it('main-side handshake edges with a fake Worker: flush timeout, control messages, error routing', () => {
    const { data, control } = allocCaptureRing(1024);
    const flags = new SharedArrayBuffer(16);
    const onError = vi.fn();
    const messages: object[] = [];
    let errorHandler: ((e: unknown) => void) | undefined;
    const fake = {
      on: (event: string, cb: (e: unknown) => void) => {
        if (event === 'error') errorHandler = cb;
      },
      postMessage: (m: object) => messages.push(m),
      terminate: () => Promise.resolve(0),
      unref: () => {},
    };
    const args: RingWorkerArgs = {
      data,
      control,
      flags,
      captureDir: '/tmp/never',
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError,
    };
    const worker = createWorkerThreadRingWorker(args, function FakeCtor() {
      return fake;
    } as unknown as Parameters<typeof createWorkerThreadRingWorker>[1]);
    // No real worker thread acks → flushAndWait blocks for the budget then TIMES OUT (never hangs the host).
    const t0 = Date.now();
    worker.flushAndWait(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
    // control messages are posted to the worker
    worker.closeChunk(5);
    worker.closeAll();
    expect(messages).toEqual([{ close: 5 }, { closeAll: true }]);
    // a worker 'error' is routed to onError
    errorHandler?.(new Error('worker crashed'));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('degrades to the synchronous worker when spawning a worker_threads Worker throws', () => {
    const root = mkRoot();
    const { data, control } = allocCaptureRing(4096);
    const flags = new SharedArrayBuffer(16);
    const args: RingWorkerArgs = {
      data,
      control,
      flags,
      captureDir: root,
      generation: GEN,
      fileTypes: FILE_TYPES,
      onError: vi.fn(),
    };
    const throwingCtor = ((): never => {
      throw new Error('no worker_threads');
    }) as unknown as Parameters<typeof createWorkerThreadRingWorker>[1];
    const worker = createWorkerThreadRingWorker(args, throwingCtor); // → sync fallback
    const p = new RingProducer(data, control);
    const enc = new TextEncoder();
    const b = enc.encode('S\n');
    const v = p.reserve(b.length) as Uint8Array;
    v.set(b);
    p.commit(encodePathId(0, 0), b.length);
    worker.flushAndWait(1000); // the sync fallback drains on the main thread
    expect(readFileSync(diskPath(root, 0, 'log'), 'utf8')).toBe('S\n');
    worker.stop();
    expect(existsSync(diskPath(root, 0, 'log'))).toBe(true);
  });
});
