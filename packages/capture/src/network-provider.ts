import { type CaptureProvider, CaptureProviderBase, type EventSubscribable } from '@bugsee/core';
import { type NetworkEvent, type NetworkStage, sanitizeHeaders } from '@bugsee/protocol';

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
  readonly controllingOption = 'captureNetwork';
  readonly #sources: readonly NetworkSource[];
  #offs: Array<() => void> = [];

  constructor(sources: readonly NetworkSource[]) {
    super();
    this.#sources = sources;
  }

  protected onStart(): void {
    this.#offs = this.#sources.map((source) =>
      source.onAny((_stage, event) => {
        this.capture('network', event.timestamp, sanitize(event));
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
