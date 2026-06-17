import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import type { PartRef } from './chunk-backend';
import { createInMemoryChunkStorage } from './chunk-storage';
import type { CaptureSnapshot, StoredEntry } from './contracts';
import { createFileChunkBackend } from './file-chunk-backend';

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

describe('createFileChunkBackend', () => {
  it('defaults generation to 0, or uses the provided one', () => {
    expect(createFileChunkBackend(createInMemoryChunkStorage()).generation).toBe(0);
    expect(createFileChunkBackend(createInMemoryChunkStorage(), { generation: 7 }).generation).toBe(
      7,
    );
  });

  it('openPart writes a durable meta file (end null); listParts reads it back', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    expect(JSON.parse(storage.read(5, 0, 'meta') as string)).toEqual({
      n: 0,
      s: 1000,
      e: null,
      b: 0,
    });
    expect(b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: undefined, byteSize: 0 },
    ]);
  });

  it('appendEntry writes the encoded line to the per-type data file and returns its byte size', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    const size = b.appendEntry(ref(5, 0), rec('hi', 'log', 1000));
    expect(storage.read(5, 0, 'log')).toBe('1000\thi\n'); // <ts>\t<serialized>\n
    expect(size).toBe('1000\thi\n'.length);
  });

  it('appendEntry returns the utf8 (not char) byte size for multi-byte payloads', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    // é is 2 UTF-8 bytes: the line `0\té\n` is 4 chars but 5 bytes.
    expect(b.appendEntry(ref(5, 0), rec('é'))).toBe(5);
  });

  it('closePart rewrites the meta with end + final byteSize (durable, recoverable)', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.closePart(ref(5, 0), 2000, 42);
    expect(b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: 2000, byteSize: 42 },
    ]);
  });

  it('closePart recovers the start from the persisted meta when the part was not opened in-process', () => {
    const storage = createInMemoryChunkStorage();
    storage.write(5, 0, 'meta', JSON.stringify({ n: 0, s: 777, e: null, b: 0 })); // left by a prior run
    const b = createFileChunkBackend(storage, { generation: 5, cleanOtherGenerations: false });
    b.closePart(ref(5, 0), 2000, 9);
    expect(b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 777, end: 2000, byteSize: 9 },
    ]);
  });

  it('listParts is sorted by part number and tolerates a corrupt meta file', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    b.openPart(ref(5, 2), 3000);
    b.openPart(ref(5, 0), 1000);
    storage.write(5, 1, 'meta', 'not-json'); // a corrupt/partial meta
    expect(b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: undefined, byteSize: 0 },
      { generation: 5, number: 1, start: 0, end: undefined, byteSize: 0 }, // corrupt → safe default
      { generation: 5, number: 2, start: 3000, end: undefined, byteSize: 0 },
    ]);
  });

  it('listParts derives a safe default for a chunk missing its meta file (a torn write)', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5, cleanOtherGenerations: false });
    storage.append(5, 0, 'log', '1\tx\n'); // data present, but no meta was ever written
    expect(b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 0, end: undefined, byteSize: 0 },
    ]);
  });

  it('listGenerations returns the distinct generations, sorted', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(20, 0), 1);
    b.openPart(ref(10, 0), 1);
    b.openPart(ref(10, 1), 1);
    expect(b.listGenerations()).toEqual([10, 20]);
  });

  it('snapshot reads each frozen part data file (skipping meta), oldest-first', async () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('a'));
    b.openPart(ref(5, 1), 2000);
    b.appendEntry(ref(5, 1), rec('c'));
    const snap = b.snapshot([
      { ref: ref(5, 0), count: 1 },
      { ref: ref(5, 1), count: 1 },
    ]);
    b.appendEntry(ref(5, 0), rec('after')); // appended after the snapshot was taken
    expect(await collect(snap)).toEqual(['a', 'c']); // frozen + oldest part first; meta excluded
  });

  it('snapshot skips torn lines (no tab separator, or a non-numeric timestamp)', async () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    storage.append(5, 0, 'log', '1000\tgood\n'); // a valid <ts>\t<serialized> frame
    storage.append(5, 0, 'log', 'no-tab-here\n'); // no \t separator → skipped
    storage.append(5, 0, 'log', '7777\n'); // a torn frame: numeric ts written, but no \t/serialized yet → skipped
    storage.append(5, 0, 'log', 'NaN\tbad-ts\n'); // non-numeric timestamp → skipped
    const snap = b.snapshot([{ ref: ref(5, 0), count: 99 }]);
    expect(await collect(snap)).toEqual(['good']);
  });

  it('preserves a serialized payload that itself contains a tab (splits on the FIRST tab only)', async () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    // ts=1000, serialized='a\tb' — the frame separates the timestamp by the FIRST tab; later tabs are payload.
    storage.append(5, 0, 'log', '1000\ta\tb\n');
    const snap = b.snapshot([{ ref: ref(5, 0), count: 99 }]);
    expect(await collect(snap)).toEqual(['a\tb']); // embedded tab preserved, NOT treated as a delimiter
  });

  it('removePart deletes the whole chunk group (meta + data)', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('a'));
    b.openPart(ref(5, 1), 2000);
    b.removePart(ref(5, 0));
    expect(storage.chunks(5)).toEqual([1]);
    expect(storage.files(5, 0)).toEqual([]); // both meta and data gone
  });

  it('removeGeneration deletes every chunk of a generation', () => {
    const storage = createInMemoryChunkStorage();
    const b = createFileChunkBackend(storage, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.openPart(ref(5, 1), 1);
    b.openPart(ref(9, 0), 1);
    b.removeGeneration(5);
    expect(storage.generations()).toEqual([9]);
  });

  it('on construction discards other generations’ chunks (clean-on-init), keeping its own', () => {
    const storage = createInMemoryChunkStorage();
    storage.append(1, 0, 'log', 'prior-launch');
    storage.append(9, 0, 'log', 'mine');
    createFileChunkBackend(storage, { generation: 9 });
    expect(storage.generations()).toEqual([9]);
    expect(storage.read(9, 0, 'log')).toBe('mine');
  });

  it('cleanOtherGenerations:false preserves other generations on construction', () => {
    const storage = createInMemoryChunkStorage();
    storage.append(1, 0, 'log', 'prior-launch');
    createFileChunkBackend(storage, { generation: 9, cleanOtherGenerations: false });
    expect(storage.generations()).toContain(1);
  });
});
