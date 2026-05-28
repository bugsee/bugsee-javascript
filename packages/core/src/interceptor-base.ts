import type { Interceptor } from './contracts';
import { MultiKeyEmitterBase } from './emitter';

// Base for interceptors (sources, design §16.2). An interceptor owns a runtime hook and is itself a
// listenable emitter — components subscribe to its processing STAGES directly (no hub mediator). It is
// a process-global singleton; its global patch is installed only while ACTIVE and removed when idle.
//
// Activation = explicit start() OR subscriber presence (Android interception-coordinator behavior):
//   active = started || hasListeners.
// onActivate() installs the runtime hook (and wires it to fire `this.emit(stage, payload)`);
// onDeactivate() removes it. So a bare `interceptor.on('stage', fn)` lazily activates the hook, and
// dropping the last listener (with no explicit start) deactivates it — zero work + zero patching when
// nobody is listening. Subclasses are client-independent: they emit via their own emitter, not a hub.

export abstract class InterceptorBase<StageMap>
  extends MultiKeyEmitterBase<StageMap>
  implements Interceptor<StageMap>
{
  abstract readonly name: string;
  #started = false;
  #listenersActive = false;
  #active = false;

  /** Explicitly activate (the coordinator-driven half); idempotent. Stays active while subscribed. */
  start(): void {
    this.#started = true;
    this.#updateActive();
  }

  /** Explicitly deactivate; subscriber presence may keep it active. */
  stop(): void {
    this.#started = false;
    this.#updateActive();
  }

  protected override onActiveChange(active: boolean): void {
    this.#listenersActive = active;
    this.#updateActive();
  }

  #updateActive(): void {
    const next = this.#started || this.#listenersActive;
    if (next === this.#active) {
      return;
    }
    this.#active = next;
    if (next) {
      this.onActivate();
    } else {
      this.onDeactivate();
    }
  }

  /** Subclasses install the runtime hook here and wire it to fire `this.emit(stage, payload)`. */
  protected abstract onActivate(): void;

  /** Subclasses remove the runtime hook here (optional). */
  protected onDeactivate(): void {}
}
