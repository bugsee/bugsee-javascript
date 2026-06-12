import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import type { NetworkSource } from './network-provider';
import type { RequestDecoratable, RequestDecorator } from './request-decorator';

const isDecoratable = (source: NetworkSource): source is NetworkSource & RequestDecoratable =>
  typeof (source as Partial<RequestDecoratable>).addRequestDecorator === 'function';

// Umbrella network SOURCE (design §16): a composite interceptor that aggregates the per-mechanism
// network interceptors (fetch/xhr/ws/sse/webtransport) into ONE subscribable stream — so a consumer
// (the networkProvider, APM, user code) subscribes ONCE for ALL network events instead of to N
// sources. Each NetworkEvent carries a unique id + sequence, so a subscriber can still pick out a
// specific request/connection or correlate its before/complete/error events.
//
// It is itself listenable (InterceptorBase): on activate it subscribes (onAny) to each sub-source and
// re-emits their events; on deactivate it unsubscribes. Because subscribing drives a sub's
// subscriber-presence activation, subscribing to the umbrella transitively activates every sub (and
// the last unsubscribe deactivates them) — one subscription point with a full activation cascade.

class NetworkInterceptor
  extends InterceptorBase<Record<NetworkStage, NetworkEvent>>
  implements RequestDecoratable
{
  readonly name = 'network';
  readonly #sources: readonly NetworkSource[];
  #offs: Array<() => void> = [];

  constructor(sources: readonly NetworkSource[]) {
    super();
    this.#sources = sources;
  }

  /** Register a request decorator on every request-sending leaf (fetch/xhr); returns a combined
   *  unsubscribe. Leaves that don't send decoratable requests (ws/sse/webtransport) are skipped. */
  addRequestDecorator(decorator: RequestDecorator): () => void {
    const offs = this.#sources
      .filter(isDecoratable)
      .map((source) => source.addRequestDecorator(decorator));
    return () => {
      for (const off of offs) {
        off();
      }
    };
  }

  protected onActivate(): void {
    this.#offs = this.#sources.map((source) =>
      source.onAny((stage, event) => {
        this.emit(stage, event);
      }),
    );
  }

  protected override onDeactivate(): void {
    for (const off of this.#offs) {
      off();
    }
    this.#offs = [];
  }
}

export function createNetworkInterceptor(
  ...sources: NetworkSource[]
): Interceptor<Record<NetworkStage, NetworkEvent>> & RequestDecoratable {
  return new NetworkInterceptor(sources);
}
