import type { Client, Interceptor } from './contracts';
import { MultiKeyEmitterBase } from './emitter';

// Base for interceptors (sources, design §16.2). An interceptor owns a runtime hook and emits captured
// events to a hub; it is ALSO listenable — it extends the multi-key emitter so other components can
// subscribe to its processing STAGES by contract alone (Interceptor extends EventSubscribable, so a
// holder of just the contract can on()/off()/once()/… without the concrete impl). Subclasses declare
// their StageMap (stage name → payload), install hooks in onStart(client), release them in onStop(),
// and fire stages with `this.emit(stage, payload)`. Observe-only: emit is the interceptor's own — the
// public Interceptor contract exposes only the listener side, so third parties can't inject stages.

export abstract class InterceptorBase<StageMap>
  extends MultiKeyEmitterBase<StageMap>
  implements Interceptor<StageMap>
{
  abstract readonly name: string;

  /** Install runtime hooks for this launch. */
  start(client: Client): void {
    this.onStart(client);
  }

  /** Remove runtime hooks (the emitter's listeners persist unless removeAllListeners is called). */
  stop(): void {
    this.onStop();
  }

  /** Subclasses install their runtime hook(s) and wire emission (to the hub and `this.emit`) here. */
  protected abstract onStart(client: Client): void;

  /** Subclasses release their hook(s) here (optional). */
  protected onStop(): void {}
}
