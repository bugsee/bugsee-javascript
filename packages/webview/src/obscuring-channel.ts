import type { HostBridge } from './host-bridge';
import {
  createObscuringSource,
  type MutationObserverCtor,
  type SecureDocument,
  type SecureWindow,
} from './obscuring-source';
import { encode, type SecureArea, secureMessage } from './protocol';

// The obscuring CHANNEL (docs/design/webview-bridge.md D10) — wires the read-only obscuring SOURCE (which tracks
// the viewport rects of sensitive elements) to the native bridge. On every change it posts a `secure` envelope
// so native can keep its mask current; it also answers native's SYNCHRONOUS pull (`__bugsee_bridge.snapshot()`,
// called at frame-capture time) with the serialized rects, and the `snapshot` control COMMAND by posting them.
// Declaring the `obscuring` capability in the hello is what lets native skip its legacy masking script (D10) —
// so this channel is the piece that makes the advanced SDK a full replacement. Time/seq frame mirrors the
// report path (Date.now / performance.now / performance.timeOrigin), seq shared so it orders with the stream.

export interface ObscuringChannel {
  /** Begin change-tracking; a secure post is emitted on every change. */
  start(): void;
  /** Stop tracking + detach. */
  stop(): void;
  /** Post the current secure-area rects (the native `snapshot` control command path). */
  emit(): void;
  /** The serialized current rects, returned synchronously to native via `__bugsee_bridge.snapshot()`. */
  snapshot(): string;
}

export interface ObscuringChannelOptions {
  /** The JS→native channel. */
  bridge: HostBridge;
  /** The DOM document the secure areas are read from. */
  document: SecureDocument;
  /** Window for scroll/resize/orientation tracking (optional — focus/blur on the document still work without). */
  window?: SecureWindow;
  /** Monotonic-sequence source, SHARED with the capture store + report path. */
  seq: () => number;
  /** Wall-clock ms source. Default `Date.now`. */
  wallNow?: () => number;
  /** `performance.now()` source. Default the ambient `performance`. */
  now?: () => number;
  /** `performance.timeOrigin`. Default the ambient `performance`. */
  timeOrigin?: number;
  /** MutationObserver constructor; injectable for tests. Default `globalThis.MutationObserver`. */
  mutationObserver?: MutationObserverCtor;
}

/** Build the obscuring channel that streams secure-area rects to native. */
export function createObscuringChannel(opts: ObscuringChannelOptions): ObscuringChannel {
  const { bridge, seq } = opts;
  const wallNow = opts.wallNow ?? ((): number => Date.now());
  const now = opts.now ?? ((): number => performance.now());
  const timeOrigin = opts.timeOrigin ?? performance.timeOrigin;

  const post = (areas: readonly SecureArea[]): void => {
    bridge.post(
      encode(
        secureMessage({
          seq: seq(),
          timestamp: wallNow(),
          mono: now(),
          timeOrigin,
          payload: JSON.stringify(areas),
        }),
      ),
    );
  };

  const source = createObscuringSource({
    document: opts.document,
    ...(opts.window !== undefined ? { window: opts.window } : {}),
    onChange: post,
    ...(opts.mutationObserver !== undefined ? { mutationObserver: opts.mutationObserver } : {}),
  });

  return {
    start: () => source.start(),
    stop: () => source.stop(),
    emit: () => post(source.snapshot()),
    snapshot: () => JSON.stringify(source.snapshot()),
  };
}
