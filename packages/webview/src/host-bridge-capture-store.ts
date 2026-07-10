import { type CaptureStore, createStreamingCaptureStore } from '@bugsee/core';
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
  /** D3 redaction provenance: did a JS-side filter run on an entry of this type? Stamped as `red`. Default no. */
  redactedFor?: (type: FileType) => boolean;
}

/** Build the streaming capture store that posts every entry across the WebView boundary. Delegates the
 *  store logic to core's transport-agnostic `createStreamingCaptureStore`; the WebView specifics are the
 *  bridge sink + the WebView wire codec (`encode(entryMessage(...))`). */
export function createHostBridgeCaptureStore(opts: HostBridgeCaptureStoreOptions): CaptureStore {
  const { bridge } = opts;
  return createStreamingCaptureStore({
    post: (raw) => bridge.post(raw),
    // D3 provenance (`redacted`) is carried through by the core store per the injected redactedFor.
    encodeEntry: (e) => encode(entryMessage(e)),
    now: opts.now,
    timeOrigin: opts.timeOrigin,
    seq: opts.seq,
    paused: opts.paused,
    redactedFor: opts.redactedFor,
  });
}
