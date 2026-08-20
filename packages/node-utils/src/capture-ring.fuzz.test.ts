import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocCaptureRing, RingConsumer, RingProducer, SKIP_PATH_ID } from './capture-ring';

/**
 * Property-based tests for the shared-memory capture ring.
 *
 * This is the byte path between the main thread and the I/O worker on the server write path: capture
 * frames are encoded IN PLACE into a SharedArrayBuffer and `writev`'d to disk from the same memory,
 * never copied. Everything that makes it fast also makes it easy to get subtly wrong — wrap padding,
 * drop-oldest reclamation, monotonic BigInt indices, and a read cursor that stops the producer
 * clobbering a frame mid-syscall.
 *
 * Its own comments record what a mistake here costs: one earlier version parsed whatever bytes happened
 * to sit at HEAD when a frame was unplaceable and CAS-advanced past a bogus length — 3299 phantom drops
 * on a ring holding nothing.
 *
 * The properties below deliberately do NOT re-implement the capacity arithmetic. Modelling it would just
 * duplicate whatever the ring does, bugs included. They assert what a caller actually depends on:
 * nothing is corrupted, nothing is reordered, nothing is duplicated, and nothing vanishes unaccounted.
 */

/** Drive both sides single-threaded — the ring is SPSC, so a deterministic interleaving is faithful. */
const ring = (capacity: number) => {
  const { data, control } = allocCaptureRing(capacity);
  return { producer: new RingProducer(data, control), consumer: new RingConsumer(data, control) };
};

/** A payload that identifies itself: first 4 bytes are the sequence number, the rest is derived from it. */
const payloadFor = (seq: number, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(0, seq, true);
  for (let i = 4; i < length; i += 1) {
    bytes[i] = (seq + i) % 256;
  }
  return bytes;
};

const seqOf = (payload: Uint8Array): number =>
  new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);

const write = (producer: RingProducer, pathId: number, payload: Uint8Array): boolean => {
  const slot = producer.reserve(payload.length);
  if (slot === null) {
    return false; // unplaceable — the caller side-channels; not a drop
  }
  slot.set(payload);
  producer.commit(pathId, payload.length);
  return true;
};

describe('CaptureRing (fuzz)', () => {
  /**
   * The integrity claim, over arbitrary interleavings of writes and reads.
   *
   * Every frame that comes out was written in, byte for byte, with its own pathId; sequence numbers
   * strictly increase (so nothing is reordered or delivered twice); and the ring never hands back the
   * SKIP marker it uses internally for wrap padding.
   */
  it('returns written frames intact, in order, never duplicated', () => {
    type Op = { kind: 'write'; size: number; pathId: number } | { kind: 'read' };
    const op: fc.Arbitrary<Op> = fc.oneof(
      {
        weight: 3,
        arbitrary: fc
          .tuple(fc.integer({ min: 4, max: 200 }), fc.integer({ min: 0, max: 5 }))
          .map(([size, pathId]) => ({ kind: 'write' as const, size, pathId })),
      },
      { weight: 2, arbitrary: fc.constant({ kind: 'read' as const }) },
    );
    fc.assert(
      fc.property(
        // Capacities small enough that wrapping and drop-oldest happen constantly, which is the point.
        fc.integer({ min: 256, max: 4096 }),
        fc.array(op, { minLength: 40, maxLength: 200 }),
        (capacity, ops) => {
          const { producer, consumer } = ring(capacity);
          const written = new Map<number, { pathId: number; payload: Uint8Array }>();
          let nextSeq = 1;
          let lastSeenSeq = 0;

          for (const o of ops) {
            if (o.kind === 'write') {
              const payload = payloadFor(nextSeq, o.size);
              if (write(producer, o.pathId, payload)) {
                written.set(nextSeq, { pathId: o.pathId, payload });
                nextSeq += 1;
              }
              continue;
            }
            const frame = consumer.peek();
            if (frame === null) {
              continue;
            }
            expect(frame.pathId, 'the SKIP wrap marker escaped to the consumer').not.toBe(
              SKIP_PATH_ID,
            );
            const seq = seqOf(frame.payload);
            const original = written.get(seq);
            expect(original, `frame ${seq} was never written`).toBeDefined();
            expect(frame.pathId, `frame ${seq} came back under the wrong pathId`).toBe(
              original?.pathId,
            );
            expect([...frame.payload], `frame ${seq} came back corrupted`).toEqual([
              ...(original as { payload: Uint8Array }).payload,
            ]);
            expect(seq, 'a frame was delivered out of order or twice').toBeGreaterThan(lastSeenSeq);
            lastSeenSeq = seq;
            consumer.consume();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * CONSERVATION: every frame the producer accepted is either delivered or counted as dropped.
   *
   * This is the invariant that makes the drop counter trustworthy as load-shedding telemetry. The
   * historical bug inflated it with phantom drops on an empty ring, which is exactly the failure this
   * catches — `dropped` climbing while nothing was ever lost.
   */
  it('accounts for every accepted frame — delivered plus dropped, nothing invented', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 256, max: 2048 }),
        fc.array(fc.integer({ min: 4, max: 300 }), { minLength: 20, maxLength: 120 }),
        (capacity, sizes) => {
          const { producer, consumer } = ring(capacity);
          let accepted = 0;
          for (const [i, size] of sizes.entries()) {
            if (write(producer, i % 4, payloadFor(i + 1, size))) {
              accepted += 1;
            }
          }
          let delivered = 0;
          for (;;) {
            const frame = consumer.peek();
            if (frame === null) {
              break;
            }
            delivered += 1;
            consumer.consume();
          }
          expect(delivered + producer.dropped, 'frames vanished or were invented').toBe(accepted);
        },
      ),
      { numRuns: 300 },
    );
  });

  // A ring that never drops when it does not need to: writes that comfortably fit are all delivered.
  it('drops nothing while everything fits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4096, max: 16_384 }),
        fc.array(fc.integer({ min: 4, max: 64 }), { minLength: 1, maxLength: 20 }),
        (capacity, sizes) => {
          const { producer, consumer } = ring(capacity);
          for (const [i, size] of sizes.entries()) {
            expect(write(producer, 1, payloadFor(i + 1, size))).toBe(true);
          }
          const seen: number[] = [];
          for (;;) {
            const frame = consumer.peek();
            if (frame === null) {
              break;
            }
            seen.push(seqOf(frame.payload));
            consumer.consume();
          }
          expect(producer.dropped).toBe(0);
          expect(seen).toEqual(sizes.map((_s, i) => i + 1));
        },
      ),
      { numRuns: 300 },
    );
  });

  // A frame larger than the ring can never be placed — and that is NOT a drop: the caller side-channels
  // it, so counting it would make the load-shedding telemetry lie in the other direction.
  it('refuses an oversized frame without counting it as dropped', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 256, max: 2048 }),
        fc.integer({ min: 1, max: 500 }),
        (capacity, over) => {
          const { producer } = ring(capacity);
          expect(producer.reserve(capacity + over)).toBeNull();
          expect(producer.dropped).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Nothing is readable from a ring nothing was written to — the empty case that the historical bug
  // turned into thousands of phantom drops.
  it('reads nothing, and drops nothing, from an untouched ring', () => {
    fc.assert(
      fc.property(fc.integer({ min: 64, max: 8192 }), (capacity) => {
        const { producer, consumer } = ring(capacity);
        expect(consumer.peek()).toBeNull();
        expect(producer.dropped).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
