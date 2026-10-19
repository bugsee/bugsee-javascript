import type { EventSubscribable } from './emitter';

/**
 * A source that owns a runtime hook and emits captured events to its listeners. It is a
 * listenable emitter: by extending {@link EventSubscribable} it lets other components subscribe to its
 * processing STAGES (`StageMap` maps stage name → payload — e.g. the network interceptor keys by
 * NetworkStage) through the contract alone, without the concrete impl. Observe-only: the contract
 * exposes the listener side (on/off/once/…), not emit — only the interceptor fires its own stages.
 * Client-independent: it emits via its own emitter, not a hub. Activation is explicit (start/stop) OR
 * driven by subscriber presence; {@link InterceptorBase} provides the reusable implementation.
 */
export interface Interceptor<StageMap = Record<never, never>> extends EventSubscribable<StageMap> {
  /** Component id. */
  name: string;
  /** Explicitly activate (install the runtime hook); subscriber presence also activates. Idempotent. */
  start(): void;
  /** Explicitly deactivate; subscriber presence may keep it active. */
  stop(): void;
}
