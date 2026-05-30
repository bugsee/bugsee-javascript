import type { FileType } from '@bugsee/protocol';
import { utf8ByteLength } from '@bugsee/util';
import { createRecordSnapshot } from './capture-snapshot';
import { type Clock, createSystemClock } from './clock';
import type { CaptureSnapshot, CaptureStore, FileStorageAdapter, StoredEntry } from './contracts';

// File-backed CaptureStore as an Android-style PartManager with per-launch GENERATIONS (shared by
// node/bun/deno/electron via a FileStorageAdapter). Each launch is a generation (default the launch
// wall-clock ms); its records append to the current 1-second PART's per-type file, named
// `<gen13>__<part12>__<type>` (the FileStorageAdapter is a flat named-stream store, so generation +
// part are encoded in the name). tick(now) closes the current part, opens a new one, and deletes the
// files of parts outside the recording window. On construction a fresh launch DELETES other
// generations' leftover capture files (a prior launch that died without a clean stop) — that stale
// rolling-buffer data is discarded, NOT uploaded (crash recovery re-uploads persisted bundles, a
// separate concern). snapshot() reads the current in-window parts into an in-memory frozen
// CaptureSnapshot (the live files keep rolling + getting GC'd during export); release() drops the copy.
//
// (Content-hash snapshot dedup is deferred — it deduplicates on-disk snapshot file COPIES, which this
// in-memory-snapshot model does not produce.)
//
// Two memory bounds apply (drop-oldest-part semantics, design A1): the time window above, and an
// optional maxDataSize BYTE cap enforced on add — when the running on-disk UTF-8 byte total exceeds
// the cap, whole oldest CLOSED parts are evicted (their files removed) until it fits. The open
// current part is never evicted, so a single oversized part is a documented soft over-shoot.

const PART_DURATION_MS = 1000;
const SEPARATOR = '__';
const GEN_PAD = 13;
const PART_PAD = 12;
// A capture-part file: <13-digit generation>__<12-digit part>__<type>. Used to identify (and only
// ever delete) capture files — foreign files (e.g. persisted crash bundles) never match it.
const PART_FILE_RE = /^(\d{13})__\d{12}__.+$/;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

interface FilePart {
  number: number;
  start: number;
  /** undefined while the part is open (the current part). */
  end: number | undefined;
  /** Running on-disk UTF-8 byte total of this part's encoded records. */
  bytes: number;
}

export interface FileCaptureStoreOptions {
  /** Recording window in ms (design maxRecordingTime): keep only the last N ms. Default 60_000. */
  maxRecordingTimeMs?: number;
  /**
   * Byte ceiling (design maxDataSize) on the total on-disk size of stored records; oldest closed
   * parts are evicted once it is exceeded. Default undefined = unbounded (only the time window).
   */
  maxDataSizeBytes?: number;
  /** Time source for the initial part / clear and the default generation; injectable. Default system clock. */
  clock?: Clock;
  /** This launch's generation id (groups its files). Default clock.wallNow() at construction. */
  generation?: number;
  /** On construction, delete OTHER generations' leftover capture files (prior launches). Default true. */
  cleanOtherGenerations?: boolean;
}

export function createFileCaptureStore(
  adapter: FileStorageAdapter,
  options?: FileCaptureStoreOptions,
): CaptureStore {
  const maxRecordingTimeMs = options?.maxRecordingTimeMs ?? 60_000;
  const maxDataSizeBytes = options?.maxDataSizeBytes;
  const clock = options?.clock ?? createSystemClock();
  const generation = options?.generation ?? clock.wallNow();
  const genPrefix = `${pad(generation, GEN_PAD)}${SEPARATOR}`;

  const partPrefix = (partNumber: number): string =>
    `${genPrefix}${pad(partNumber, PART_PAD)}${SEPARATOR}`;
  const fileName = (partNumber: number, type: FileType): string =>
    `${partPrefix(partNumber)}${type}`;

  // Fresh launch: discard prior launches' leftover capture files (other generations only). Foreign
  // files (e.g. persisted crash bundles) never match PART_FILE_RE and are left untouched.
  if (options?.cleanOtherGenerations !== false) {
    for (const name of adapter.names()) {
      const match = PART_FILE_RE.exec(name);
      if (match !== null && Number(match[1]) !== generation) {
        adapter.remove(name);
      }
    }
  }

  let parts: FilePart[] = [{ number: 0, start: clock.wallNow(), end: undefined, bytes: 0 }];
  let nextNumber = 1;
  // Running on-disk byte total across all live parts; kept in sync with every add/evict so the byte
  // cap and the time window never double-count.
  let totalBytes = 0;
  const current = (): FilePart => parts[parts.length - 1] as FilePart;

  const encode = (record: StoredEntry): string =>
    `${JSON.stringify({ t: record.timestamp, s: record.serialized })}\n`;

  const removePart = (partNumber: number): void => {
    const prefix = partPrefix(partNumber);
    for (const name of adapter.names()) {
      if (name.startsWith(prefix)) {
        adapter.remove(name);
      }
    }
  };

  // Evict whole oldest CLOSED parts (removing their files) until the byte total fits the cap. Never
  // the open current part (parts.length > 1 guard): a lone oversized part is kept (soft bound).
  const enforceByteCap = (): void => {
    if (maxDataSizeBytes === undefined) {
      return;
    }
    while (totalBytes > maxDataSizeBytes && parts.length > 1) {
      const dropped = parts.shift() as FilePart;
      totalBytes -= dropped.bytes;
      removePart(dropped.number);
    }
  };

  return {
    add(record: StoredEntry): void {
      const encoded = encode(record);
      const part = current();
      adapter.append(fileName(part.number, record.type), encoded);
      const size = utf8ByteLength(encoded);
      part.bytes += size;
      totalBytes += size;
      enforceByteCap();
    },

    tick(nowMs: number): void {
      current().end = nowMs;
      parts.push({ number: nextNumber, start: nowMs, end: undefined, bytes: 0 });
      nextNumber += 1;
      const cutting = nowMs - maxRecordingTimeMs - PART_DURATION_MS;
      while (parts.length > 0 && parts[0]?.end !== undefined && parts[0].end < cutting) {
        const dropped = parts.shift() as FilePart;
        totalBytes -= dropped.bytes;
        removePart(dropped.number);
      }
    },

    snapshot(): CaptureSnapshot {
      // Read the in-window parts' files into memory, in part order (chronological per type). Only this
      // generation's active parts are read — an evicted/untracked/foreign file matches no part prefix.
      const flat: StoredEntry[] = [];
      for (const part of parts) {
        const prefix = partPrefix(part.number);
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
        if (name.startsWith(genPrefix)) {
          adapter.remove(name);
        }
      }
      parts = [{ number: nextNumber, start: clock.wallNow(), end: undefined, bytes: 0 }];
      nextNumber += 1;
      totalBytes = 0;
    },
  };
}
