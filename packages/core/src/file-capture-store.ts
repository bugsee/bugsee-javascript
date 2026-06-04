import { type ChunkCaptureStoreOptions, createChunkCaptureStore } from './chunk-capture-store';
import type { ChunkStorage } from './chunk-storage';
import { type Clock, createSystemClock } from './clock';
import type { CaptureStore } from './contracts';
import { createFileChunkBackend } from './file-chunk-backend';

// The durable file-backed CaptureStore: a thin wrapper that drives the chunk-based store
// (createChunkCaptureStore) over the directory-style file backend (createFileChunkBackend) — itself over
// any sync ChunkStorage medium (node fs, or the in-memory fake in tests). Each launch is a GENERATION
// (default the launch wall-clock ms) whose 1-second parts are chunk directories holding a durable `meta`
// file + per-source data files; on construction a fresh launch discards other generations' leftovers
// (recovery — preserving them — is a later slice). The part lifecycle, recording-window eviction, and
// the optional maxDataSize byte cap all live in the chunk store; only the storage medium differs here.

export interface FileCaptureStoreOptions {
  /** Recording window in ms: keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /** Byte ceiling on stored records; oldest closed parts are evicted once exceeded. Default unbounded. */
  maxDataSizeBytes?: number;
  /** Time source for the initial part / clear and the default generation. Default system clock. */
  clock?: Clock;
  /** This launch's generation id (groups its chunks). Default clock.wallNow() at construction. */
  generation?: number;
  /** On construction, delete OTHER generations' leftover chunks (prior launches). Default true. */
  cleanOtherGenerations?: boolean;
}

export function createFileCaptureStore(
  storage: ChunkStorage,
  options?: FileCaptureStoreOptions,
): CaptureStore {
  const clock = options?.clock ?? createSystemClock();
  const generation = options?.generation ?? clock.wallNow();
  const backend = createFileChunkBackend(storage, {
    generation,
    cleanOtherGenerations: options?.cleanOtherGenerations,
  });
  const storeOptions: ChunkCaptureStoreOptions = {
    maxRecordingTimeMs: options?.maxRecordingTimeMs,
    maxDataSizeBytes: options?.maxDataSizeBytes,
    clock,
  };
  return createChunkCaptureStore(backend, storeOptions);
}
