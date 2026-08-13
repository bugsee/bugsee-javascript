import type { HostBridge } from './host-bridge';
import {
  type ComposerDocument,
  type ComposerWindow,
  createObscuringComposer,
} from './obscuring-composer';
import {
  collectSecureAreas,
  FAIL_CLOSED_AREA,
  type MutationObserverCtor,
} from './obscuring-source';
import { encode, type SecureArea, secureMessage } from './protocol';

// The obscuring CHANNEL — the TOP frame's native I/O for obscuring. It owns
// a top-frame obscuring COMPOSER (which tracks this frame's secure rects AND folds in the rects bubbled up from
// sub-frames, mapped into document-absolute coordinates) and on every change posts a `secure` envelope so native
// can keep its whole-page mask current; it also answers native's SYNCHRONOUS pull (`__bugsee_bridge.snapshot()`,
// called at frame-capture time) with the serialized rects, and the `snapshot` control COMMAND by re-posting them.
// Declaring the `obscuring` capability tells native this SDK contributes rects; native ADDS them to its own
// mask and never stands that mask down for the claim (D-A7) — so this channel is what makes the advanced SDK
// carry its own weight on masking, not what licenses native to stop. Time/seq frame mirrors the
// report path (Date.now / performance.now / performance.timeOrigin), seq shared so it orders with the stream.

export interface ObscuringChannel {
  /** Begin change-tracking; a secure post is emitted on every change. */
  start(): void;
  /** Stop tracking + detach. */
  stop(): void;
  /** Post the current secure-area rects (the native `snapshot` control command path). */
  emit(): void;
  /** The serialized current rects, returned synchronously to native via `__bugsee_bridge.snapshot()`.
   *  NEVER throws — an exception here would surface inside native's `evaluateJavascript` at frame-capture
   *  time — and on the advanced path this is the ONLY in-WebView mask source, so a throw here masks nothing. */
  snapshot(): string;
  /**
   * Whether obscuring can actually collect rects right now.
   *
   * Gates the `obscuring` capability in the hello: declaring it tells native this SDK supplies the rects, and
   * the protocol has no way to retract the claim afterwards (docs/review/webview.md
   * SEV1 #2). On a page where collection already fails, not declaring it leaves native's legacy masking in
   * place — which is the fail-closed answer.
   */
  probe(): boolean;
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
  /** Where an obscuring failure is reported. Without it the fail-closed downgrade is silent. */
  onError?: (error: unknown) => void;
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
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  // Every method here is a boundary the host (or native) calls directly, so none may throw outward. The
  // composer already fails closed on collection; this guards the remaining surface — serialization, and the
  // start/stop/emit lifecycle — so an obscuring fault can never become an application-visible exception.
  //
  // The `snapshot` guard is deliberate defense-in-depth and is NOT observable from a test: the composer
  // beneath it already answers a failure with the fail-closed rect, and `JSON.stringify` of a rect array
  // cannot throw. It stays because this is the one function whose exception would land inside native's
  // `evaluateJavascript` at frame-capture time — a mutation removing it surviving is expected, not a gap.
  const guard = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      opts.onError?.(error);
      return fallback;
    }
  };

  return {
    start: () => guard(() => composer.start(), undefined),
    stop: () => guard(() => composer.stop(), undefined),
    emit: () => guard(() => composer.refresh(), undefined), // the native `snapshot` command re-posts rects
    snapshot: () =>
      guard(() => JSON.stringify(composer.snapshot()), JSON.stringify([FAIL_CLOSED_AREA])),
    probe: () =>
      guard(() => {
        collectSecureAreas(opts.document, {
          onError: (error) => {
            throw error; // surface it here so `guard` answers false rather than swallowing it
          },
        });
        return true;
      }, false),
  };
}
