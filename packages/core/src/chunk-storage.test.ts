import { describe, expect, it } from 'vitest';
import { type ChunkStorage, createInMemoryChunkStorage } from './chunk-storage';

describe('createInMemoryChunkStorage', () => {
  it('append accumulates content within a (generation, chunk, file)', () => {
    const s = createInMemoryChunkStorage();
    s.append(1, 0, 'log', 'a\n');
    s.append(1, 0, 'log', 'b\n');
    expect(s.read(1, 0, 'log')).toBe('a\nb\n');
  });

  it('write replaces existing content', () => {
    const s = createInMemoryChunkStorage();
    s.append(1, 0, 'meta', 'old');
    s.write(1, 0, 'meta', 'new');
    expect(s.read(1, 0, 'meta')).toBe('new');
  });

  it('read returns undefined for an absent generation, chunk, or file', () => {
    const s = createInMemoryChunkStorage();
    expect(s.read(9, 0, 'log')).toBeUndefined(); // no generation
    s.write(1, 0, 'log', 'x');
    expect(s.read(1, 9, 'log')).toBeUndefined(); // no chunk
    expect(s.read(1, 0, 'nope')).toBeUndefined(); // no file
  });

  it('files lists the file names in a chunk (and [] when absent)', () => {
    const s = createInMemoryChunkStorage();
    s.write(1, 0, 'meta', 'm');
    s.append(1, 0, 'log', 'l');
    s.append(1, 0, 'network', 'n');
    expect(new Set(s.files(1, 0))).toEqual(new Set(['meta', 'log', 'network']));
    expect(s.files(1, 9)).toEqual([]); // absent chunk
    expect(s.files(9, 0)).toEqual([]); // absent generation
  });

  it('removeChunk drops only that chunk', () => {
    const s = createInMemoryChunkStorage();
    s.write(1, 0, 'log', 'a');
    s.write(1, 1, 'log', 'b');
    s.removeChunk(1, 0);
    expect(s.chunks(1)).toEqual([1]);
    expect(s.read(1, 0, 'log')).toBeUndefined();
    expect(s.read(1, 1, 'log')).toBe('b');
  });

  it('removeChunk on an absent generation is a no-op (no throw)', () => {
    const s = createInMemoryChunkStorage();
    expect(() => s.removeChunk(9, 0)).not.toThrow();
  });

  it('chunks lists the chunk numbers of a generation (and [] when absent)', () => {
    const s = createInMemoryChunkStorage();
    s.write(1, 2, 'log', 'x');
    s.write(1, 0, 'log', 'x');
    expect(new Set(s.chunks(1))).toEqual(new Set([0, 2]));
    expect(s.chunks(9)).toEqual([]);
  });

  it('generations lists the distinct generations', () => {
    const s = createInMemoryChunkStorage();
    s.write(5, 0, 'log', 'x');
    s.write(2, 0, 'log', 'x');
    expect(new Set(s.generations())).toEqual(new Set([5, 2]));
  });

  it('removeGeneration drops a whole generation', () => {
    const s = createInMemoryChunkStorage();
    s.write(1, 0, 'log', 'a');
    s.write(1, 1, 'log', 'b');
    s.write(2, 0, 'log', 'c');
    s.removeGeneration(1);
    expect(s.generations()).toEqual([2]);
    expect(s.chunks(1)).toEqual([]);
  });

  it('round-trips a meta + multiple data files in one chunk (the file-backend layout)', () => {
    const s: ChunkStorage = createInMemoryChunkStorage();
    s.write(100, 0, 'meta', '{"n":0,"s":1000,"e":null,"b":0}');
    s.append(100, 0, 'log', '{"t":1000,"s":"hi"}\n');
    s.append(100, 0, 'network', '{"t":1001,"s":"req"}\n');
    expect(s.read(100, 0, 'meta')).toContain('"s":1000');
    expect(s.read(100, 0, 'log')).toBe('{"t":1000,"s":"hi"}\n');
    expect(s.files(100, 0)).toContain('network');
  });
});
