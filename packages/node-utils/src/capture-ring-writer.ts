import { closeSync, openSync, writeSync, writevSync } from 'node:fs';
import { join } from 'node:path';
import type { ChunkStorage } from '@bugsee/core';
import { allocCaptureRing, RingConsumer, RingProducer } from './capture-ring';
import {
  chunkOfPathId,
  type DrainerOps,
  encodePathId,
  RingDrainer,
  typeIndexOfPathId,
} from './capture-ring-drainer';
import { ensureDir, listFiles, readFileBytes, remove, writeFileSecure } from './fs-storage';

// CaptureRingWriter — the Phase-2 ChunkStorage over the shared CaptureRing + a RingWorker (design D6/D7).
// It is a drop-in for the Phase-1 batched writer (identical on-disk layout + tab-frame), but the per-entry
// HOT path encodes the frame IN PLACE into the shared ring (zero-copy) and a WORKER drains it to disk off
// the host thread. The worker OWNS all data-file fds (deno can't inherit the main's fds), so the main talks
// to it by path-derived `pathId` (in the ring) + a tiny control surface (flushAndWait / closeChunk / closeAll
// / stop). The infrequent main-thread parts — meta writes, reads, directory listing/removal — stay on the
// main thread (D4); reads/seals first flush-and-ack so the worker's writes are on disk.

const GEN_PAD = 13;
const CHUNK_PAD = 12;
const FILE_MODE = 0o600;
const DEFAULT_RING_CAPACITY = 4 * 1024 * 1024; // generous → a single record is never "oversized"
const DEFAULT_FLUSH_TIMEOUT_MS = 3000;
const MAX_UTF8_PER_CHAR = 3; // upper bound for reserve() before encodeInto knows the real byte length

const encoder = new TextEncoder();
const pad = (value: number, width: number): string => String(value).padStart(width, '0');
const numericNames = (dir: string): number[] =>
  listFiles(dir)
    .map((name) => Number(name))
    .filter((value) => Number.isInteger(value));

/** The control surface the CaptureRingWriter drives — a worker_threads worker in prod, the sync worker in
 * tests / as a fallback. (`flags` carries the prod flush/shutdown Atomics; the sync worker ignores it.) */
export interface RingWorker {
  /** Drain the ring fully to disk, synchronously (bounded by `timeoutMs`). */
  flushAndWait(timeoutMs: number): void;
  /** Close + forget the worker's fds for one chunk (after a flush). */
  closeChunk(chunk: number): void;
  /** Close + forget every fd (dispose). */
  closeAll(): void;
  /** Drain + close all + terminate (the worker stops). */
  stop(): void;
}

export interface RingWorkerArgs {
  data: SharedArrayBuffer;
  control: SharedArrayBuffer;
  /** Flush/shutdown Atomics control for the worker_threads impl (the sync worker ignores it). */
  flags: SharedArrayBuffer;
  /** The capture root; the worker derives each file's path from it + the generation + fileTypes. */
  captureDir: string;
  generation: number;
  /** File-type names; index = the `typeIndex` packed into a `pathId`. Shared main↔worker. */
  fileTypes: readonly string[];
  onError: (error: unknown) => void;
}

export interface CaptureRingWriterOptions {
  /** The launch generation (the live writer writes only this gen via the ring). */
  generation: number;
  /** Ordered file-type names; index → name (drives the pathId + the worker's path derivation). */
  fileTypes: readonly string[];
  /** Ring size in bytes. Default 4 MiB (≫ any single record, so nothing is ever oversized). */
  ringCapacity?: number;
  /** Budget for a synchronous flush-and-ack. Default 3000 ms. */
  flushTimeoutMs?: number;
  /** Worker factory; the seam the worker_threads impl swaps into. Default the sync (main-thread) worker. */
  workerFactory?: (args: RingWorkerArgs) => RingWorker;
  onError?: (error: unknown) => void;
  /** Open a file for the main-thread append fallback. Default `openSync(path,'a',0o600)`; injectable for tests. */
  open?: (path: string) => number;
  /** Replace a file's contents (meta/write). Default fs-storage `writeFileSecure`; injectable for tests. */
  writeFile?: (path: string, data: string) => void;
  /** Recursively remove a directory. Default fs-storage `remove`; injectable for disk-error tests. */
  removeDir?: (dir: string) => void;
}

/** Derive the on-disk path for a `pathId` (chunk + typeIndex) under `captureDir`/`generation`. */
function pathForId(
  captureDir: string,
  generation: number,
  fileTypes: readonly string[],
  pathId: number,
): string {
  const chunk = chunkOfPathId(pathId);
  const name = fileTypes[typeIndexOfPathId(pathId)] as string;
  return join(captureDir, pad(generation, GEN_PAD), pad(chunk, CHUNK_PAD), name);
}

/**
 * A synchronous, same-thread RingWorker: a RingDrainer over real fs ops that drains the ring on demand
 * (flushAndWait). The default worker AND the injectable test seam AND a graceful fallback when worker_threads
 * is unavailable — correct, just on-thread (the off-thread worker_threads impl swaps in via workerFactory).
 */
export function createSyncRingWorker(args: RingWorkerArgs): RingWorker {
  const consumer = new RingConsumer(args.data, args.control);
  const ops: DrainerOps = {
    openFor(pathId) {
      const path = pathForId(args.captureDir, args.generation, args.fileTypes, pathId);
      ensureDir(path.slice(0, path.lastIndexOf('/')));
      return openSync(path, 'a', FILE_MODE);
    },
    writev: (fd, iov) => writevSync(fd, iov as NodeJS.ArrayBufferView[]),
    close: (fd) => closeSync(fd),
    onError: args.onError,
  };
  const drainer = new RingDrainer(consumer, ops);
  return {
    flushAndWait: () => drainer.drain(),
    closeChunk: (chunk) => drainer.closeChunk(chunk),
    closeAll: () => drainer.closeAll(),
    stop: () => {
      drainer.drain();
      drainer.closeAll();
    },
  };
}

/** A drop-in ChunkStorage that writes the rolling capture through the shared ring + a RingWorker. */
export function createCaptureRingWriter(
  root: string,
  options: CaptureRingWriterOptions,
): ChunkStorage {
  const { generation, fileTypes } = options;
  const onError = options.onError ?? ((): void => {});
  const flushTimeout = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const openFile = options.open ?? ((path: string): number => openSync(path, 'a', FILE_MODE));
  const writeFile = options.writeFile ?? writeFileSecure;
  const removeDir = options.removeDir ?? remove;
  ensureDir(root);

  const { data, control } = allocCaptureRing(options.ringCapacity ?? DEFAULT_RING_CAPACITY);
  const flags = new SharedArrayBuffer(16);
  const producer = new RingProducer(data, control);
  const factory = options.workerFactory ?? createSyncRingWorker;
  const worker = factory({
    data,
    control,
    flags,
    captureDir: root,
    generation,
    fileTypes,
    onError,
  });

  const chunkDir = (g: number, c: number): string => join(root, pad(g, GEN_PAD), pad(c, CHUNK_PAD));
  const filePath = (g: number, c: number, file: string): string => join(chunkDir(g, c), file);

  // Append `data` directly on the main thread (the rare fallback: an unknown file type or a foreign
  // generation — the live worker writes only its own gen's known file types through the ring).
  const mainAppend = (g: number, c: number, file: string, dataStr: string): void => {
    let fd: number | undefined;
    try {
      ensureDir(chunkDir(g, c));
      fd = openFile(filePath(g, c, file));
      writeSync(fd, dataStr);
    } catch (error) {
      // A broken/full disk must NEVER throw out of append — it is reached synchronously from interceptors
      // and the tick (the fallback path: unknown type / foreign gen / oversized). Shed + report instead.
      onError(error);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (error) {
          onError(error);
        }
      }
    }
  };

  return {
    append(g, c, file, dataStr): void {
      const ti = fileTypes.indexOf(file);
      if (g !== generation || ti < 0) {
        mainAppend(g, c, file, dataStr); // fallback
        return;
      }
      // Reserve an upper bound, encode IN PLACE, commit the actual byte length (zero-copy hot path).
      const view = producer.reserve(dataStr.length * MAX_UTF8_PER_CHAR);
      if (view === null) {
        // Oversized for the ring (shouldn't happen with the default cap). It targets the SAME file the worker
        // owns — so drain the ring FIRST, then main-append, preserving per-file order.
        worker.flushAndWait(flushTimeout);
        mainAppend(g, c, file, dataStr);
        return;
      }
      const { written } = encoder.encodeInto(dataStr, view);
      producer.commit(encodePathId(c, ti), written);
    },

    write(g, c, file, dataStr): void {
      try {
        ensureDir(chunkDir(g, c));
        writeFile(filePath(g, c, file), dataStr); // meta / replace — main thread (D4)
      } catch (error) {
        onError(error); // a broken disk on a meta write must never throw into the caller (the tick)
      }
    },

    read(g, c, file): string | undefined {
      worker.flushAndWait(flushTimeout); // a reader must see everything the worker has drained
      const bytes = readFileBytes(filePath(g, c, file));
      return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
    },

    files(g, c): string[] {
      worker.flushAndWait(flushTimeout); // the worker creates files lazily on drain — drain so a LIVE
      return listFiles(chunkDir(g, c)); // snapshot (which lists files before reading) sees pending data
    },

    removeChunk(g, c): void {
      if (g === generation) {
        worker.flushAndWait(flushTimeout); // drain any pending frames so the worker can't reopen the dir…
        worker.closeChunk(c); // …then release its fds before deleting (no resurrection)
      }
      try {
        removeDir(chunkDir(g, c));
      } catch (error) {
        onError(error); // eviction on a broken disk must never throw into the caller (the tick/add)
      }
    },

    chunks(g): number[] {
      worker.flushAndWait(flushTimeout); // drain so pending-but-undrained chunks are enumerable (live read)
      return numericNames(join(root, pad(g, GEN_PAD)));
    },

    generations(): number[] {
      worker.flushAndWait(flushTimeout); // drain so a pending-but-undrained generation is enumerable
      return numericNames(root);
    },

    removeGeneration(g): void {
      if (g === generation) {
        worker.flushAndWait(flushTimeout); // drain pending frames first, then release all fds (no resurrection)
        worker.closeAll();
      }
      try {
        removeDir(join(root, pad(g, GEN_PAD)));
      } catch (error) {
        onError(error); // generation eviction on a broken disk must never throw into the caller
      }
    },

    flushSync(): void {
      worker.flushAndWait(flushTimeout);
    },

    sealChunk(_g, c): void {
      worker.flushAndWait(flushTimeout); // ensure the chunk's data is on disk…
      worker.closeChunk(c); // …then release its handles (bounds the open-fd count)
    },

    dispose(): void {
      worker.stop();
    },
  };
}
