import type { FileType } from '@bugsee/protocol';
import type {
  CaptureDataEntry,
  CaptureEntryFactory,
  CaptureEntryStream,
  CaptureSnapshot,
  StoredEntry,
} from './contracts';

/** Rebuild a stored record as an entry, carrying the visual source lane (not part of the serialized payload). */
export function reify(record: StoredEntry, factory: CaptureEntryFactory): CaptureDataEntry {
  const entry = factory(record.type);
  entry.deserialize(record.serialized);
  if (record.lane !== undefined) {
    entry.lane = record.lane;
  }
  return entry;
}

/**
 * Stream a snapshot's records as reified entries, one at a time (the memory-light read; `drainReified` is the
 * all-at-once one), releasing the snapshot when the read ends. Shared by the capture exporter (live store) and both
 * recovery paths (a prior generation's snapshot).
 *
 * The snapshot is already taken, so its release must not depend on the generator ever starting: an async generator that
 * was never read skips its own `finally`, and a consumer that fails before its first read would leak the frozen copy.
 * `return()`/`throw()` therefore always release, once.
 */
export function streamReified(
  snapshot: CaptureSnapshot,
  factory: CaptureEntryFactory,
  onError: (error: unknown) => void,
): CaptureEntryStream {
  const records = snapshot.stream();
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      snapshot.release();
    }
  };
  const inner = (async function* (): AsyncGenerator<CaptureDataEntry, void, undefined> {
    try {
      for await (const record of records) {
        let entry: CaptureDataEntry;
        try {
          entry = reify(record, factory);
        } catch (error) {
          // A torn/un-deserializable record (e.g. a crash's torn trailing frame): skip + report it, never let one bad
          // record abort the whole export.
          onError(error);
          continue;
        }
        yield entry;
      }
    } finally {
      release();
    }
  })();
  const range = snapshot.timeRange?.();
  const stream: CaptureEntryStream = {
    ...(range !== undefined ? { timeRange: range } : {}),
    next: () => inner.next(),
    return: async (value) => {
      try {
        return await inner.return(value);
      } finally {
        release();
      }
    },
    throw: async (error) => {
      try {
        return await inner.throw(error);
      } finally {
        release();
      }
    },
    [Symbol.asyncIterator]: () => stream,
  };
  return stream;
}

// Drain a capture snapshot into reified entries grouped by file type (the read half of CaptureExporter,
// but over a snapshot we already hold rather than a live store), releasing the snapshot when done. Shared
// by both recovery paths: detected-incident recovery (capture-recovery.ts) and native-crash synthesis
// (native-crash-recovery.ts) rebuild a prior generation's capture the same way.
export async function drainReified(
  snapshot: CaptureSnapshot,
  factory: CaptureEntryFactory,
  onError: (error: unknown) => void,
): Promise<Map<FileType, CaptureDataEntry[]>> {
  try {
    const grouped = await snapshot.drainAll();
    const out = new Map<FileType, CaptureDataEntry[]>();
    for (const [type, records] of grouped) {
      const entries: CaptureDataEntry[] = [];
      for (const record of records) {
        try {
          entries.push(reify(record, factory));
        } catch (error) {
          // A torn trailing frame — the exact artifact a crash/SIGKILL leaves mid-write — yields one
          // un-deserializable record (the snapshot parser only guards the timestamp, not the payload).
          // Skip it; NEVER let one bad record poison the whole generation's recovery (which would keep
          // the marker + chunks and repeat the failure on every launch — a permanent loss). Route to onError.
          onError(error);
        }
      }
      out.set(type, entries);
    }
    return out;
  } finally {
    snapshot.release();
  }
}
