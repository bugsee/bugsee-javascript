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
// A tripped circuit lets one flush through every this-many attempts, to see whether the disk recovered.
const PROBE_INTERVAL = 128;
// Ceiling on the unwritten tail held per file (Wave 6.3). 1 MiB × the ~8 capture file types is the
// worst-case hold, which is bounded and small next to the 50 MB default capture budget.
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

const IOV_MAX = 1024; // writev caps its iovec count; split a larger flush into multiple calls
const FILE_MODE = 0o600;

const encoder = new TextEncoder();
const pad = (value: number, width: number): string => String(value).padStart(width, '0');
const numericNames = (dir: string): number[] =>
  listFiles(dir)
    .map((name) => Number(name))
    .filter((value) => Number.isInteger(value));

/** A `writev`-shaped sink: write the iovec, return the count of bytes actually written (may be short). */
export type WritevFn = (fd: number, buffers: readonly Uint8Array[]) => number;

interface OpenFile {
  fd: number;
  segments: Uint8Array[];
  bytes: number;
}

export interface BatchedFsChunkStorageOptions {
  /** Flush a file once its buffered bytes reach this (a single oversized entry flushes alone). Default 64 KiB. */
  highWaterMark?: number;
  /** Failure sink for a flush/close error (a broken disk must never throw into the capture path). Default no-op. */
  onError?: (error: unknown) => void;
  /**
   * Ceiling on the unwritten tail held per file before the OLDEST records are shed (Wave 6.3). Default 1 MiB.
   *
   * The retry-without-duplication design keeps the still-unwritten tail buffered so a later retry cannot
   * duplicate an already-written prefix — correct, but it had no ceiling, so a persistently failing disk
   * (ENOSPC / EROFS / EIO / a vanished dataDir) turned every captured entry into permanent memory growth.
   * `docs/design/server-disk-capture-write-path.md:120` (D2) binds this path to "fixed ring, drop-oldest
   * under overload (no elastic growth)"; this is what makes the shipped default honour it.
   */
  maxBufferedBytes?: number;
  /**
   * Consecutive flush failures after which `writev` stops being attempted (Wave 6.3). Default 8.
   *
   * A full disk otherwise costs one doomed syscall AND one `onError` per captured entry — measured at
   * 19,998 of each for 20,000 appends. It re-probes, so a disk that frees up is written to again.
   */
  failureThreshold?: number;
  /** `writev` primitive; injectable for tests (short-write simulation). Default node:fs `writevSync`. */
  writev?: WritevFn;
  /** `close` primitive; injectable for tests (close-failure simulation). Default node:fs `closeSync`. */
  close?: (fd: number) => void;
  /** Open a data file for appending. Default node:fs `openSync(path,'a',0o600)`; injectable for disk-error tests. */
  open?: (path: string) => number;
  /** Ensure a directory exists. Default fs-storage `ensureDir`; injectable for disk-error tests. */
  ensureDir?: (dir: string) => void;
  /** Replace a file's contents (meta/write). Default fs-storage `writeFileSecure`; injectable for disk-error tests. */
  writeFile?: (path: string, data: string) => void;
  /** Recursively remove a directory. Default fs-storage `remove`; injectable for disk-error tests. */
  removeDir?: (dir: string) => void;
}

/**
 * Drain `entry.segments` to `entry.fd`, honoring `writev`'s short-write contract: a single `writev` may
 * write FEWER bytes than requested, so loop — advance past fully-written segments, trim the partially-written
 * one, and re-issue — until the whole batch is on disk. (IOV_MAX caps the iovec count per call.) A naive
 * single call that ignored the return value would silently truncate a record mid-write on a short write.
 *
 * Consumes the buffer IN PLACE (rewrites `entry.segments` as bytes land), so if a LATER `writev` in the same
 * drain throws, `entry.segments` holds only the still-UNWRITTEN tail — the kept-buffer retry then re-writes
 * exactly that, never duplicating an already-written prefix into the append-mode file.
 */
function writeAll(entry: OpenFile, writev: WritevFn): void {
  while (entry.segments.length > 0) {
    const batch = entry.segments.slice(0, IOV_MAX);
    const want = batch.reduce((sum, b) => sum + b.length, 0);
    const written = writev(entry.fd, batch);
    if (written >= want) {
      entry.segments = entry.segments.slice(batch.length); // whole batch flushed
      continue;
    }
    if (written <= 0) {
      // A non-empty batch that made NO progress would spin forever; a real writevSync never does this (it
      // advances ≥1 byte or throws), but the writev seam is injectable — bail out so flushPath routes to
      // onError + keeps the (unwritten) buffer for a later retry, rather than hang the caller.
      throw new Error(`writev made no progress (returned ${written} of ${want})`);
    }
    // Short write: drop the fully-written leading segments, trim the partial one — the remainder is retried.
    let consumed = written;
    let i = 0;
    while (i < batch.length && consumed >= (batch[i] as Uint8Array).length) {
      consumed -= (batch[i] as Uint8Array).length;
      i++;
    }
    entry.segments = entry.segments.slice(i);
    if (consumed > 0) {
      entry.segments[0] = (entry.segments[0] as Uint8Array).subarray(consumed);
    }
  }
}

/** A batched, held-fd, `writev`-coalescing ChunkStorage. Implements the optional flushSync/sealChunk/dispose
 * lifecycle (driven by launch: a periodic timer + the crash/exit seam + stop). */
export function createBatchedFsChunkStorage(
  root: string,
  options: BatchedFsChunkStorageOptions = {},
): ChunkStorage {
  const highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  const onErrorRaw = options.onError ?? ((): void => {});
  // `onError` is caller-supplied and a natural implementation logs — which re-enters capture. A sink that
  // throws must not take the capture path with it either.
  const onError = (error: unknown): void => {
    try {
      onErrorRaw(error);
    } catch {
      // nothing left to report it to
    }
  };
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const failureThreshold = options.failureThreshold ?? 8;
  // Circuit state. `consecutiveFailures` counts flushes that threw in a row; once it reaches the threshold
  // the writer stops attempting, letting one probe through every PROBE_INTERVAL flushes so a recovered
  // disk closes it again. `shed` counts records given up, reported as ONE summary rather than one each.
  let consecutiveFailures = 0;
  let sinceProbe = 0;
  let shed = 0;
  let reportedEpisode = false;

  const reportShed = (): void => {
    if (shed > 0) {
      const count = shed;
      shed = 0;
      onError(new Error(`bugsee: shed ${count} capture record(s) — the disk is not keeping up`));
    }
  };
  const writev = options.writev ?? writevSync;
  const close = options.close ?? closeSync;
  const openFile = options.open ?? ((path: string): number => openSync(path, 'a', FILE_MODE));
  const ensure = options.ensureDir ?? ensureDir;
  const writeFile = options.writeFile ?? writeFileSecure;
  const removeDir = options.removeDir ?? remove;
  ensure(root);
  const genDir = (generation: number): string => join(root, pad(generation, GEN_PAD));
  const chunkDir = (generation: number, chunk: number): string =>
    join(genDir(generation), pad(chunk, CHUNK_PAD));
  const filePath = (generation: number, chunk: number, file: string): string =>
    join(chunkDir(generation, chunk), file);

  // path → its open fd + pending segments. Only the active chunk's files are present (sealed on closePart).
  const open = new Map<string, OpenFile>();

  const flushPath = (path: string, force = false): void => {
    const entry = open.get(path);
    if (entry === undefined || entry.segments.length === 0) {
      return;
    }
    if (!force && consecutiveFailures >= failureThreshold) {
      sinceProbe += 1;
      if (sinceProbe < PROBE_INTERVAL) {
        return; // circuit open — do not issue another doomed syscall
      }
      sinceProbe = 0;
    }
    try {
      // writeAll consumes entry.segments in place — on success it empties them; on a mid-drain throw it
      // leaves only the still-unwritten tail.
      writeAll(entry, writev);
      consecutiveFailures = 0;
      reportedEpisode = false;
      reportShed();
    } catch (error) {
      // A broken/full disk must never throw into the capture path. Route it out; the unwritten tail stays
      // buffered for a later retry (never duplicating an already-written prefix), bounded by
      // `maxBufferedBytes` so the retry cannot become unbounded memory growth.
      consecutiveFailures += 1;
      // The FIRST failure of an episode is the diagnosis; the rest are counted and summarised, because a
      // report per captured entry is not a diagnostic — it is a second failure mode.
      if (!reportedEpisode) {
        reportedEpisode = true;
        onError(error);
      }
    }
    entry.bytes = entry.segments.reduce((sum, b) => sum + b.length, 0); // 0 on success, the remainder on error
  };

  const closePath = (path: string): void => {
    const entry = open.get(path);
    if (entry === undefined) {
      return;
    }
    flushPath(path); // never throws (routes to onError); the fd is closed + dropped regardless, so no leak
    try {
      close(entry.fd);
    } catch (error) {
      onError(error);
    }
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
        let fd: number;
        try {
          ensure(chunkDir(generation, chunk));
          fd = openFile(path);
        } catch (error) {
          // A broken/full disk must NEVER throw into the capture path — append is reached synchronously
          // from interceptors (console.log → capture) and from the tick. Shed this entry + report instead.
          onError(error);
          return;
        }
        entry = { fd, segments: [], bytes: 0 };
        open.set(path, entry);
      }
      const bytes = encoder.encode(data);
      entry.segments.push(bytes);
      entry.bytes += bytes.length;
      if (entry.bytes >= highWaterMark) {
        flushPath(path); // high-water mark, or a single oversized entry → its own write
      }
      // Shed the OLDEST unwritten records once the tail exceeds its ceiling — the design's own
      // "drop-oldest under overload", and the right end to give up: the moments before a crash are the
      // ones worth keeping. Never sheds the last segment, so a single record larger than the ceiling is
      // still written rather than silently discarded.
      while (entry.segments.length > 1 && entry.bytes > maxBufferedBytes) {
        const dropped = entry.segments.shift() as Uint8Array;
        entry.bytes -= dropped.length;
        shed += 1;
      }
    },

    write(generation, chunk, file, data): void {
      // meta / replace writes are infrequent (~1 per chunk) — straight-through. (meta files are never
      // appended-to, so this never races a held append handle; defensive close in case it ever does.)
      const path = filePath(generation, chunk, file);
      closePath(path);
      try {
        ensure(chunkDir(generation, chunk));
        writeFile(path, data);
      } catch (error) {
        onError(error); // a broken disk on a meta write must never throw into the caller (the tick)
      }
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
      try {
        removeDir(chunkDir(generation, chunk));
      } catch (error) {
        onError(error); // eviction on a broken disk must never throw into the caller (the tick/add)
      }
    },

    chunks(generation): number[] {
      return numericNames(genDir(generation));
    },

    generations(): number[] {
      return numericNames(root);
    },

    removeGeneration(generation): void {
      closeUnder(genDir(generation));
      try {
        removeDir(genDir(generation));
      } catch (error) {
        onError(error); // generation eviction on a broken disk must never throw into the caller
      }
    },

    flushSync(): void {
      // FORCED past the circuit: this is the explicit "write now" seam (the periodic timer, exit, a
      // signal), so it is also the moment to find out whether the disk recovered.
      for (const path of open.keys()) {
        flushPath(path, true);
      }
      reportShed();
    },

    /** Bytes currently held unwritten across every open file — the quantity `maxBufferedBytes` bounds. */
    bufferedBytes(): number {
      let total = 0;
      for (const entry of open.values()) {
        total += entry.bytes;
      }
      return total;
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
