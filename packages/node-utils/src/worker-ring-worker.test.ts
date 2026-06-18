import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocCaptureRing, RingProducer } from './capture-ring';
import { encodePathId } from './capture-ring-drainer';
import { createCaptureRingWriter, type RingWorkerArgs } from './capture-ring-writer';
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
