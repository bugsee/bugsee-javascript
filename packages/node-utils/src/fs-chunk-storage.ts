import { join } from 'node:path';
import type { ChunkStorage } from '@bugsee/core';
import {
  appendFileSecure,
  ensureDir,
  listFiles,
  readFileBytes,
  remove,
  writeFileSecure,
} from './fs-storage';

// The Node filesystem implementation of core's ChunkStorage (the durable directory medium beneath the
// file-backed chunk store). Layout: `<root>/<gen13>/<chunk12>/<file>` — one directory per generation,
// one per chunk (names zero-padded so a lexical listing sorts numerically), each holding a `meta` file
// plus one append-only data file per source/FileType. Owner-only (0o600/0o700) via fs-storage; deleting
// a chunk or generation is a single recursive `remove` of its directory. @bugsee/node passes this to
// createFileCaptureStore; bun and electron-main reuse it (deno ships a Deno.* equivalent).

const GEN_PAD = 13;
const CHUNK_PAD = 12;
const pad = (value: number, width: number): string => String(value).padStart(width, '0');
// Numeric directory names only; foreign entries (e.g. a stray `.DS_Store`) parse to NaN and are skipped.
const numericNames = (dir: string): number[] =>
  listFiles(dir)
    .map((name) => Number(name))
    .filter((value) => Number.isInteger(value));

export function createFsChunkStorage(root: string): ChunkStorage {
  ensureDir(root);
  const genDir = (generation: number): string => join(root, pad(generation, GEN_PAD));
  const chunkDir = (generation: number, chunk: number): string =>
    join(genDir(generation), pad(chunk, CHUNK_PAD));
  const filePath = (generation: number, chunk: number, file: string): string =>
    join(chunkDir(generation, chunk), file);

  return {
    append(generation, chunk, file, data): void {
      ensureDir(chunkDir(generation, chunk));
      appendFileSecure(filePath(generation, chunk, file), data);
    },

    write(generation, chunk, file, data): void {
      ensureDir(chunkDir(generation, chunk));
      writeFileSecure(filePath(generation, chunk, file), data);
    },

    read(generation, chunk, file): string | undefined {
      const bytes = readFileBytes(filePath(generation, chunk, file));
      return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
    },

    files(generation, chunk): string[] {
      return listFiles(chunkDir(generation, chunk));
    },

    removeChunk(generation, chunk): void {
      remove(chunkDir(generation, chunk));
    },

    chunks(generation): number[] {
      return numericNames(genDir(generation));
    },

    generations(): number[] {
      return numericNames(root);
    },

    removeGeneration(generation): void {
      remove(genDir(generation));
    },
  };
}
