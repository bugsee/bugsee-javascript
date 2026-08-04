import {
  type CaptureProvider,
  CaptureProviderBase,
  type EventSubscribable,
  getFilters,
  type OptionsContainer,
  runFilter,
} from '@bugsee/core';
import {
  BugseeOption,
  contentTypeOf,
  gateNetworkBody,
  type NetworkEvent,
  type NetworkStage,
  sanitizeBody,
  sanitizeErrorMessage,
  sanitizeHeaders,
  sanitizeUrl,
} from '@bugsee/protocol';

// Runtime-agnostic network capture CONSUMER (design §16.1): subscribes to one or more network SOURCES
// (the fetch interceptor, and later xhr/ws/webtransport/sse) and routes every NetworkEvent — at any
// stage — to the aggregator as a `network` entry. ONE provider serves all transports because they all
// emit the same NetworkEvent shape; only the sources vary. Subscribing drives each source's
// subscriber-presence activation (the interceptor installs its hook while the provider is started).

/** A network source — any emitter exposing NetworkStage channels (e.g. the fetch interceptor). */
export type NetworkSource = EventSubscribable<Record<NetworkStage, NetworkEvent>>;

// Per-event default PII redaction (§8.10, [R:wire m9]): redact the URL (sensitive query/fragment params
// and any `user:pass@` credential), the sensitive request/response headers, and the captured body by
// Content-Type (JSON key denylist, else form/colon key redaction plus a shape pass). Non-mutating (the hub
// event other subscribers see stays raw); returns the same event when there is nothing to redact.
//
// The URL is handled FIRST and OUTSIDE the `custom` guard: ws/sse/webtransport events carry no headers or
// body, so an early return on `custom === undefined` would ship `wss://…?token=…` verbatim. This provider
// is the single redaction point for every transport — including node:http, which folds in through
// `installNetworkCapture({ additionalSources })` — so a URL not scrubbed here is not scrubbed anywhere
// (docs/review/capture.md SEV1 #4, docs/review/node-B-http-server.md SEV1 #3).
/** Optional free text: sanitized when present, passed through untouched (and identity-preserving) when not,
 *  so the unchanged-checks below still short-circuit on an event that carried none of these fields. */
const sanitizeText = (value: string | undefined): string | undefined =>
  typeof value === 'string' ? sanitizeErrorMessage(value) : value;

const sanitize = (event: NetworkEvent): NetworkEvent => {
  // Guarded like its three siblings (`customError`, `custom.body`, `custom.error`). `url` was the one
  // field with no `typeof` check, so a producer emitting a non-string would throw here and the emitter
  // would silently delete the entry. No producer does today — every interceptor coerces — but discovering
  // that through a vanished report is the wrong way to find out.
  const url = typeof event.url === 'string' ? sanitizeUrl(event.url) : event.url;
  // The three free-text fields the SERVER fills in. `statusText` is the HTTP reason phrase, `reason` is the
  // WebSocket/WebTransport close reason (`close(4001, 'invalid token …')` is idiomatic), `channel` is the
  // SSE event name. All three were copied through untouched — under a comment calling this the single
  // redaction point for every transport — because the field list was written from the fields that HAD
  // secrets in the review that prompted it, not from the event shape.
  const statusText = sanitizeText(event.statusText);
  const reason = sanitizeText(event.reason);
  const channel = sanitizeText(event.channel);
  // The failure message quotes the URL back on most transports, so redacting `url` alone leaves the same
  // secret one field over — proven by the privacy e2e with the url fix already in place.
  const customError =
    typeof event.customError === 'string'
      ? sanitizeErrorMessage(event.customError)
      : event.customError;
  const topUnchanged =
    url === event.url &&
    customError === event.customError &&
    statusText === event.statusText &&
    reason === event.reason &&
    channel === event.channel;
  const custom = event.custom;
  if (custom === undefined) {
    return topUnchanged ? event : { ...event, url, customError, statusText, reason, channel };
  }
  const headers = custom.headers === undefined ? custom.headers : sanitizeHeaders(custom.headers);
  // The content type is read off the SANITIZED headers, whose values are coerced to strings. Reading it
  // off `custom.headers` meant a `Content-Type: 42` reached `sanitizeBody` as a number and threw on
  // `.toLowerCase()` — the emitter swallowed it and the entire entry vanished. That is precisely the
  // failure the header coercion was added to eliminate, re-entered one line later by the raw accessor.
  const body =
    typeof custom.body === 'string'
      ? sanitizeBody(custom.body, contentTypeOf(headers))
      : custom.body;
  const error =
    typeof custom.error === 'string' ? sanitizeErrorMessage(custom.error) : custom.error;
  if (
    topUnchanged &&
    headers === custom.headers &&
    body === custom.body &&
    error === custom.error
  ) {
    return event;
  }
  return {
    ...event,
    url,
    customError,
    statusText,
    reason,
    channel,
    custom: { ...custom, headers, body, error },
  };
};

class NetworkCaptureProvider extends CaptureProviderBase {
  readonly name = 'network';
  readonly controllingOption = BugseeOption.CaptureNetwork;
  readonly #sources: readonly NetworkSource[];
  #offs: Array<() => void> = [];
  #sanitizeDefault = true;
  #captureBodies = true;
  #maxBodyBytes = 20480;
  #captureBodyWithoutType = false;

  constructor(sources: readonly NetworkSource[]) {
    super();
    this.#sources = sources;
  }

  // Apply the body capture POLICY before redaction/filtering (Android applyBodyFilters order): the
  // master toggle strips any captured body (a config choice — no per-request reason); otherwise the
  // size + Content-Type gate may drop it with a `no_body_reason`. Non-mutating.
  #gateBody(event: NetworkEvent): NetworkEvent {
    if (!this.#captureBodies) {
      if (event.custom?.body == null) {
        return event;
      }
      return { ...event, custom: { ...event.custom, body: null } };
    }
    return gateNetworkBody(event, {
      maxBytes: this.#maxBodyBytes,
      captureWithoutType: this.#captureBodyWithoutType,
    });
  }

  protected onStart(options: OptionsContainer): void {
    // The built-in PII sanitizer is gated by its option (default on); a user network filter supersedes
    // it entirely (Android XOR rule). The body policy (master toggle, size limit, allow-without-type)
    // is read once per launch and applied to every event before the filter/sanitizer XOR.
    this.#sanitizeDefault = options.get(BugseeOption.CaptureNetworkDefaultSanitizer, true);
    this.#captureBodies = options.get(BugseeOption.CaptureNetworkBodies, true);
    this.#maxBodyBytes = options.get(BugseeOption.CaptureNetworkBodySizeLimit, 20480);
    this.#captureBodyWithoutType = options.get(BugseeOption.CaptureNetworkBodyWithoutType, false);
    this.#offs = this.#sources.map((source) =>
      source.onAny((_stage, raw) => {
        // Gate the body first (always), then live per-event redaction: a user network filter (from the
        // carrier's client) REPLACES the default sanitizer; otherwise apply the default sanitizer when
        // enabled. A filter may DROP. The filter/sanitizer both see the already body-gated event.
        const event = this.#gateBody(raw);
        const filters = getFilters();
        if (filters?.network) {
          const out = runFilter(filters.network, event, filters.onError);
          if (out !== null) {
            this.capture('network', out.timestamp, out);
          }
        } else if (this.#sanitizeDefault) {
          this.capture('network', event.timestamp, sanitize(event));
        } else {
          this.capture('network', event.timestamp, event);
        }
      }),
    );
  }

  protected override onStop(): void {
    for (const off of this.#offs) {
      off();
    }
    this.#offs = [];
  }
}

/** The shared network capture provider: consumes network sources → `network` entries. Gated by `captureNetwork`. */
export function createNetworkCaptureProvider(...sources: NetworkSource[]): CaptureProvider {
  return new NetworkCaptureProvider(sources);
}
