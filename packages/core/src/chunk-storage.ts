// The directory-style storage medium beneath the file-backed chunk store (Android `CaptureFileStorage`
// analog; the user's "Layer 2 — the underlying storage that creates the files/entries"). A chunk is a
// GROUP `(generation, chunk)` holding named files — a `meta` file + one data file per source/FileType —
// realized as a real directory on a filesystem (`<root>/<gen>/<chunk>/<file>`) or a key group elsewhere.
// Deleting a chunk removes the WHOLE group; deleting a generation removes all its chunks. This seam is
// SYNCHRONOUS (the node fs impl is sync); the browser tier supplies an async equivalent (IndexedDB).

import { serviceToken } from '@bugsee/service';

export interface ChunkStorage {
  /** Append `data` to file `<generation>/<chunk>/<file>` (creating the chunk group as needed). */
  append(generation: number, chunk: number, file: string, data: string): void;
  /** Write (replace) file `<generation>/<chunk>/<file>`. */
  write(generation: number, chunk: number, file: string, data: string): void;
  /** Read file `<generation>/<chunk>/<file>`, or undefined if absent. */
  read(generation: number, chunk: number, file: string): string | undefined;
  /** The file names present in chunk `<generation>/<chunk>/` (empty if absent). */
  files(generation: number, chunk: number): string[];
  /** Remove the whole chunk group. */
  removeChunk(generation: number, chunk: number): void;
  /** The chunk numbers present under `<generation>/` (empty if absent). */
  chunks(generation: number): number[];
  /** Every generation id with at least one chunk. */
  generations(): number[];
  /** Remove a whole generation (all its chunks). */
  removeGeneration(generation: number): void;

  // --- Optional batched-writer lifecycle (the node batched fs storage; no-op/absent otherwise) ---
  /** Flush any buffered appends to the OS (page cache), keeping the active chunk's handles open. Driven by
   * a periodic timer + the crash/exit seam, so an un-catchable kill loses at most the last flush window. */
  flushSync?(): void;
  /** A chunk is sealed (closePart): flush + close its file handles — keeps the open-handle count bounded to
   * the active chunk, not the whole rolling window. */
  sealChunk?(generation: number, chunk: number): void;
  /** Flush everything + close all handles (on stop()). */
  dispose?(): void;
  /**
   * Bytes currently held UNWRITTEN by a batched writer (Wave 6.3), or absent where nothing is buffered.
   *
   * This is the quantity a back-pressure bound exists to cap: a storage that defers physical writes holds
   * captured records in memory until they land, and a persistently failing disk otherwise turns that hold
   * into unbounded growth in the host process.
   */
  bufferedBytes?(): number;
}

// Service token for the chunk-storage medium. Present only in file-backed mode (a dataDir, no captureStore
// override); the platform registers its impl (node fs / IndexedDB) so it is resolvable process-wide.
export const ChunkStorageToken = serviceToken<ChunkStorage>('chunkStorage');

// An in-memory ChunkStorage (nested maps) — the test fake for the file backend, and the persistent-store
// substrate on runtimes without a real medium. Mirrors the directory semantics exactly.
export function createInMemoryChunkStorage(): ChunkStorage {
  // generation → chunk → file → content.
  const data = new Map<number, Map<number, Map<string, string>>>();

  const chunkMap = (
    generation: number,
    chunk: number,
    create: boolean,
  ): Map<string, string> | undefined => {
    let gen = data.get(generation);
    if (gen === undefined) {
      if (!create) {
        return undefined;
      }
      gen = new Map();
      data.set(generation, gen);
    }
    let files = gen.get(chunk);
    if (files === undefined) {
      if (!create) {
        return undefined;
      }
      files = new Map();
      gen.set(chunk, files);
    }
    return files;
  };

  return {
    append(generation, chunk, file, content): void {
      const files = chunkMap(generation, chunk, true) as Map<string, string>;
      files.set(file, (files.get(file) ?? '') + content);
    },

    write(generation, chunk, file, content): void {
      (chunkMap(generation, chunk, true) as Map<string, string>).set(file, content);
    },

    read(generation, chunk, file): string | undefined {
      return chunkMap(generation, chunk, false)?.get(file);
    },

    files(generation, chunk): string[] {
      return [...(chunkMap(generation, chunk, false)?.keys() ?? [])];
    },

    removeChunk(generation, chunk): void {
      data.get(generation)?.delete(chunk);
    },

    chunks(generation): number[] {
      return [...(data.get(generation)?.keys() ?? [])];
    },

    generations(): number[] {
      return [...data.keys()];
    },

    removeGeneration(generation): void {
      data.delete(generation);
    },
  };
}
