import { closeSync, openSync, writevSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ChunkStorage } from '@bugsee/core';
import { ensureDir, listFiles, readFileBytes, remove, writeFileSecure } from './fs-storage';

// Batched Node ChunkStorage (design: docs/design/server-disk-capture-write-path.md, Phase 1). Same directory
// layout as createFsChunkStorage, but the per-entry hot path (`append`) is BUFFERED and coalesced: each data
// file's pending segments are written in ONE `writevSync` on a high-water mark (or the periodic/crash flush),
// instead of one open+write+close syscall per entry. The benchmark (design §10) shows this turns a blocking
// write's multi-second event-loop freeze into a ~10 ms tail at full throughput. Handles are held open for the
// ACTIVE chunk only (sealed on closePart) so the open-fd count stays bounded to ~one chunk, not the rolling
// window. A reader (snapshot/recovery) flushes the file first, so it always sees everything captured so far.

const GEN_PAD = 13;
const CHUNK_PAD = 12;
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;
const IOV_MAX = 1024; // writev caps its iovec count; split a larger flush into multiple calls
const FILE_MODE = 0o600;

const encoder = new TextEncoder();
const pad = (value: number, width: number): string => String(value).padStart(width, '0');
const numericNames = (dir: string): number[] =>
  listFiles(dir)
    .map((name) => Number(name))
    .filter((value) => Number.isInteger(value));

interface OpenFile {
  fd: number;
  segments: Uint8Array[];
  bytes: number;
}

export interface BatchedFsChunkStorageOptions {
  /** Flush a file once its buffered bytes reach this (a single oversized entry flushes alone). Default 64 KiB. */
  highWaterMark?: number;
}

/** A batched, held-fd, `writev`-coalescing ChunkStorage. Implements the optional flushSync/sealChunk/dispose
 * lifecycle (driven by launch: a periodic timer + the crash/exit seam + stop). */
export function createBatchedFsChunkStorage(
  root: string,
  options: BatchedFsChunkStorageOptions = {},
): ChunkStorage {
  ensureDir(root);
  const highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  const genDir = (generation: number): string => join(root, pad(generation, GEN_PAD));
  const chunkDir = (generation: number, chunk: number): string =>
    join(genDir(generation), pad(chunk, CHUNK_PAD));
  const filePath = (generation: number, chunk: number, file: string): string =>
    join(chunkDir(generation, chunk), file);

  // path → its open fd + pending segments. Only the active chunk's files are present (sealed on closePart).
  const open = new Map<string, OpenFile>();

  const flushPath = (path: string): void => {
    const entry = open.get(path);
    if (entry === undefined || entry.segments.length === 0) {
      return;
    }
    for (let i = 0; i < entry.segments.length; i += IOV_MAX) {
      writevSync(entry.fd, entry.segments.slice(i, i + IOV_MAX));
    }
    entry.segments = [];
    entry.bytes = 0;
  };

  const closePath = (path: string): void => {
    const entry = open.get(path);
    if (entry === undefined) {
      return;
    }
    flushPath(path);
    closeSync(entry.fd);
    open.delete(path);
  };

  /** Close every open handle whose path is under `prefix` (a chunk dir or a generation dir). */
  const closeUnder = (prefix: string): void => {
    const within = prefix + sep;
    for (const path of [...open.keys()]) {
      if (path.startsWith(within)) {
        closePath(path);
      }
    }
  };

  return {
    append(generation, chunk, file, data): void {
      const path = filePath(generation, chunk, file);
      let entry = open.get(path);
      if (entry === undefined) {
        ensureDir(chunkDir(generation, chunk));
        entry = { fd: openSync(path, 'a', FILE_MODE), segments: [], bytes: 0 };
        open.set(path, entry);
      }
      const bytes = encoder.encode(data);
      entry.segments.push(bytes);
      entry.bytes += bytes.length;
      if (entry.bytes >= highWaterMark) {
        flushPath(path); // high-water mark, or a single oversized entry → its own write
      }
    },

    write(generation, chunk, file, data): void {
      // meta / replace writes are infrequent (~1 per chunk) — straight-through. (meta files are never
      // appended-to, so this never races a held append handle; defensive close in case it ever does.)
      const path = filePath(generation, chunk, file);
      closePath(path);
      ensureDir(chunkDir(generation, chunk));
      writeFileSecure(path, data);
    },

    read(generation, chunk, file): string | undefined {
      const path = filePath(generation, chunk, file);
      flushPath(path); // a snapshot/recovery reader must see everything buffered so far
      const bytes = readFileBytes(path);
      return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
    },

    files(generation, chunk): string[] {
      return listFiles(chunkDir(generation, chunk));
    },

    removeChunk(generation, chunk): void {
      closeUnder(chunkDir(generation, chunk));
      remove(chunkDir(generation, chunk));
    },

    chunks(generation): number[] {
      return numericNames(genDir(generation));
    },

    generations(): number[] {
      return numericNames(root);
    },

    removeGeneration(generation): void {
      closeUnder(genDir(generation));
      remove(genDir(generation));
    },

    flushSync(): void {
      for (const path of open.keys()) {
        flushPath(path);
      }
    },

    sealChunk(generation, chunk): void {
      closeUnder(chunkDir(generation, chunk));
    },

    dispose(): void {
      for (const path of [...open.keys()]) {
        closePath(path);
      }
    },
  };
}
