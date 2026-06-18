// CaptureRing — the shared, fixed, reused SAB byte-ring at the heart of the Phase-2 off-thread write path
// (design: docs/design/server-disk-capture-write-path.md, D7). A single PRODUCER (the main thread) encodes
// capture frames IN PLACE into the ring (zero-copy, zero-alloc — `encodeInto` writes straight into the SAB)
// and a single CONSUMER (the I/O worker) reads them in place and `writevSync`s them to disk. Nothing is ever
// copied between threads: the SAB is shared memory, the frame bytes live there from encode to syscall.
//
// Frame layout (little-endian): [pathId: u32][payloadLen: u32][payload: payloadLen bytes]. `pathId` demuxes
// to the worker's per-file fd. `SKIP_PATH_ID` is a wrap-pad marker the consumer follows to the ring start so
// frames are always physically CONTIGUOUS (one `writev` iovec each, `encodeInto` works directly).
//
// Indices are MONOTONIC byte counters (BigInt64, no 32-bit overflow over a long run); the physical offset is
// `pos % capacity`. Control words (BigInt64, in a second SAB): [HEAD, TAIL, DROPPED, READING].
//   HEAD    — oldest valid byte; advanced by the consumer (consume) AND the producer (drop-oldest).
//   TAIL    — next write byte; producer-owned.
//   DROPPED — cumulative dropped-record count (load-shedding telemetry).
//   READING — the offset of the frame the consumer is mid-read on, or -1; the producer's drop-oldest never
//             reclaims past it, so a frame being `writev`'d is never clobbered (the read-cursor protection).
// Single-producer / single-consumer: the only contended word is HEAD; both only ever advance it forward.

const HEADER = 8; // u32 pathId + u32 payloadLen
const HEAD = 0;
const TAIL = 1;
const DROPPED = 2;
const READING = 3;
const NO_READ = -1n;

/** A reserved pathId that marks wrap padding (never a real path). */
export const SKIP_PATH_ID = 0xffffffff;

/** Allocate the two SABs backing a ring of `capacity` data bytes (+ the BigInt64 control block). */
export function allocCaptureRing(capacity: number): {
  data: SharedArrayBuffer;
  control: SharedArrayBuffer;
} {
  const control = new SharedArrayBuffer(4 * 8); // 4 × BigInt64
  // The SAB is zero-initialized, but READING's "no active read" sentinel is -1 (0 is a valid head offset);
  // set it so the producer doesn't mistake a fresh ring for "the consumer is mid-read on offset 0".
  new BigInt64Array(control)[READING] = NO_READ;
  return { data: new SharedArrayBuffer(capacity), control };
}

/** Shared addressing over the data + control SABs (the producer and consumer each extend this). */
class RingBase {
  protected readonly cap: number;
  protected readonly capBig: bigint;
  protected readonly bytes: Uint8Array;
  protected readonly view: DataView;
  protected readonly ctl: BigInt64Array;

  constructor(data: SharedArrayBuffer, control: SharedArrayBuffer) {
    this.cap = data.byteLength;
    this.capBig = BigInt(this.cap);
    this.bytes = new Uint8Array(data);
    this.view = new DataView(data);
    this.ctl = new BigInt64Array(control);
  }

  protected phys(pos: bigint): number {
    return Number(pos % this.capBig);
  }

  /** The byte size of the frame at `pos` — a record (HEADER + payloadLen), a SKIP pad, or the trailing
   * <HEADER bytes that can't hold a header (an implicit wrap): all advance to the next ring boundary. */
  protected frameSizeAt(pos: bigint): number {
    const p = this.phys(pos);
    const toEnd = this.cap - p;
    if (toEnd < HEADER) {
      return toEnd; // can't hold a header here → the rest of this lap is padding
    }
    const pathId = this.view.getUint32(p, true);
    if (pathId === SKIP_PATH_ID) {
      return toEnd; // explicit wrap marker → skip to the boundary
    }
    return HEADER + this.view.getUint32(p + 4, true);
  }
}

/** The single producer (main thread): reserve → encode-in-place → commit. */
export class RingProducer extends RingBase {
  #pendingHeader = 0; // physical offset of the reserved frame header (between reserve and commit)
  #pendingTail = 0n; // the TAIL value the reserved frame starts at

  /** Cumulative count of records dropped (ring full + load-shed). */
  get dropped(): number {
    return Number(Atomics.load(this.ctl, DROPPED));
  }

  /**
   * Reserve room for a frame whose payload is at most `maxPayload` bytes, DROPPING the oldest committed
   * frames as needed to make room (bumping `dropped`), then return the payload subarray to `encodeInto`.
   * Returns null when the frame can't be placed: either it is OVERSIZED (HEADER + maxPayload > capacity —
   * the caller side-channels it) OR the ring is transiently full AND the only droppable-oldest frame is one
   * the consumer is mid-read on (counted as a drop). The caller distinguishes via `HEADER + maxPayload > cap`.
   */
  reserve(maxPayload: number): Uint8Array | null {
    const need = HEADER + maxPayload;
    if (need > this.cap) {
      return null; // oversized — can never fit; NOT counted as a drop (caller side-channels)
    }
    for (;;) {
      const tail = Atomics.load(this.ctl, TAIL);
      const head = Atomics.load(this.ctl, HEAD);
      const physTail = this.phys(tail);
      const toEnd = this.cap - physTail;
      const pad = toEnd < need ? toEnd : 0; // pad to the boundary when the frame would straddle the end
      const free = this.cap - Number(tail - head);
      if (free >= pad + need) {
        if (pad > 0) {
          if (pad >= HEADER) {
            this.view.setUint32(physTail, SKIP_PATH_ID, true); // a SKIP marker the consumer follows
          }
          const base = tail + BigInt(pad);
          Atomics.store(this.ctl, TAIL, base);
          this.#pendingTail = base;
          this.#pendingHeader = this.phys(base); // 0 — base is a ring boundary
        } else {
          this.#pendingTail = tail;
          this.#pendingHeader = physTail;
        }
        const h = this.#pendingHeader;
        return this.bytes.subarray(h + HEADER, h + HEADER + maxPayload);
      }
      // Not enough free → drop the oldest committed frame, unless the consumer is mid-read on it.
      const reading = Atomics.load(this.ctl, READING);
      if (reading >= 0n && head === reading) {
        Atomics.add(this.ctl, DROPPED, 1n); // can't reclaim the in-flight read → drop THIS record instead
        return null;
      }
      const physHead = this.phys(head);
      const isPad =
        this.cap - physHead < HEADER || this.view.getUint32(physHead, true) === SKIP_PATH_ID;
      // Advance HEAD past the oldest frame via CAS so a concurrent consumer advance (consume / pad-skip) is
      // never clobbered and HEAD only ever moves forward. If the consumer won the race, retry from the new HEAD.
      const next = head + BigInt(this.frameSizeAt(head));
      if (Atomics.compareExchange(this.ctl, HEAD, head, next) === head && !isPad) {
        Atomics.add(this.ctl, DROPPED, 1n); // a real record was discarded (pad skips don't count)
      }
    }
  }

  /** Commit the reservation as a frame for `pathId` with the actual encoded payload length. */
  commit(pathId: number, payloadLen: number): void {
    const h = this.#pendingHeader;
    this.view.setUint32(h, pathId, true);
    this.view.setUint32(h + 4, payloadLen, true);
    Atomics.store(this.ctl, TAIL, this.#pendingTail + BigInt(HEADER + payloadLen));
  }
}

/** The single consumer (I/O worker): peek → writev → consume. */
export class RingConsumer extends RingBase {
  #peekedSize = 0; // the byte size of the frame the last peek returned (so consume never re-reads ring bytes)

  /**
   * Return the next committed frame at HEAD WITHOUT consuming it — `{ pathId, payload }`, where `payload` is
   * a subarray INTO the ring (zero-copy; `writev` it before `consume`). Skips wrap-pads. Null when empty.
   *
   * CLAIM-then-VERIFY: it publishes the READING protection BEFORE trusting the frame bytes, then re-checks
   * HEAD — so the producer's drop-oldest can never overwrite a frame between our HEAD observation and our
   * read of its header/payload (a torn read of the shared region). If the producer dropped it under us
   * (HEAD moved), we retry from the new HEAD. Pad/wrap skips advance HEAD via CAS (never clobber a drop).
   */
  peek(): { pathId: number; payload: Uint8Array } | null {
    for (;;) {
      const head = Atomics.load(this.ctl, HEAD);
      const tail = Atomics.load(this.ctl, TAIL);
      if (head >= tail) {
        Atomics.store(this.ctl, READING, NO_READ);
        return null; // empty
      }
      const physHead = this.phys(head);
      if (this.cap - physHead < HEADER || this.view.getUint32(physHead, true) === SKIP_PATH_ID) {
        // wrap pad (explicit marker or <HEADER trailing) → advance via CAS, then re-read HEAD next pass
        Atomics.compareExchange(this.ctl, HEAD, head, head + BigInt(this.frameSizeAt(head)));
        continue;
      }
      Atomics.store(this.ctl, READING, head); // CLAIM: protect from drop-oldest
      if (Atomics.load(this.ctl, HEAD) !== head) {
        /* v8 ignore next -- concurrency-only: the producer dropping between CLAIM and VERIFY needs a 2nd
           thread (unreachable single-threaded); validated by the real-worker drop-storm integration test */
        continue; // VERIFY failed — the producer dropped this frame before we claimed it; retry from new HEAD
      }
      const pathId = this.view.getUint32(physHead, true);
      const len = this.view.getUint32(physHead + 4, true);
      this.#peekedSize = HEADER + len; // cache so consume() advances HEAD without re-reading the (mutable) ring
      return { pathId, payload: this.bytes.subarray(physHead + HEADER, physHead + HEADER + len) };
    }
  }

  /** Consume the frame returned by the last `peek` (advance HEAD past it; clear the read cursor). The frame
   * stays READING-protected through here, so its size is stable — but use the cached size, never a re-read. */
  consume(): void {
    const head = Atomics.load(this.ctl, READING);
    if (head < 0n) {
      return; // nothing peeked
    }
    Atomics.store(this.ctl, HEAD, head + BigInt(this.#peekedSize));
    Atomics.store(this.ctl, READING, NO_READ);
  }
}
