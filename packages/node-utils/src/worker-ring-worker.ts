import { Worker } from 'node:worker_threads';
import { createSyncRingWorker, type RingWorker, type RingWorkerArgs } from './capture-ring-writer';

// The off-thread RingWorker (design D6): a worker_threads worker that drains the shared CaptureRing to disk,
// so the host thread NEVER blocks on a write(). It swaps into the CaptureRingWriter's `workerFactory` seam.
//
// The worker body is an INLINE eval STRING (it must run without a build step — the monorepo consumes TS
// source, and a worker can't load our .ts). It faithfully mirrors the unit-tested RingConsumer.peek/consume
// + RingDrainer.drain (same frame + control layout); that pure logic is the spec, and this glue is validated
// end-to-end by the adverse-I/O e2e + a real-worker integration test (the ANR-worker precedent). The MAIN
// side here (spawn + the Atomics flush-and-ack/shutdown handshake) IS exercised by the real-worker test.

// `flags` Int32 layout (shared main↔worker): [SIGNAL(unused/reserved), FLUSH_REQ, FLUSH_ACK, SHUTDOWN].
const FLUSH_REQ = 1;
const FLUSH_ACK = 2;
const SHUTDOWN = 3;
const WORKER_DRAIN_INTERVAL_MS = 4; // the worker's routine drain cadence (also the flush-ack latency ceiling)
const TERMINATE_BUDGET_MS = 1000; // bun's terminate() can hang on an idle worker → never block shutdown on it

// A setInterval-driven drain loop (NOT a blocking Atomics.wait loop — that would starve the worker's event
// loop and never deliver the close/closeAll control messages). Mirrors RingConsumer/RingDrainer exactly.
const RING_IO_WORKER = `
const start = (wt, fs) => {
  const { data, control, flags, captureDir, generation, fileTypes } = wt.workerData;
  const cap = data.byteLength, capBig = BigInt(cap);
  const bytes = new Uint8Array(data), view = new DataView(data);
  const ctl = new BigInt64Array(control), fl = new Int32Array(flags);
  const HEAD=0, TAIL=1, READING=3, FREQ=1, FACK=2, SHUT=3, HEADER=8, SKIP=0xffffffff, NO_READ=-1n;
  const genDir = captureDir + '/' + String(generation).padStart(13,'0');
  const fds = new Map();
  const openFor = (pid) => {
    let fd = fds.get(pid);
    if (fd === undefined) {
      const dir = genDir + '/' + String(Math.floor(pid/256)).padStart(12,'0');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(dir + '/' + fileTypes[pid%256], 'a', 0o600);
      fds.set(pid, fd);
    }
    return fd;
  };
  const sizeAt = (pos) => {
    const p = Number(pos % capBig), toEnd = cap - p;
    if (toEnd < HEADER) return toEnd;
    const id = view.getUint32(p, true);
    return id === SKIP ? toEnd : HEADER + view.getUint32(p+4, true);
  };
  const drain = () => {
    for (;;) {
      const head = Atomics.load(ctl, HEAD), tail = Atomics.load(ctl, TAIL);
      if (head >= tail) { Atomics.store(ctl, READING, NO_READ); return; }
      const p = Number(head % capBig);
      if (cap - p < HEADER || view.getUint32(p, true) === SKIP) {
        Atomics.compareExchange(ctl, HEAD, head, head + BigInt(sizeAt(head))); continue; // pad skip (CAS)
      }
      Atomics.store(ctl, READING, head); // CLAIM
      if (Atomics.load(ctl, HEAD) !== head) continue; // VERIFY — dropped under us → retry from new HEAD
      const len = view.getUint32(p+4, true), size = HEADER + len;
      const payload = bytes.subarray(p+HEADER, p+HEADER+len);
      // WAVE 6.7 — a corrupted header decodes to a type index past the end of fileTypes. Unguarded, the
      // filename became the string 'undefined', creating a junk file; and any throw here left the frame in
      // the ring to be retried forever, pinning READING so the producer could never shed. Drop the frame.
      if (fileTypes[view.getUint32(p, true) % 256] === undefined) {
        Atomics.store(ctl, HEAD, Atomics.load(ctl, READING) + BigInt(size));
        Atomics.store(ctl, READING, NO_READ);
        continue;
      }
      try {
        let off = 0;
        while (off < payload.length) {
          const n = fs.writevSync(openFor(view.getUint32(p, true)), [payload.subarray(off)]);
          if (n <= 0) throw new Error('writev no progress');
          off += n;
        }
      } catch (e) { return; } // leave the frame; retry next tick (transient) or shed via drop-oldest
      Atomics.store(ctl, HEAD, Atomics.load(ctl, READING) + BigInt(size)); // cached size, not a re-read
      Atomics.store(ctl, READING, NO_READ);
    }
  };
  const closeChunk = (chunk) => { for (const pid of [...fds.keys()]) if (Math.floor(pid/256)===chunk) { try{fs.closeSync(fds.get(pid));}catch(e){} fds.delete(pid); } };
  const closeAll = () => { for (const pid of [...fds.keys()]) { try{fs.closeSync(fds.get(pid));}catch(e){} fds.delete(pid); } };
  wt.parentPort.on('message', (m) => { if (m && m.close !== undefined) closeChunk(m.close); else if (m && m.closeAll) closeAll(); });
  const timer = setInterval(() => {
    drain();
    const req = Atomics.load(fl, FREQ);
    if (req > Atomics.load(fl, FACK)) { drain(); Atomics.store(fl, FACK, req); Atomics.notify(fl, FACK); }
    if (Atomics.load(fl, SHUT) === 1) {
      clearInterval(timer); drain(); closeAll();
      Atomics.store(fl, FACK, Atomics.load(fl, FREQ)); Atomics.notify(fl, FACK);
    }
  }, ${WORKER_DRAIN_INTERVAL_MS});
};
Promise.resolve(typeof require === 'function' ? require('node:worker_threads') : import('node:worker_threads'))
  .then((wt) => Promise.resolve(typeof require === 'function' ? require('node:fs') : import('node:fs')).then((fs) => start(wt, fs)))
  .catch(() => {});
`;

type WorkerCtor = new (
  script: string,
  options: { eval: true; workerData: object },
) => {
  on(event: string, cb: (arg: unknown) => void): void;
  postMessage(msg: object): void;
  terminate(): Promise<unknown>;
  unref?(): void;
};

/**
 * The off-thread RingWorker — spawns the worker_threads worker over the shared SABs + does the main-side
 * Atomics flush-and-ack / shutdown handshake. If worker_threads is unavailable (or the spawn throws), it
 * DEGRADES to the synchronous main-thread worker (never breaks capture). `WorkerImpl` is injectable for tests.
 */
export function createWorkerThreadRingWorker(
  args: RingWorkerArgs,
  WorkerImpl: WorkerCtor = Worker as unknown as WorkerCtor,
): RingWorker {
  const fl = new Int32Array(args.flags);
  let worker: InstanceType<WorkerCtor>;
  try {
    worker = new WorkerImpl(RING_IO_WORKER, {
      eval: true,
      workerData: {
        data: args.data,
        control: args.control,
        flags: args.flags,
        captureDir: args.captureDir,
        generation: args.generation,
        fileTypes: args.fileTypes,
      },
    });
  } catch {
    return createSyncRingWorker(args); // no worker_threads → graceful on-thread fallback
  }
  worker.on('error', (e) => args.onError(e));
  worker.unref?.(); // never let the I/O worker keep the host process alive

  // Block the host thread until the worker has drained up to OUR request token (bounded). Atomics.wait on the
  // main thread is permitted on node/bun/deno (spike §9.1). Only the rare read/seal/dispose paths call this.
  const flushAndWait = (timeoutMs: number): void => {
    const req = Atomics.add(fl, FLUSH_REQ, 1) + 1;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ack = Atomics.load(fl, FLUSH_ACK);
      if (ack >= req) {
        return; // the worker drained at least up to our request
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return; // timed out — never block the host indefinitely
      }
      Atomics.wait(fl, FLUSH_ACK, ack, remaining);
    }
  };

  return {
    flushAndWait,
    closeChunk: (chunk) => worker.postMessage({ close: chunk }),
    closeAll: () => worker.postMessage({ closeAll: true }),
    stop: () => {
      Atomics.store(fl, SHUTDOWN, 1);
      flushAndWait(TERMINATE_BUDGET_MS); // wait for the worker's final drain + close-all + ack
      // Bounded — bun's terminate() can hang on an idle worker. The fallback timer is UNREF'd so a normal
      // (fast-terminate) stop() never holds the host event loop for the budget.
      let timer: ReturnType<typeof setTimeout>;
      void Promise.race([
        worker.terminate(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TERMINATE_BUDGET_MS);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
    },
  };
}
