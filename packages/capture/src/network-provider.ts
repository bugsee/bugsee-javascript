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
  type NetworkEvent,
  type NetworkStage,
  sanitizeHeaders,
} from '@bugsee/protocol';

// Runtime-agnostic network capture CONSUMER (design §16.1): subscribes to one or more network SOURCES
// (the fetch interceptor, and later xhr/ws/webtransport/sse) and routes every NetworkEvent — at any
// stage — to the aggregator as a `network` entry. ONE provider serves all transports because they all
// emit the same NetworkEvent shape; only the sources vary. Subscribing drives each source's
// subscriber-presence activation (the interceptor installs its hook while the provider is started).

/** A network source — any emitter exposing NetworkStage channels (e.g. the fetch interceptor). */
export type NetworkSource = EventSubscribable<Record<NetworkStage, NetworkEvent>>;

// Per-event header sanitization (§8.10, [R:wire m9]): redact sensitive request/response headers.
// Non-mutating (the hub event other subscribers see stays raw). Bodies are deferred (metadata-first).
const sanitize = (event: NetworkEvent): NetworkEvent => {
  if (event.custom?.headers === undefined) {
    return event;
  }
  return { ...event, custom: { ...event.custom, headers: sanitizeHeaders(event.custom.headers) } };
};

class NetworkCaptureProvider extends CaptureProviderBase {
  readonly name = 'network';
  readonly controllingOption = BugseeOption.CaptureNetwork;
  readonly #sources: readonly NetworkSource[];
  #offs: Array<() => void> = [];
  #sanitizeDefault = true;

  constructor(sources: readonly NetworkSource[]) {
    super();
    this.#sources = sources;
  }

  protected onStart(options: OptionsContainer): void {
    // The built-in PII sanitizer is gated by its option (default on); a user network filter supersedes
    // it entirely (Android XOR rule). Read once per launch.
    this.#sanitizeDefault = options.get(BugseeOption.CaptureNetworkDefaultSanitizer, true);
    this.#offs = this.#sources.map((source) =>
      source.onAny((_stage, event) => {
        // Live per-event redaction: a user network filter (from the carrier's client) REPLACES the
        // default sanitizer; otherwise apply the default sanitizer when enabled. A filter may DROP.
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
