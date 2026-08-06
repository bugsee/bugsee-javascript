import { describe, expect, it } from 'vitest';
import { allocCaptureRing, RingConsumer, RingProducer, SKIP_PATH_ID } from './capture-ring';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Push a string frame for `pathId` through the producer (reserve → encodeInto → commit). Returns false if
// the producer could not place it (oversized or transiently-full-undroppable → counted as dropped).
const push = (p: RingProducer, pathId: number, s: string): boolean => {
  const bytes = enc.encode(s);
  const view = p.reserve(bytes.length);
  if (view === null) return false;
  view.set(bytes); // (a real producer uses encodeInto; set() is equivalent for the test)
  p.commit(pathId, bytes.length);
  return true;
};

// Drain every committed frame the consumer can see, as { pathId, text } — peek → record → consume.
const drainAll = (c: RingConsumer): Array<{ pathId: number; text: string }> => {
  const out: Array<{ pathId: number; text: string }> = [];
  for (;;) {
    const f = c.peek();
    if (f === null) break;
    out.push({ pathId: f.pathId, text: dec.decode(f.payload) });
    c.consume();
  }
  return out;
};

const newRing = (capacity: number) => {
  const { data, control } = allocCaptureRing(capacity);
  return { producer: new RingProducer(data, control), consumer: new RingConsumer(data, control) };
};

describe('CaptureRing', () => {
  it('round-trips a single frame (pathId + payload) producer → consumer', () => {
    const { producer, consumer } = newRing(1024);
    expect(push(producer, 7, 'hello')).toBe(true);
    expect(drainAll(consumer)).toEqual([{ pathId: 7, text: 'hello' }]);
  });

  it('preserves order across multiple frames + interleaved pathIds', () => {
    const { producer, consumer } = newRing(1024);
    push(producer, 1, 'a');
    push(producer, 2, 'bb');
    push(producer, 1, 'ccc');
    expect(drainAll(consumer)).toEqual([
      { pathId: 1, text: 'a' },
      { pathId: 2, text: 'bb' },
      { pathId: 1, text: 'ccc' },
    ]);
  });

  it('peek does NOT consume; consume advances exactly one frame', () => {
    const { producer, consumer } = newRing(1024);
    push(producer, 1, 'x');
    push(producer, 2, 'y');
    expect(consumer.peek()?.pathId).toBe(1);
    expect(consumer.peek()?.pathId).toBe(1); // still the same — peek is idempotent
    consumer.consume();
    expect(consumer.peek()?.pathId).toBe(2);
    consumer.consume();
    expect(consumer.peek()).toBeNull(); // drained
  });

  it('an empty ring peeks null', () => {
    const { consumer } = newRing(1024);
    expect(consumer.peek()).toBeNull();
  });

  it('returns null for an OVERSIZED frame that can never fit (payload + header > capacity)', () => {
    const { producer } = newRing(64);
    expect(producer.reserve(64)).toBeNull(); // 8-byte header + 64 > 64 capacity
    expect(producer.dropped).toBe(0); // oversized is the caller's side-channel, NOT counted as a drop
  });

  it('wraps with padding when a frame does not fit contiguously before the ring end (frames stay contiguous)', () => {
    // capacity 64; header 8. Fill most of the ring, drain it (head advances), then push a frame that would
    // straddle the physical end → producer pads to the boundary + writes at offset 0; consumer follows.
    const { producer, consumer } = newRing(64);
    push(producer, 1, 'x'.repeat(20)); // frame = 28 bytes
    expect(drainAll(consumer)).toEqual([{ pathId: 1, text: 'x'.repeat(20) }]); // head now at 28
    push(producer, 2, 'y'.repeat(20)); // frame 28: 28..56 fits
    push(producer, 3, 'z'.repeat(20)); // frame 28: would be 56..84 > 64 → pad 56..64, write at 0
    expect(drainAll(consumer)).toEqual([
      { pathId: 2, text: 'y'.repeat(20) },
      { pathId: 3, text: 'z'.repeat(20) }, // recovered after the wrap-pad
    ]);
  });

  it('DROP-OLDEST: a full ring drops the oldest committed frames to fit a new one, bumping `dropped`', () => {
    const { producer, consumer } = newRing(64); // ~2 × 28-byte frames fit
    push(producer, 1, 'a'.repeat(20)); // frame0 (28B)
    push(producer, 2, 'b'.repeat(20)); // frame1 (28B) → ring ~full (56/64)
    // frame2 needs 28; only 8 free → drop the oldest (frame0), bump dropped, then place frame2.
    push(producer, 3, 'c'.repeat(20));
    expect(producer.dropped).toBe(1);
    const got = drainAll(consumer);
    expect(got.map((f) => f.pathId)).toEqual([2, 3]); // the OLDEST (1) was dropped; recent kept
  });

  it('drop-oldest never reclaims a frame the consumer is mid-read on (read-cursor protection)', () => {
    const { producer, consumer } = newRing(64);
    push(producer, 1, 'a'.repeat(20)); // frame0
    push(producer, 2, 'b'.repeat(20)); // frame1 → ring full
    const peeked = consumer.peek(); // the consumer is now mid-read on frame0 (READING set)
    expect(peeked?.pathId).toBe(1);
    // The producer wants to place frame2 but the ONLY droppable-oldest is frame0 — which the consumer holds.
    // It must NOT reclaim it; it drops the NEW frame instead (counts as dropped) and frame0 stays intact.
    expect(push(producer, 3, 'c'.repeat(20))).toBe(false);
    expect(producer.dropped).toBe(1);
    expect(dec.decode(peeked?.payload as Uint8Array)).toBe('a'.repeat(20)); // the held frame is uncorrupted
    consumer.consume(); // release frame0
    expect(consumer.peek()?.pathId).toBe(2); // frame1 still there
  });

  it('reports the dropped count cumulatively', () => {
    const { producer } = newRing(64);
    push(producer, 1, 'a'.repeat(20));
    push(producer, 2, 'b'.repeat(20));
    push(producer, 3, 'c'.repeat(20)); // drops frame0
    push(producer, 4, 'd'.repeat(20)); // drops frame1
    expect(producer.dropped).toBe(2);
  });

  it('consume() with no prior peek is a no-op', () => {
    const { producer, consumer } = newRing(1024);
    expect(() => consumer.consume()).not.toThrow(); // nothing peeked → READING is the sentinel
    push(producer, 9, 'z');
    expect(consumer.peek()?.pathId).toBe(9); // and the ring is untouched
  });

  it('wraps with NO marker when the trailing space is smaller than a header (< 8 bytes)', () => {
    // capacity 64; a 60-byte frame leaves only 4 trailing bytes — too few for an 8-byte SKIP header, so the
    // producer pads without a marker and the consumer wraps on the "< HEADER bytes to the end" rule.
    const { producer, consumer } = newRing(64);
    push(producer, 1, 'a'.repeat(52)); // frame = 60 bytes → tail at 60, 4 bytes to the end
    expect(drainAll(consumer)).toEqual([{ pathId: 1, text: 'a'.repeat(52) }]); // head now at 60
    push(producer, 2, 'b'.repeat(20)); // needs 28; only 4 to the end → pad 4 (no marker), write at 0
    expect(drainAll(consumer)).toEqual([{ pathId: 2, text: 'b'.repeat(20) }]); // wrapped past the markerless pad
  });

  it('drop-oldest counts the wrap-pad bytes too: never overruns an occupied frame at the wrap boundary', () => {
    // A frame needing wrap-padding must check free >= pad + frame, NOT just free >= frame — else it writes
    // pad+frame bytes into fewer free bytes, overrunning (corrupting) the oldest occupied frame instead of
    // dropping it. Construct the exact window need <= free < pad + need.
    const { producer, consumer } = newRing(100);
    push(producer, 1, 'f'.repeat(12)); // F0 (frame 20)
    consumer.peek();
    consumer.consume(); // consume F0 → head at 20
    push(producer, 2, 'v'.repeat(60)); // V, the victim (frame 68) → occupies [20, 88), unconsumed
    push(producer, 3, 'c'.repeat(22)); // C needs 30; 12 to the end → pad 12; free 32 ≥ 30 but < 42 → MUST drop V
    expect(drainAll(consumer)).toEqual([{ pathId: 3, text: 'c'.repeat(22) }]); // V cleanly dropped, C intact
    expect(producer.dropped).toBe(1);
  });

  it('integrity + conservation under churn: every survivor decodes correctly; dropped + drained == pushed', () => {
    // Push more records than a tiny ring holds, draining intermittently → forces drops AND wrap-pads. Each
    // record's payload self-describes its pathId, so any mis-sized TAIL advance, a fit-check that ignores the
    // wrap-pad (overrun), or a pad miscounted as a drop is caught by the integrity OR the conservation check.
    const { producer, consumer } = newRing(64); // ~2 × 28-byte frames
    const payload = (i: number) => `rec-${i}`.padEnd(20, '.'); // exactly 20 chars, encodes i
    const drained: number[] = [];
    const drainSome = (n: number): void => {
      for (let k = 0; k < n; k++) {
        const f = consumer.peek();
        if (f === null) break;
        expect(dec.decode(f.payload)).toBe(payload(f.pathId)); // integrity — uncorrupted, correctly framed
        drained.push(f.pathId);
        consumer.consume();
      }
    };
    let pushed = 0;
    for (let i = 1; i <= 12; i++) {
      expect(push(producer, i, payload(i))).toBe(true); // always placeable (≤ capacity, consumer not mid-read)
      pushed++;
      if (i % 4 === 0) drainSome(1); // keep the churn high (drops between drains)
    }
    drainSome(100); // drain the rest
    // every pushed record is either drained or dropped; wrap-pads are NOT records and must not inflate dropped.
    expect(producer.dropped + drained.length).toBe(pushed);
  });

  it('exposes SKIP_PATH_ID as a reserved sentinel (never a real path)', () => {
    expect(SKIP_PATH_ID).toBe(0xffffffff);
  });
});

// WAVE 6.7 — `reserve` corrupted HEAD when a legal-but-large record could not be placed on an EMPTY ring.
//
// `reserve` rejects only frames larger than the whole ring. A frame that FITS the ring can still be
// unplaceable when it would straddle the end: with `pad = cap - (TAIL mod cap)`, the fit test is
// `free >= pad + need`, which on an empty ring (`free == cap`) fails whenever `need > cap/2` and
// `TAIL mod cap` leaves too little room to the boundary.
//
// The only response to "doesn't fit" was drop-oldest — but on an empty ring there IS no oldest frame, so
// the code parsed whatever bytes happened to sit at `phys(HEAD)` (zeros on a fresh ring, STALE FRAME BYTES
// after the first lap) as a frame header and CAS-advanced HEAD by that bogus length. Measured in the
// review: HEAD jumped ~1.9 GiB past TAIL on a 64 KiB ring, after which `peek()` sees `head >= tail` and
// returns "empty" forever. Capture stopped completely — no throw, no onError, a `dropped` counter showing
// one drop, and 4,000 further appends producing zero writes. A randomised sweep hit it 27/27.
//
// Reached only via `captureWriter: 'worker'` (the default 'inline' path is unaffected), where the trigger
// is any single entry over ~699,050 characters at the default 4 MiB ring — a large console.log payload or
// an un-truncated network body, with no per-entry size cap anywhere in between.
describe('an empty ring cannot drop what it does not have (Wave 6.7)', () => {
  const CAP = 65536;

  /**
   * An EMPTY ring whose write cursor is parked mid-lap, plus the payload size that lands in the vulnerable
   * band: big enough that it cannot fit before the boundary, and big enough that padding to the boundary
   * plus the frame exceeds the whole ring. Computed from the ring's real state rather than guessed — my
   * first attempt picked a size that simply fit, and every assertion passed against the broken code.
   */
  const emptyRingInTheVulnerableBand = () => {
    const { data, control } = allocCaptureRing(CAP);
    const producer = new RingProducer(data, control);
    const consumer = new RingConsumer(data, control);
    const ctl = new BigInt64Array(control);
    const physTail = (): number => Number(Atomics.load(ctl, 1) % BigInt(CAP));
    while (physTail() < 19_384) {
      push(producer, 1, 'x'.repeat(120));
      drainAll(consumer); // …and drained, so the ring is EMPTY with TAIL parked mid-lap
    }
    const toEnd = CAP - physTail();
    return { producer, consumer, ctl, payload: 'z'.repeat(toEnd + 15) }; // need = toEnd + 23
  };

  it('places the record instead of parsing stale bytes as a frame header', () => {
    const { producer, consumer, payload } = emptyRingInTheVulnerableBand();
    expect(push(producer, 3, payload)).toBe(true);
    expect(drainAll(consumer)).toEqual([{ pathId: 3, text: payload }]);
  });

  it('counts NO drops — an empty ring discarded nothing', () => {
    // Measured against the broken code on this exact configuration: dropped went 0 -> 3299.
    const { producer, payload } = emptyRingInTheVulnerableBand();
    expect(producer.dropped).toBe(0);
    push(producer, 3, payload);
    expect(producer.dropped).toBe(0);
  });

  it('yields exactly ONE frame, not thousands of phantoms from stale bytes', () => {
    // The broken code produced 2446 "drainable" frames here — garbage parsed out of a previous lap.
    const { producer, consumer, payload } = emptyRingInTheVulnerableBand();
    push(producer, 3, payload);
    expect(drainAll(consumer)).toHaveLength(1);
  });

  it('never lets HEAD overtake TAIL — that is what wedges the consumer forever', () => {
    // The review's variant of the same corruption: HEAD jumped ~1.9 GiB past TAIL, after which peek() sees
    // head >= tail and reports "empty" for the life of the process.
    const { producer, ctl, payload } = emptyRingInTheVulnerableBand();
    push(producer, 3, payload);
    expect(Atomics.load(ctl, 0) <= Atomics.load(ctl, 1)).toBe(true);
  });

  it('keeps working for every later append', () => {
    const { producer, consumer, payload } = emptyRingInTheVulnerableBand();
    push(producer, 3, payload);
    expect(drainAll(consumer)).toHaveLength(1);
    for (let i = 0; i < 200; i += 1) {
      push(producer, 4, `after-${i}`);
    }
    expect(drainAll(consumer)).toHaveLength(200);
  });

  it('leaves the ring EMPTY again once the record is drained', () => {
    // The structural invariant. Repositioning only HEAD and leaving TAIL behind still let the record round
    // trip in my first tests, because a single push-then-drain hides an inconsistent cursor pair.
    const { producer, consumer, ctl, payload } = emptyRingInTheVulnerableBand();
    push(producer, 3, payload);
    drainAll(consumer);
    expect(Atomics.load(ctl, 0)).toBe(Atomics.load(ctl, 1)); // HEAD === TAIL
  });

  it('repositions to the BOUNDARY exactly — no wasted lap', () => {
    // Pins where the cursors land, not merely that the record survives. The reposition must skip precisely
    // the dead bytes to the end of the ring, so the retry is guaranteed to fit in ONE step; a reposition to
    // some other offset still converges eventually, silently burning ring space each time.
    const cap = 65536;
    const { producer, ctl, payload } = emptyRingInTheVulnerableBand();
    const before = Atomics.load(ctl, 1);
    const physTail = Number(before % BigInt(cap));
    push(producer, 3, payload);
    const advanced = Number(Atomics.load(ctl, 1) - before);
    expect(advanced).toBe(cap - physTail + 8 + payload.length);
  });

  it('still rejects a genuinely OVERSIZED frame without counting a drop — the canary', () => {
    // The bound that must not be relaxed by making the empty case placeable.
    const { producer } = newRing(1024);
    expect(producer.reserve(2000)).toBeNull();
    expect(producer.dropped).toBe(0);
  });

  it('still drops the oldest when the ring is genuinely FULL — the second canary', () => {
    const { producer, consumer } = newRing(1024);
    for (let i = 0; i < 40; i += 1) {
      push(producer, 1, 'a'.repeat(100));
    }
    expect(producer.dropped).toBeGreaterThan(0); // a full ring still sheds
    expect(drainAll(consumer).length).toBeGreaterThan(0); // …and still yields the newest
  });
});
