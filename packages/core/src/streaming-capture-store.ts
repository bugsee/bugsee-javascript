// A transport-agnostic streaming CaptureStore: instead of buffering into a local rolling ring, it
// serializes each capture entry and posts it across a boundary IMMEDIATELY — the receiver (a native host,
// or the Electron main process) is the ring + the bundler. Extracted from @bugsee/webview's
// HostBridgeCaptureStore so @bugsee/webview and @bugsee/electron share the store logic; the two variable
// parts are injected: `post` (the transport sink) and `encodeEntry` (the caller's wire codec). `add` is
// fire-and-forget — `post` never throws and the payload is already a serialized string, so the hot path
// never throws. `snapshot()` is empty (no local bundle) and `tick()`/`clear()` are no-ops.
import type { FileType } from '@bugsee/protocol';
import type { CaptureSnapshot, CaptureStore, StoredEntry } from './contracts';

/** The primitive fields of a streamed capture entry (the `encodeEntry` input). */
export interface StreamingCaptureEntry {
  type: FileType;
  seq: number;
  timestamp: number;
  /** `performance.now()` at post time — lets the receiver map to its own time-base. */
  mono: number;
  /** `performance.timeOrigin` of this process. */
  timeOrigin: number;
  /** The entry's already-serialized payload string. */
  payload: string;
  /** Redaction provenance: did a local filter already run for this entry type? */
  redacted: boolean;
}

export interface StreamingCaptureStoreOptions {
  /** The transport sink each encoded entry is posted to. Must never throw. */
  post: (raw: string) => void;
  /** Encode a streaming entry to a wire string (the caller's protocol). */
  encodeEntry: (entry: StreamingCaptureEntry) => string;
  /** `performance.now()` source for the monotonic stamp. Default the ambient `performance`. */
  now?: () => number;
  /** `performance.timeOrigin` for the receiver's time-base mapping. Default the ambient `performance`. */
  timeOrigin?: number;
  /** Monotonic-sequence source (shared with the report path so seq is per-session global). Default internal. */
  seq?: () => number;
  /** Whether forwarding is paused (host pause/resume). Default never. */
  paused?: () => boolean;
  /** Redaction provenance per file type. Default no. */
  redactedFor?: (type: FileType) => boolean;
}

function ambientPerformance(): { now(): number; timeOrigin: number } {
  return (globalThis as unknown as { performance: { now(): number; timeOrigin: number } })
    .performance;
}

/** An empty snapshot — a streaming store never assembles a local bundle; the receiver does. */
function emptySnapshot(): CaptureSnapshot {
  return {
    async *stream(): AsyncIterableIterator<StoredEntry> {
      // no local records — the receiver owns the buffer (intentionally yields nothing)
    },
    drainAll(): Promise<Map<FileType, StoredEntry[]>> {
      return Promise.resolve(new Map());
    },
    release(): void {
      // nothing to free
    },
  };
}

/** Build a streaming capture store that encodes + posts every entry across a boundary. */
export function createStreamingCaptureStore(opts: StreamingCaptureStoreOptions): CaptureStore {
  const now = opts.now ?? ((): number => ambientPerformance().now());
  const timeOrigin = opts.timeOrigin ?? ambientPerformance().timeOrigin;
  let internal = 0;
  const nextSeq = opts.seq ?? ((): number => internal++);
  const paused = opts.paused ?? ((): boolean => false);
  const redactedFor = opts.redactedFor ?? ((): boolean => false);

  return {
    add(record: StoredEntry): void {
      // While paused, drop the capture stream — no boundary crossings. Incidents are unaffected
      // (the report path is separate), so a crash while paused still reports.
      if (paused()) {
        return;
      }
      opts.post(
        opts.encodeEntry({
          type: record.type,
          seq: nextSeq(),
          timestamp: record.timestamp,
          mono: now(),
          timeOrigin,
          payload: record.serialized,
          redacted: redactedFor(record.type),
        }),
      );
    },
    tick(): void {
      // No-op: the receiver owns the rolling window.
    },
    snapshot(): CaptureSnapshot {
      return emptySnapshot();
    },
    clear(): void {
      // No-op: nothing is buffered locally.
    },
  };
}
