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

  // Re-resolve on every post: native may register the interface after the script starts, and a Java
  // @JavascriptInterface is a host object (call `.post` with it as receiver).
  const resolve = (): { post(raw: string): void } | undefined => {
    const b = global.BugseeBridge;
    return typeof b?.post === 'function' ? (b as { post(raw: string): void }) : undefined;
  };

  const send = (sink: { post(raw: string): void }, raw: string): void => {
    try {
      sink.post(raw);
    } catch (error) {
      onError(error);
    }
  };

  return {
    get available(): boolean {
      return resolve() !== undefined;
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
