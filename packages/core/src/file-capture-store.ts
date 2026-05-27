import type { FileType } from '@bugsee/protocol';
import { createRecordSnapshot } from './capture-snapshot';
import { type Clock, createSystemClock } from './clock';
import type { CaptureSnapshot, CaptureStore, FileStorageAdapter, StoredEntry } from './contracts';

// File-backed CaptureStore as an Android-style PartManager (shared by node/bun/deno/electron via a
// FileStorageAdapter). Records append to the current 1-second PART's per-type file (named
// `<paddedPartNumber>__<type>`); tick(now) closes the current part, opens a new one, and deletes the
// files of parts outside the recording window. snapshot() reads the current in-window parts' files
// into an in-memory frozen CaptureSnapshot (the live files keep rolling + getting GC'd during export);
// release() drops the in-memory copy. Part metadata (number/start/end) is tracked in memory.
//
// (Generations + session recovery and content-hash dedup for snapshots are the fuller-port follow-up;
// a maxDataSize byte bound is also not yet implemented.)

const PART_DURATION_MS = 1000;
const SEPARATOR = '__';

const pad = (partNumber: number): string => String(partNumber).padStart(12, '0');
const fileName = (partNumber: number, type: FileType): string =>
  `${pad(partNumber)}${SEPARATOR}${type}`;

interface FilePart {
  number: number;
  start: number;
  /** undefined while the part is open (the current part). */
  end: number | undefined;
}

export interface FileCaptureStoreOptions {
  /** Recording window in ms (design maxRecordingTime): keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /** Time source for the initial part / clear; injectable for tests. Default system clock. */
  clock?: Clock;
}

export function createFileCaptureStore(
  adapter: FileStorageAdapter,
  options?: FileCaptureStoreOptions,
): CaptureStore {
  const maxRecordingTimeMs = options?.maxRecordingTimeMs ?? 60_000;
  const clock = options?.clock ?? createSystemClock();

  let parts: FilePart[] = [{ number: 0, start: clock.wallNow(), end: undefined }];
  let nextNumber = 1;
  const current = (): FilePart => parts[parts.length - 1] as FilePart;

  const encode = (record: StoredEntry): string =>
    `${JSON.stringify({ t: record.timestamp, s: record.serialized })}\n`;

  const removePart = (partNumber: number): void => {
    const prefix = `${pad(partNumber)}${SEPARATOR}`;
    for (const name of adapter.names()) {
      if (name.startsWith(prefix)) {
        adapter.remove(name);
      }
    }
  };

  return {
    add(record: StoredEntry): void {
      adapter.append(fileName(current().number, record.type), encode(record));
    },

    tick(nowMs: number): void {
      current().end = nowMs;
      parts.push({ number: nextNumber, start: nowMs, end: undefined });
      nextNumber += 1;
      const cutting = nowMs - maxRecordingTimeMs - PART_DURATION_MS;
      while (parts.length > 0 && parts[0]?.end !== undefined && parts[0].end < cutting) {
        removePart((parts.shift() as FilePart).number);
      }
    },

    snapshot(): CaptureSnapshot {
      // Read the in-window parts' files into memory, in part order (chronological per type). Only the
      // active parts' files are read — a leftover/evicted/stray file matches no active part's prefix.
      const flat: StoredEntry[] = [];
      for (const part of parts) {
        const prefix = `${pad(part.number)}${SEPARATOR}`;
        for (const name of adapter.names()) {
          if (!name.startsWith(prefix)) {
            continue;
          }
          const type = name.slice(prefix.length) as FileType;
          for (const line of (adapter.read(name) ?? '').split('\n')) {
            let parsed: { t: number; s: string };
            try {
              parsed = JSON.parse(line) as { t: number; s: string };
            } catch {
              continue; // skip blank/corrupt/truncated lines
            }
            flat.push({ type, timestamp: parsed.t, serialized: parsed.s });
          }
        }
      }
      return createRecordSnapshot(flat);
    },

    clear(): void {
      for (const name of adapter.names()) {
        adapter.remove(name);
      }
      parts = [{ number: nextNumber, start: clock.wallNow(), end: undefined }];
      nextNumber += 1;
    },
  };
}
