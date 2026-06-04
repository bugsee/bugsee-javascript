import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createChunkCaptureStore } from './chunk-capture-store';
import type { Clock } from './clock';
import type { StoredEntry } from './contracts';
import { createMemoryChunkBackend } from './memory-chunk-backend';

// These pin the STORE → BACKEND protocol (durable metadata effects the memory store's own public API
// doesn't observe): part opening, closePart on tick, removePart on eviction, removeGeneration on clear.
// The store's observable capture behavior is covered by memory-capture-store.test.ts.

const clockAt = (now: number): Clock => ({ wallNow: () => now, monotonicNow: () => 0 });
const recBytes = (bytes: number, type: FileType = 'log'): StoredEntry => ({
  type,
  timestamp: 0,
  serialized: 'x'.repeat(bytes),
});

describe('createChunkCaptureStore — backend protocol', () => {
  it('opens part 0 at the clock time on construction', async () => {
    const backend = createMemoryChunkBackend();
    createChunkCaptureStore(backend, { clock: clockAt(1000) });
    expect(await backend.listParts(0)).toEqual([
      { generation: 0, number: 0, start: 1000, end: undefined, byteSize: 0 },
    ]);
  });

  it('closes the current part (end + byteSize) and opens a fresh one on tick', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, { clock: clockAt(1000) });
    store.add(recBytes(5));
    store.tick(2000);
    expect(await backend.listParts(0)).toEqual([
      { generation: 0, number: 0, start: 1000, end: 2000, byteSize: 5 },
      { generation: 0, number: 1, start: 2000, end: undefined, byteSize: 0 },
    ]);
  });

  it('removes a time-evicted part from the backend', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, {
      clock: clockAt(10_000),
      maxRecordingTimeMs: 2000,
    });
    store.add(recBytes(5)); // part 0
    store.tick(11_000); // part 0 closes @11000
    store.tick(15_000); // cutting 12000 → part 0 (end 11000) evicted → removePart
    expect((await backend.listParts(0)).map((p) => p.number)).toEqual([1, 2]); // part 0 gone
  });

  it('removes a byte-cap-evicted part from the backend', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, { clock: clockAt(0), maxDataSizeBytes: 10 });
    store.add(recBytes(8)); // part 0
    store.tick(1000); // close part 0
    store.add(recBytes(8)); // part 1 → total 16 > 10 → evict part 0 (closed) → removePart
    expect((await backend.listParts(0)).map((p) => p.number)).toEqual([1]); // part 0 gone
  });

  it('removes the whole generation on clear, then opens a fresh part', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, { clock: clockAt(5000) });
    store.add(recBytes(5));
    store.tick(6000); // two parts now
    store.clear();
    // The prior parts (0,1) are removed; a single fresh part remains.
    const parts = await backend.listParts(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.end).toBeUndefined();
    expect(parts[0]?.byteSize).toBe(0);
    expect(parts[0]?.start).toBe(5000); // reopened at the clock time
  });
});
