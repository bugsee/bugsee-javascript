import type { HostBridge } from './host-bridge';
import {
  type ComposerDocument,
  type ComposerWindow,
  createObscuringComposer,
} from './obscuring-composer';
import type { MutationObserverCtor } from './obscuring-source';
import { encode, type SecureArea, secureMessage } from './protocol';

// The obscuring CHANNEL (docs/design/webview-bridge.md D10) — the TOP frame's native I/O for obscuring. It owns
// a top-frame obscuring COMPOSER (which tracks this frame's secure rects AND folds in the rects bubbled up from
// sub-frames, mapped into document-absolute coordinates) and on every change posts a `secure` envelope so native
// can keep its whole-page mask current; it also answers native's SYNCHRONOUS pull (`__bugsee_bridge.snapshot()`,
// called at frame-capture time) with the serialized rects, and the `snapshot` control COMMAND by re-posting them.
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
  /** The DOM document the secure areas (+ child `<iframe>`s) are read from. */
  document: ComposerDocument;
  /** Window for scroll/resize/orientation + cross-frame bubbles (optional — focus/blur still work without). */
  window?: ComposerWindow;
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

  // The TOP-frame composer: own areas + sub-frame bubbles → document-absolute → posted via `post`.
  const composer = createObscuringComposer({
    document: opts.document,
    ...(opts.window !== undefined ? { window: opts.window } : {}),
    isTopFrame: true,
    onCompose: post,
    ...(opts.mutationObserver !== undefined ? { mutationObserver: opts.mutationObserver } : {}),
  });

  return {
    start: () => composer.start(),
    stop: () => composer.stop(),
    emit: () => composer.refresh(), // the native `snapshot` command re-posts the current composed rects
    snapshot: () => JSON.stringify(composer.snapshot()),
  };
}
