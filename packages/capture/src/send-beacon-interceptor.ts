import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { readSyncRequestBody } from './network-body';

// navigator.sendBeacon capture SOURCE (design §16.2; the mechanism the wire has declared since
// [wire.ts NetworkMechanism] but nothing implemented). sendBeacon is the standard way an application
// ships telemetry from `pagehide`/`visibilitychange`, so leaving it uninstrumented was not only a blind
// spot in the recording: beacon traffic bypassed the user network filter AND the built-in PII sanitizer,
// both of which live in the networkProvider that consumes THIS emitter.
//
// sendBeacon lives on `navigator` (browser / dedicated + shared workers), so the wrap installs only
// when it exists — on node/edge/service-workers onActivate is a no-op, exactly like the XHR and
// EventSource siblings. Wrapping is a swap of `navigator.sendBeacon`; the original is put back on
// deactivate. Installed only while ACTIVE (subscriber-presence / start, via InterceptorBase).
//
// Stages (wire contract §8.7 for request/response transports): `before` → `complete`. sendBeacon
// returns a boolean SYNCHRONOUSLY — the user agent queued the payload, or refused it — and has no
// response at all: no status, no status text, no response headers, and no way to learn the outcome of
// the transmission. So `complete` deliberately carries NO `status`: a refusal is not an HTTP failure
// and inventing a code (0 / 4xx) would make the entry lie. A refusal is recorded as a terminal
// `complete` carrying `customError`/`custom.error` instead. `error` is emitted only when sendBeacon
// itself THROWS (an invalid URL is a TypeError), which would otherwise leave `before` dangling with no
// terminal event; the application's error is then rethrown untouched.
//
// Request BODIES are read synchronously via the shared reader (string / URLSearchParams), so the same
// body POLICY as every other transport applies downstream: the master toggle, the size limit and the
// allow-without-Content-Type rule are the networkProvider's `#gateBody`, which sees this emitter's raw
// events like any other source. Payloads that are not synchronously readable (Blob / FormData / binary)
// are reported with the existing `cant_read_data` reason rather than blocked on or guessed at.
//
// `size` is intentionally not set — no interceptor in this SDK sets it (docs/design/
// viewer-wire-compatibility.md §3.5), and the viewer derives it from the body when present.

/** `navigator.sendBeacon` — a DOM global this package carries no lib types for, so reach it via casts. */
type SendBeaconFn = (url: unknown, data?: unknown) => boolean;
type NavigatorLike = { sendBeacon?: SendBeaconFn };

/** A read/replace handle for the sendBeacon being wrapped — `navigator`'s by default, or a custom impl. */
export interface SendBeaconTarget {
  get(): SendBeaconFn | undefined;
  set(sendBeacon: SendBeaconFn): void;
}

const globalSendBeaconTarget: SendBeaconTarget = {
  get: () => (globalThis as unknown as { navigator?: NavigatorLike }).navigator?.sendBeacon,
  // Only ever reached after `get()` returned a function, so `navigator` is known to exist.
  set: (sendBeacon) => {
    (globalThis as unknown as { navigator: NavigatorLike }).navigator.sendBeacon = sendBeacon;
  },
};

/** Default self-isolation: skip the SDK's own outbound requests, tagged X-Bugsee-Internal (§14.6).
 *  A beacon carries no caller headers, so this default never fires in practice — the seam exists so a
 *  platform can self-isolate its own beacons by URL. */
const hasInternalHeader = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === 'x-bugsee-internal');

/**
 * The Content-Type a Blob payload puts on the wire. sendBeacon sends a Blob's own `type` as the
 * request's Content-Type; the DATA is readable only asynchronously (→ `cant_read_data`), but `type` is
 * a plain string property, so the captured headers can still be truthful about what was sent — and the
 * downstream Content-Type gate keeps working. A Blob with no type sends none.
 */
const blobContentType = (data: unknown): string | undefined => {
  if (data === null || typeof data !== 'object') {
    return undefined;
  }
  const type = (data as { type?: unknown }).type;
  return typeof type === 'string' && type !== '' ? type : undefined;
};

/** What the user agent tells us about a refused beacon: only that it was not queued. */
const REFUSED = 'sendBeacon refused: payload not queued (over the user agent quota)';

interface BeaconState {
  id: string;
  url: string;
  startedAt: number;
}

export interface SendBeaconInterceptorOptions {
  /** Wall-clock source; injectable for tests. Default Date.now. */
  now?: () => number;
  /** Per-beacon id (shared by its before/complete/error events). Default a counter. */
  newId?: () => string;
  /** Returns true to SKIP capturing a beacon (SDK self-isolation). Default: X-Bugsee-Internal header. */
  isInternal?: (url: string, requestHeaders: Record<string, string>) => boolean;
  /** Where to read/replace the wrapped sendBeacon — `navigator`'s by default, or a custom impl. */
  target?: SendBeaconTarget;
}

class SendBeaconInterceptor extends InterceptorBase<Record<NetworkStage, NetworkEvent>> {
  readonly name = 'sendbeacon';
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #isInternal: (url: string, headers: Record<string, string>) => boolean;
  readonly #target: SendBeaconTarget;
  #original: SendBeaconFn | null = null;
  #counter = 0;

  constructor(options: SendBeaconInterceptorOptions = {}) {
    super();
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => {
        this.#counter += 1;
        return `b${this.#counter}`;
      });
    this.#isInternal = options.isInternal ?? ((_url, headers) => hasInternalHeader(headers));
    this.#target = options.target ?? globalSendBeaconTarget;
  }

  protected onActivate(): void {
    const original = this.#target.get();
    if (typeof original !== 'function') {
      return; // no navigator.sendBeacon in this runtime / target
    }
    this.#original = original;
    this.#target.set(this.#wrap(original));
  }

  protected override onDeactivate(): void {
    if (this.#original !== null) {
      this.#target.set(this.#original);
      this.#original = null;
    }
  }

  /**
   * Run a capture step, swallowing anything it throws.
   *
   * "Interceptors must not alter app behavior" is binding everywhere, and a beacon is the sharpest case
   * of it: it is the application's LAST chance to ship data before the page dies, and its whole contract
   * is one synchronous boolean. Whatever capture does — a thrown clock, a thrown id factory, a hostile
   * body — the beacon must still be handed to the user agent and its verdict returned verbatim.
   */
  #safe(step: () => void): void {
    try {
      step();
    } catch {
      /* capture is best-effort; the application's beacon is not */
    }
  }

  #wrap(original: SendBeaconFn): SendBeaconFn {
    const self = this;
    return function (this: unknown, url: unknown, data?: unknown): boolean {
      let state: BeaconState | undefined;
      self.#safe(() => {
        state = self.#emitBefore(url, data);
      });
      let queued: boolean;
      try {
        // `apply(this, …)` keeps the receiver: a real `navigator.sendBeacon` throws "Illegal invocation"
        // when called unbound, and a caller may legitimately invoke it on any navigator.
        queued = original.apply(this, [url, data]);
      } catch (error) {
        self.#safe(() => self.#emitError(state, error));
        throw error; // the application's own error — propagated untouched
      }
      self.#safe(() => self.#emitComplete(state, queued));
      return queued; // the user agent's verdict, verbatim
    };
  }

  #emitBefore(url: unknown, data: unknown): BeaconState | undefined {
    const href = String(url);
    // The body reader never consumes the payload: a string is taken verbatim and URLSearchParams is
    // serialized (each with the Content-Type the runtime implies on the wire); anything else — Blob,
    // FormData, ArrayBuffer, a typed array — is not synchronously readable → `cant_read_data`.
    const body = readSyncRequestBody(data);
    const contentType = body.contentType ?? blobContentType(data);
    const headers: Record<string, string> =
      contentType === undefined ? {} : { 'content-type': contentType };
    if (this.#isInternal(href, headers)) {
      return undefined; // the SDK's own traffic — not captured (the beacon itself is untouched)
    }
    const state: BeaconState = { id: this.#newId(), url: href, startedAt: this.#now() };
    this.emit('before', {
      timestamp: state.startedAt,
      id: state.id,
      sequence: state.id,
      mechanism: 'sendBeacon',
      url: state.url,
      method: 'POST', // sendBeacon always POSTs
      type: 'before',
      custom: {
        headers,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.reason !== undefined ? { no_body_reason: body.reason } : {}),
      },
    });
    return state;
  }

  #emitComplete(state: BeaconState | undefined, queued: boolean): void {
    if (state === undefined) {
      return; // never captured (internal, or the before stage failed) → no terminal event either
    }
    // One clock read: the event's timestamp and the duration it implies must agree.
    const at = this.#now();
    this.emit('complete', {
      timestamp: at,
      id: state.id,
      sequence: state.id,
      mechanism: 'sendBeacon',
      url: state.url,
      method: 'POST',
      type: 'complete',
      // No status: a beacon has no response, and a refusal is not an HTTP failure (see the header note).
      ...(queued ? {} : { customError: REFUSED }),
      custom: {
        timings: { duration: at - state.startedAt },
        ...(queued ? {} : { error: REFUSED }),
      },
    });
  }

  #emitError(state: BeaconState | undefined, error: unknown): void {
    if (state === undefined) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.emit('error', {
      timestamp: this.#now(),
      id: state.id,
      sequence: state.id,
      mechanism: 'sendBeacon',
      url: state.url,
      method: 'POST',
      type: 'error',
      customError: message,
      custom: { error: message },
    });
  }
}

export function createSendBeaconInterceptor(
  options?: SendBeaconInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new SendBeaconInterceptor(options);
}
