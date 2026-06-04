import { createChunkCaptureStore } from './chunk-capture-store';
import type { Clock } from './clock';
import type { CaptureStore } from './contracts';
import { createMemoryChunkBackend } from './memory-chunk-backend';

// In-memory CaptureStore — the ephemeral default (lambda/edge; no persistent medium to spill to). A thin
// wrapper over the chunk store + in-memory backend: 1-second parts, time-window + maxDataSize byte-cap
// eviction (drop oldest closed part), snapshot freezes a flat copy of record refs. Node/Bun (disk) and
// browser (IndexedDB) ship the same chunk store over a durable backend.

export interface MemoryCaptureStoreOptions {
  /** Recording window in ms (design maxRecordingTime): keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /**
   * Byte ceiling (design maxDataSize) on the total UTF-8 size of stored records; oldest closed parts
   * are evicted once it is exceeded. Default undefined = unbounded (only the time window applies).
   */
  maxDataSizeBytes?: number;
  /** Time source for the initial part / clear; injectable for tests. Default system clock. */
  clock?: Clock;
}

export function createMemoryCaptureStore(options?: MemoryCaptureStoreOptions): CaptureStore {
  return createChunkCaptureStore(createMemoryChunkBackend(), options);
}
