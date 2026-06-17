import type { RingConsumer } from './capture-ring';

// RingDrainer — the worker-side core of the Phase-2 write path (design D6). It drains the shared CaptureRing
// (peek → writev → consume) to per-file fds the WORKER owns (deno can't inherit the main's fds, so the worker
// opens them itself), demuxing by `pathId`. Kept PURE over injected fs ops so it is fully unit-testable; the
// thin worker_threads glue (the real openSync-by-derived-path / writevSync / closeSync + the Atomics loop)
// wraps it and is validated by the adverse-I/O e2e (the ANR-worker precedent).
//
// `pathId` self-describes the file as (chunk, typeIndex) — packed so the worker reconstructs the path from
// startup constants (captureDir + generation) WITHOUT a separate register channel (which would race the ring).

const TYPE_BASE = 256; // pathId = chunk * 256 + typeIndex (typeIndex < 256; ≤ 256 file types)

/** Pack a (chunk, file-type index) into the ring frame's `pathId`. */
export function encodePathId(chunk: number, typeIndex: number): number {
  return chunk * TYPE_BASE + typeIndex;
}

/** The chunk a `pathId` belongs to (for closeChunk / sealing). */
export function chunkOfPathId(pathId: number): number {
  return Math.floor(pathId / TYPE_BASE);
}

/** The file-type index a `pathId` carries. */
export function typeIndexOfPathId(pathId: number): number {
  return pathId % TYPE_BASE;
}

/** The fs operations the drainer needs — injected so the core logic is testable without real files/threads. */
export interface DrainerOps {
  /** Open (and return an fd for) the file a `pathId` names. Called once per pathId; the result is cached. */
  openFor(pathId: number): number;
  /** Vectored write; returns the bytes actually written (may be short). */
  writev(fd: number, iov: readonly Uint8Array[]): number;
  /** Close an fd. */
  close(fd: number): void;
  /** Failure sink (a write/close error must never throw out of the worker). */
  onError(error: unknown): void;
}

/** Write the whole of `buf` to `fd`, honoring writev's short-write contract (loop on the return value). */
function writevAll(fd: number, buf: Uint8Array, writev: DrainerOps['writev']): void {
  let off = 0;
  while (off < buf.length) {
    const n = writev(fd, [buf.subarray(off)]);
    if (n <= 0) {
      throw new Error(`writev made no progress (returned ${n})`);
    }
    off += n;
  }
}

export class RingDrainer {
  readonly #consumer: RingConsumer;
  readonly #ops: DrainerOps;
  readonly #fds = new Map<number, number>(); // pathId → fd, opened lazily on first write and held

  constructor(consumer: RingConsumer, ops: DrainerOps) {
    this.#consumer = consumer;
    this.#ops = ops;
  }

  #fdFor(pathId: number): number {
    let fd = this.#fds.get(pathId);
    if (fd === undefined) {
      fd = this.#ops.openFor(pathId);
      this.#fds.set(pathId, fd);
    }
    return fd;
  }

  /**
   * Drain every currently-committed frame to its file. On a write error, route it to onError and STOP this
   * pass WITHOUT consuming the frame — so a transient error retries next pass (no loss) and a persistent one
   * lets the ring fill and shed via drop-oldest, never spinning or blocking.
   */
  drain(): void {
    for (;;) {
      const frame = this.#consumer.peek();
      if (frame === null) {
        return;
      }
      try {
        writevAll(this.#fdFor(frame.pathId), frame.payload, this.#ops.writev);
      } catch (error) {
        this.#ops.onError(error);
        return; // leave the frame in the ring for the next pass
      }
      this.#consumer.consume(); // only after the bytes are durably on the fd
    }
  }

  /** Close + forget the fd for one file (a sealed/removed part). */
  closePathId(pathId: number): void {
    this.#closeOne(pathId);
  }

  /** Close + forget every fd belonging to `chunk` (sealChunk / removeChunk). */
  closeChunk(chunk: number): void {
    for (const pathId of [...this.#fds.keys()]) {
      if (chunkOfPathId(pathId) === chunk) {
        this.#closeOne(pathId);
      }
    }
  }

  /** Close + forget every open fd (dispose / shutdown). */
  closeAll(): void {
    for (const pathId of [...this.#fds.keys()]) {
      this.#closeOne(pathId);
    }
  }

  #closeOne(pathId: number): void {
    const fd = this.#fds.get(pathId);
    if (fd === undefined) {
      return;
    }
    this.#fds.delete(pathId);
    try {
      this.#ops.close(fd);
    } catch (error) {
      this.#ops.onError(error);
    }
  }
}
