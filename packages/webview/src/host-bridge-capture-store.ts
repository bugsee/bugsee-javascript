import type { CaptureSnapshot, CaptureStore, StoredEntry } from '@bugsee/core';
import type { FileType } from '@bugsee/protocol';
import type { HostBridge } from './host-bridge';
import { encode, entryMessage } from './protocol';

// The `CaptureStore` swap that makes the WebView SDK a pure streaming source (docs/design/webview-bridge.md §5).
// The capture aggregator calls `add(record)` for every serialized capture entry; instead of buffering into a
// local rolling ring (browser/node) we serialize it to an `entry` envelope and post it across the WebView
// boundary IMMEDIATELY — NATIVE is the ring buffer + the bundler. So there is no local export: `snapshot()`
// returns an empty, releasable view (the report path drains nothing locally), and `tick()`/`clear()` are no-ops
// (native owns the rolling window). `add` is fire-and-forget — `bridge.post` never throws, and the envelope is
// all primitives + the entry's already-serialized payload string, so serialization never throws the hot path.

export interface HostBridgeCaptureStoreOptions {
  /** The JS→native channel each entry is posted to. */
  bridge: HostBridge;
  /** `performance.now()` source for the per-entry monotonic stamp. Default the ambient `performance`. */
  now?: () => number;
  /** `performance.timeOrigin` for native time-base mapping. Default the ambient `performance`. */
  timeOrigin?: number;
  /** Monotonic-sequence source (shared with the report path so seq is per-session global). Default internal. */
  seq?: () => number;
  /** Whether capture forwarding is paused (native pause/resume — backgrounded WebView). Default never. */
  paused?: () => boolean;
}

/** An empty snapshot — the WebView SDK never assembles a local bundle (D2); native does. */
function emptySnapshot(): CaptureSnapshot {
  return {
    async *stream(): AsyncIterableIterator<StoredEntry> {
      // no local records — native owns the buffer (intentionally yields nothing)
    },
    drainAll(): Promise<Map<FileType, StoredEntry[]>> {
      return Promise.resolve(new Map());
    },
    release(): void {
      // nothing to free
    },
  };
}

/** Build the streaming capture store that posts every entry across the WebView boundary. */
export function createHostBridgeCaptureStore(opts: HostBridgeCaptureStoreOptions): CaptureStore {
  const { bridge } = opts;
  const now = opts.now ?? ((): number => performance.now());
  const timeOrigin = opts.timeOrigin ?? performance.timeOrigin;
  let internal = 0;
  const nextSeq = opts.seq ?? ((): number => internal++);
  const paused = opts.paused ?? ((): boolean => false);

  return {
    add(record: StoredEntry): void {
      // While paused (the WebView is backgrounded/offscreen) drop the capture stream — no bridge crossings.
      // Incidents are NOT affected (the report path is separate), so a crash while backgrounded still reports.
      if (paused()) {
        return;
      }
      bridge.post(
        encode(
          entryMessage({
            type: record.type,
            seq: nextSeq(),
            timestamp: record.timestamp,
            mono: now(),
            timeOrigin,
            payload: record.serialized,
            // D3/slice-5: real redaction provenance wires in later; un-redacted by default (native redacts).
            redacted: false,
          }),
        ),
      );
    },
    tick(): void {
      // No-op: native owns the rolling window (no local parts to rotate/evict).
    },
    snapshot(): CaptureSnapshot {
      return emptySnapshot();
    },
    clear(): void {
      // No-op: nothing is buffered locally.
    },
  };
}
