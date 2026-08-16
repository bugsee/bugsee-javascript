// The JS→native channel across the WebView boundary (docs/design/webview-bridge.md §6.2/§9). Two host shapes
// are supported, under the same interface name and the same wire: Android registers an `@JavascriptInterface`
// object `window.BugseeBridge` whose `post(raw)` receives each wire string; iOS registers a
// `WKScriptMessageHandler` reached at `window.webkit.messageHandlers.BugseeBridge.postMessage(raw)`. The bridge
// is usually attached before the page script runs (native registers it on the WebView/configuration first), but
// to be robust it tolerates a not-yet-attached window: it BUFFERS (a bounded FIFO ring — the richer analog of
// the legacy 50-entry network-only fallback) and flushes the backlog the moment the bridge appears. A native
// send failure routes to onError and NEVER throws into the embedded app (capture must not alter app behavior).
// The WebMessageChannel (API 26+) fallback is a follow-up; this is the primary path.

/** The default JS→native send buffer size (messages held while the bridge is not yet attached). */
export const DEFAULT_MAX_BUFFER = 256;

// Pinned at module scope, before page script can run: a page that replaces `JSON.stringify` would
// otherwise control how the nonce is serialized on every message we send.
const jsonStringify = JSON.stringify;

/** The JS→native channel: post a wire string; never throws. */
export interface HostBridge {
  /** Whether the native bridge is currently attached (`window.BugseeBridge.post` present). */
  readonly available: boolean;
  /** Post a wire message across the boundary (buffered if the bridge is not yet attached). */
  post(raw: string): void;
}

/**
 * The two shapes a native host can expose, under the SAME name so the wire and the auth are identical:
 * - Android registers an `@JavascriptInterface` object as `window.BugseeBridge`, called via `post(raw)`.
 * - iOS registers a `WKScriptMessageHandler`, reached at
 *   `window.webkit.messageHandlers.BugseeBridge.postMessage(raw)`.
 *
 * Only the call shape differs; the envelope, the capture nonce and the pinning discipline are shared. Note
 * neither is the legacy `BugseeJsListener` handler — that speaks the old protocol and coexists with this one.
 */
interface HostBridgeGlobal {
  BugseeBridge?: { post?: (raw: string) => void };
  webkit?: { messageHandlers?: { BugseeBridge?: { postMessage?: (raw: string) => void } } };
}

/** Build the host bridge over a global (default `globalThis`); buffers until the native bridge attaches. */
export function createHostBridge(opts?: {
  global?: object;
  maxBuffer?: number;
  onError?: (error: unknown) => void;
  /**
   * The native-minted CAPTURE nonce (D-A11 — a different secret from the D-A10 control nonce), stamped as `n` on every outgoing message so native can tell this SDK's
   * traffic from a page script's (D-A11).
   *
   * Without it native cannot: `BugseeBridge.post` is reachable from every frame, so any script can inject
   * fabricated `log`/`network`/`events`/`traces`/`breadcrumbs` entries into the customer's session — and
   * with no rate limit, can loop until the ring buffer evicts the real capture of the bug being reported.
   * Omitted → the previous wire bytes exactly, for hosts that mint no nonce.
   */
  nonce?: string;
}): HostBridge {
  const global = (opts?.global ?? globalThis) as HostBridgeGlobal;
  const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const onError = opts?.onError ?? ((): void => {});
  const nonce = opts?.nonce;
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

  /**
   * Find a USABLE sink, without pinning. Android is checked first purely so resolution is deterministic
   * rather than dependent on property order — no realm exposes both in practice, and a page that plants the
   * other one must not be able to influence which is chosen.
   *
   * "Usable" is load-bearing in that ordering: falling through a malformed `BugseeBridge` is what stops
   * `window.BugseeBridge = {}` from SHADOWING a real WebKit handler, which would hand the page a
   * denial-of-capture primitive. It is also why a malformed sink is never pinned at all — the SDK could then
   * never reach a bridge that attached correctly afterwards, which is worse than re-resolving.
   */
  const findSink = (): ((raw: string) => void) | undefined => {
    const android = global.BugseeBridge;
    if (typeof android?.post === 'function') {
      // Bound, not bare: a Java @JavascriptInterface is a host object and needs its receiver.
      return android.post.bind(android);
    }
    const webkit = global.webkit?.messageHandlers?.BugseeBridge;
    if (typeof webkit?.postMessage === 'function') {
      // Same on iOS — `webkit.messageHandlers.X` is a host object; an unbound `postMessage` throws.
      return webkit.postMessage.bind(webkit);
    }
    return undefined;
  };

  const resolve = (): ((raw: string) => void) | undefined => {
    if (pinned !== undefined) {
      return pinned;
    }
    pinned = findSink();
    return pinned;
  };

  /**
   * Splice the nonce in as the first member. Done HERE — the one place every message leaves through,
   * buffered or direct — rather than at each `encode` call site, so a new sender cannot forget it and have
   * its traffic silently dropped by native as forged.
   *
   * The guard on `{"b":` is what keeps this a safe string operation: every encoded envelope starts that way
   * (see `encode`), so there is always a member to precede. Anything else is passed through untouched
   * rather than corrupted into `{"n":"…",}`.
   */
  const stamp = (raw: string): string =>
    nonce === undefined || !raw.startsWith('{"b":')
      ? raw
      : `{"n":${jsonStringify(nonce)},${raw.slice(1)}`;

  const send = (sink: (raw: string) => void, raw: string): void => {
    try {
      sink(stamp(raw));
    } catch (error) {
      onError(error);
    }
  };

  return {
    // A PURE read (review round 1): this used to call `resolve()`, so merely asking "is the bridge there?"
    // pinned the sink as a side effect. A getter that mutates is a trap for any future caller, and it made
    // the pin happen at an arbitrary read rather than at the first message.
    get available(): boolean {
      return pinned !== undefined || findSink() !== undefined;
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
