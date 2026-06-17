import { describe, expect, it, vi } from 'vitest';
import { allocCaptureRing, RingConsumer, RingProducer } from './capture-ring';
import {
  chunkOfPathId,
  type DrainerOps,
  encodePathId,
  RingDrainer,
  typeIndexOfPathId,
} from './capture-ring-drainer';

const enc = new TextEncoder();
const dec = new TextDecoder();

// A fake fs: each pathId maps to its own fd (an integer); writes accumulate per fd; closes are recorded.
function fakeOps(over: Partial<DrainerOps> = {}) {
  let nextFd = 10;
  const fdOfPath = new Map<number, number>(); // pathId → fd
  const opens: number[] = []; // pathIds opened (in order)
  const writes = new Map<number, number[]>(); // fd → flat written bytes
  const closed: number[] = []; // fds closed
  const ops: DrainerOps = {
    openFor: vi.fn((pathId: number) => {
      opens.push(pathId);
      const fd = nextFd++;
      fdOfPath.set(pathId, fd);
      writes.set(fd, []);
      return fd;
    }),
    writev: (fd, iov) => {
      const buf = writes.get(fd) as number[];
      let n = 0;
      for (const b of iov) {
        for (const byte of b) buf.push(byte);
        n += b.length;
      }
      return n;
    },
    close: (fd) => {
      closed.push(fd);
    },
    onError: vi.fn(),
    ...over,
  };
  const textOnFd = (pathId: number): string =>
    dec.decode(Uint8Array.from(writes.get(fdOfPath.get(pathId) as number) ?? []));
  return { ops, opens, writes, closed, fdOfPath, textOnFd };
}

const push = (p: RingProducer, pathId: number, s: string): void => {
  const bytes = enc.encode(s);
  const view = p.reserve(bytes.length);
  if (view === null) throw new Error('reserve null');
  view.set(bytes);
  p.commit(pathId, bytes.length);
};

const newDrainer = (capacity: number, over?: Partial<DrainerOps>) => {
  const { data, control } = allocCaptureRing(capacity);
  const f = fakeOps(over);
  return {
    producer: new RingProducer(data, control),
    drainer: new RingDrainer(new RingConsumer(data, control), f.ops),
    ...f,
  };
};

describe('pathId codec', () => {
  it('packs/unpacks (chunk, typeIndex) — round-trip + the field accessors', () => {
    const id = encodePathId(123, 5);
    expect(chunkOfPathId(id)).toBe(123);
    expect(typeIndexOfPathId(id)).toBe(5);
    // distinct (chunk,type) → distinct ids
    expect(encodePathId(1, 0)).not.toBe(encodePathId(0, 1));
    expect(encodePathId(1, 0)).not.toBe(encodePathId(1, 1));
  });
});

describe('RingDrainer', () => {
  it('writes each committed frame to the fd for its pathId, in order', () => {
    const { producer, drainer, textOnFd } = newDrainer(1024);
    const a = encodePathId(0, 0);
    push(producer, a, 'one');
    push(producer, a, 'two');
    drainer.drain();
    expect(textOnFd(a)).toBe('onetwo'); // appended in order
  });

  it('demuxes frames to different fds by pathId, opening each lazily exactly once', () => {
    const { producer, drainer, textOnFd, opens } = newDrainer(1024);
    const a = encodePathId(0, 0);
    const b = encodePathId(0, 1);
    push(producer, a, 'AA');
    push(producer, b, 'BB');
    push(producer, a, 'aa');
    drainer.drain();
    expect(textOnFd(a)).toBe('AAaa');
    expect(textOnFd(b)).toBe('BB');
    expect(opens).toEqual([a, b]); // opened once each, in first-seen order (cached thereafter)
  });

  it('stops on a write error and LEAVES the frame in the ring (retry next drain — no loss)', () => {
    let fail = true;
    const out: number[] = [];
    const { producer, drainer, ops } = newDrainer(1024, {
      writev: (_fd, iov) => {
        if (fail) throw new Error('EIO');
        let n = 0;
        for (const b of iov) {
          for (const byte of b) out.push(byte);
          n += b.length;
        }
        return n;
      },
    });
    const a = encodePathId(0, 0);
    push(producer, a, 'keepme');
    drainer.drain(); // writev throws → onError, frame NOT consumed
    expect(ops.onError).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]); // nothing written
    fail = false;
    drainer.drain(); // retry — the frame is still there and now lands
    expect(dec.decode(Uint8Array.from(out))).toBe('keepme');
  });

  it('honors a writev SHORT write — re-issues until the whole payload lands', () => {
    let first = true;
    const { producer, drainer, writes, fdOfPath } = newDrainer(1024, {
      writev: (fd, iov) => {
        const buf = writes.get(fd) as number[];
        const all: number[] = [];
        for (const b of iov) for (const byte of b) all.push(byte);
        const n = first ? Math.min(2, all.length) : all.length; // first call writes only 2 bytes
        first = false;
        for (let i = 0; i < n; i++) buf.push(all[i] as number);
        return n;
      },
    });
    const a = encodePathId(0, 0);
    push(producer, a, 'abcdef');
    drainer.drain();
    expect(dec.decode(Uint8Array.from(writes.get(fdOfPath.get(a) as number) ?? []))).toBe('abcdef');
  });

  it('bails out (routes to onError, keeps the frame) when writev makes no progress', () => {
    const { producer, drainer, ops } = newDrainer(1024, {
      writev: () => 0, // a stuck sink: non-empty buffer, zero bytes → must not spin
    });
    push(producer, encodePathId(0, 0), 'x');
    expect(() => drainer.drain()).not.toThrow();
    expect(ops.onError).toHaveBeenCalledTimes(1);
  });

  it('closeChunk closes + forgets only that chunk’s fds (a later append reopens)', () => {
    const { producer, drainer, closed, fdOfPath, opens } = newDrainer(1024);
    const c0a = encodePathId(0, 0);
    const c1a = encodePathId(1, 0);
    push(producer, c0a, 'x');
    push(producer, c1a, 'y');
    drainer.drain(); // opens both
    const fd0 = fdOfPath.get(c0a) as number;
    drainer.closeChunk(0);
    expect(closed).toEqual([fd0]); // only chunk 0's fd closed
    push(producer, c0a, 'z');
    drainer.drain();
    expect(opens.filter((id) => id === c0a)).toHaveLength(2); // chunk 0 reopened after close
  });

  it('closeAll closes every open fd (dispose)', () => {
    const { producer, drainer, closed, fdOfPath } = newDrainer(1024);
    const a = encodePathId(0, 0);
    const b = encodePathId(2, 1);
    push(producer, a, '1');
    push(producer, b, '2');
    drainer.drain();
    drainer.closeAll();
    expect(new Set(closed)).toEqual(new Set([fdOfPath.get(a), fdOfPath.get(b)]));
  });

  it('routes a close() failure to onError without throwing', () => {
    const { producer, drainer, ops } = newDrainer(1024, {
      close: () => {
        throw new Error('close boom');
      },
    });
    push(producer, encodePathId(0, 0), 'x');
    drainer.drain();
    expect(() => drainer.closeAll()).not.toThrow();
    expect(ops.onError).toHaveBeenCalledTimes(1);
  });

  it('closing an unknown pathId / chunk is a no-op', () => {
    const { drainer, closed } = newDrainer(1024);
    expect(() => drainer.closePathId(999)).not.toThrow();
    drainer.closeChunk(42);
    expect(closed).toEqual([]);
  });

  it('an empty ring drains to nothing', () => {
    const { drainer, opens } = newDrainer(1024);
    drainer.drain();
    expect(opens).toEqual([]);
  });
});
