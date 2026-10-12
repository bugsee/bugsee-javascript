import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import type { PartRef } from './chunk-backend';
import type { CaptureSnapshot, StoredEntry } from './contracts';
import { createMemoryChunkBackend } from './memory-chunk-backend';

const ref = (generation: number, number: number): PartRef => ({ generation, number });
const rec = (serialized: string, type: FileType = 'log', timestamp = 0): StoredEntry => ({
  type,
  timestamp,
  serialized,
});

const collect = async (snap: CaptureSnapshot): Promise<string[]> => {
  const out: string[] = [];
  for await (const r of snap.stream()) {
    out.push(r.serialized);
  }
  return out;
};

describe('createMemoryChunkBackend', () => {
  it('defaults generation to 0, or uses the provided one', () => {
    expect(createMemoryChunkBackend().generation).toBe(0);
    expect(createMemoryChunkBackend({ generation: 7 }).generation).toBe(7);
  });

  it('appendEntry returns the utf8 byte size of the serialized form', () => {
    const b = createMemoryChunkBackend();
    b.openPart(ref(0, 0), 1000);
    expect(b.appendEntry(ref(0, 0), rec('abc'))).toBe(3);
    expect(b.appendEntry(ref(0, 0), rec('héllo'))).toBe(6); // é is 2 bytes
  });

  it('appendEntry to an unopened part is a no-op but still reports the byte size', () => {
    const b = createMemoryChunkBackend();
    expect(b.appendEntry(ref(0, 9), rec('x'))).toBe(1); // no part 9 → nothing stored
    expect(b.listParts(0)).toEqual([]);
  });

  it('snapshot reads frozen parts up to count, oldest-first, isolated from later appends', async () => {
    const b = createMemoryChunkBackend();
    b.openPart(ref(0, 0), 1000);
    b.appendEntry(ref(0, 0), rec('a'));
    b.appendEntry(ref(0, 0), rec('b'));
    b.openPart(ref(0, 1), 2000);
    b.appendEntry(ref(0, 1), rec('c'));
    const snap = b.snapshot([
      { ref: ref(0, 0), count: 1 }, // only the first record of part 0
      { ref: ref(0, 1), count: 1 },
    ]);
    b.appendEntry(ref(0, 0), rec('after')); // captured after the snapshot
    expect(await collect(snap)).toEqual(['a', 'c']); // count-bounded + isolated, oldest part first
  });

  it('snapshot of a part with no stored data yields nothing for it', async () => {
    const b = createMemoryChunkBackend();
    b.openPart(ref(0, 0), 1000);
    b.appendEntry(ref(0, 0), rec('a'));
    b.removePart(ref(0, 0)); // gone before the snapshot is taken
    expect(await collect(b.snapshot([{ ref: ref(0, 0), count: 1 }]))).toEqual([]);
  });

  it('closePart records end + final byteSize into durable metadata; listParts is sorted', () => {
    const b = createMemoryChunkBackend({ generation: 5 });
    b.openPart(ref(5, 1), 2000);
    b.openPart(ref(5, 0), 1000);
    b.closePart(ref(5, 0), 2000, 42);
    expect(b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: 2000, byteSize: 42 },
      { generation: 5, number: 1, start: 2000, end: undefined, byteSize: 0 },
    ]);
    expect(b.listParts(99)).toEqual([]); // a different generation
  });

  it('closePart on an unopened part is a no-op', () => {
    const b = createMemoryChunkBackend();
    b.closePart(ref(0, 9), 2000, 5);
    expect(b.listParts(0)).toEqual([]);
  });

  it('listGenerations returns the distinct generations, sorted', () => {
    const b = createMemoryChunkBackend();
    b.openPart(ref(20, 0), 1);
    b.openPart(ref(10, 0), 1);
    b.openPart(ref(10, 1), 1);
    expect(b.listGenerations()).toEqual([10, 20]);
  });

  it('removePart drops only that part (data + metadata)', async () => {
    const b = createMemoryChunkBackend();
    b.openPart(ref(0, 0), 1);
    b.openPart(ref(0, 1), 1);
    b.removePart(ref(0, 0));
    expect((await b.listParts(0)).map((p) => p.number)).toEqual([1]);
  });

  it('removeGeneration drops only that generation', () => {
    const b = createMemoryChunkBackend();
    b.openPart(ref(0, 0), 1);
    b.openPart(ref(1, 0), 1);
    b.removeGeneration(0);
    expect(b.listGenerations()).toEqual([1]);
    expect(b.listParts(0)).toEqual([]);
  });
});
