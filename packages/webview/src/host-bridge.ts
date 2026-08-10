// The JS→native channel across the WebView boundary (docs/design/webview-bridge.md §6.2/§9). Android-first: the
// native SDK registers an `@JavascriptInterface` object `window.BugseeBridge` whose `post(raw)` receives each
// wire string. The bridge is usually attached before the page script runs (native calls addJavascriptInterface
// on the WebView first), but to be robust it tolerates a not-yet-attached window: it BUFFERS (a bounded FIFO
// ring — the richer analog of the legacy 50-entry network-only fallback) and flushes the backlog the moment the
// bridge appears. A native `post` failure routes to onError and NEVER throws into the embedded app (capture must
// not alter app behavior). The WebMessageChannel (API 26+) fallback is a follow-up; this is the primary path.

/** The default JS→native send buffer size (messages held while the bridge is not yet attached). */
export const DEFAULT_MAX_BUFFER = 256;

/** The JS→native channel: post a wire string; never throws. */
export interface HostBridge {
  /** Whether the native bridge is currently attached (`window.BugseeBridge.post` present). */
  readonly available: boolean;
  /** Post a wire message across the boundary (buffered if the bridge is not yet attached). */
  post(raw: string): void;
}

interface AndroidBridgeGlobal {
  BugseeBridge?: { post?: (raw: string) => void };
}

/** Build the host bridge over a global (default `globalThis`); buffers until the native bridge attaches. */
export function createHostBridge(opts?: {
  global?: object;
  maxBuffer?: number;
  onError?: (error: unknown) => void;
}): HostBridge {
  const global = (opts?.global ?? globalThis) as AndroidBridgeGlobal;
  const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const onError = opts?.onError ?? ((): void => {});
  const buffer: string[] = [];

  // PINNED on first resolve (Wave 0.3 / D-A4, docs/design/webview-bridge-auth.md).
  //
  // This used to re-read `global.BugseeBridge` on every post, so any script loading after the SDK could
  // assign its own `{post}` and receive the whole capture stream — logs, request URLs, bodies — while the
  // SDK kept working. JS-side redaction is off by default (native re-redacts on receipt), so what a tap
  // reads is un-redacted.
  //
  // Resolution stays LAZY because the original reason for it is real: native may register the interface
  // after this script starts. So we look until we find one, pin it, and never look again — a later swap of
  // the page global is simply not observed, and traffic keeps flowing to the real native sink.
  //
  // Deliberately NOT reported when a swap happens: detecting it costs a global read per post to surface an
  // event the SDK cannot act on, and a page could trigger it at will to flood `onError`.
  //
  // What is pinned is the BOUND METHOD, not the object (review round 1). Holding the object still read
  // `sink.post` on every send, so `window.BugseeBridge.post = evil` — a property write that never touches
  // the binding pinning watches — rerouted the whole capture stream. Binding captures the receiver too,
  // which is what a Java `@JavascriptInterface` host object needs.
  let pinned: ((raw: string) => void) | undefined;
  const resolve = (): ((raw: string) => void) | undefined => {
    if (pinned !== undefined) {
      return pinned;
    }
    const b = global.BugseeBridge;
    // Only a usable sink is pinned. Pinning a malformed one would be worse than re-resolving: the SDK could
    // never reach a bridge that attached correctly afterwards.
    if (typeof b?.post !== 'function') {
      return undefined;
    }
    pinned = b.post.bind(b);
    return pinned;
  };

  const send = (sink: (raw: string) => void, raw: string): void => {
    try {
      sink(raw);
    } catch (error) {
      onError(error);
    }
  };

  return {
    // A PURE read (review round 1): this used to call `resolve()`, so merely asking "is the bridge there?"
    // pinned the sink as a side effect. A getter that mutates is a trap for any future caller, and it made
    // the pin happen at an arbitrary read rather than at the first message.
    get available(): boolean {
      return pinned !== undefined || typeof global.BugseeBridge?.post === 'function';
    },
    post(raw: string): void {
      const sink = resolve();
      if (sink === undefined) {
        buffer.push(raw);
        if (buffer.length > maxBuffer) {
          buffer.shift(); // bounded ring — evict the oldest
        }
        return;
      }
      // The bridge is attached: drain any backlog (oldest-first) before the new message.
      while (buffer.length > 0) {
        send(sink, buffer.shift() as string);
      }
      send(sink, raw);
    },
  };
}
