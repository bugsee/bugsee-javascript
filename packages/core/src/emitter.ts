// Multi-key (keyed) event emitter — the contract a decoupled component exposes so OTHERS can listen
// to it by interface alone (the single-key emitter in event-emitter.ts backs the hubs). M maps each
// event name → its payload type. The well-known JS listener surface is provided under both
// conventions: on/off (+ once, removeAllListeners) and the DOM addEventListener/removeEventListener
// aliases. EventSubscribable is the LISTENER side a component publishes (e.g. an Interceptor's stage
// hooks); MultiKeyEmitter adds emit() for the owner that fires the events.
//
// Listeners may fire from inside intercepted user operations, so a throwing listener must never break
// emit for the owner or other listeners: each call is isolated to `onListenerError` (which, if
// provided, must not throw). Dispatch snapshots the listener set and rechecks membership, so a
// listener (un)subscribed mid-dispatch — including a self-removing once() wrapper — is handled right.

export type EventListener<T> = (payload: T) => void;

/** The listener side of a multi-key emitter — what a component publishes for others to observe. */
export interface EventSubscribable<M> {
  /** Subscribe to `name`; returns an idempotent unsubscribe. */
  on<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void;
  /** Alias of {@link on} (DOM EventTarget naming). */
  addEventListener<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void;
  /** Subscribe to the next `name` only, then auto-unsubscribe; returns an unsubscribe to cancel early. */
  once<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void;
  /** Remove a listener (by the reference passed to on/once); a no-op if absent. */
  off<K extends keyof M>(name: K, listener: EventListener<M[K]>): void;
  /** Alias of {@link off} (DOM EventTarget naming). */
  removeEventListener<K extends keyof M>(name: K, listener: EventListener<M[K]>): void;
  /** Remove all listeners of `name`, or (when `name` is omitted) of every channel. */
  removeAllListeners(name?: keyof M): void;
}

/** The full multi-key emitter: the listener side plus emit() for the owner that fires events. */
export interface MultiKeyEmitter<M> extends EventSubscribable<M> {
  /** Dispatch `payload` to every listener of `name`, in subscription order. */
  emit<K extends keyof M>(name: K, payload: M[K]): void;
}

type AnyFn = (payload: unknown) => void;

/** Reusable basic implementation; components inherit it (or compose {@link createMultiKeyEmitter}). */
export class MultiKeyEmitterBase<M> implements MultiKeyEmitter<M> {
  // name → (original listener → effective callable). Map preserves subscription order and dedups by
  // original reference; a once() listener maps its original to a self-removing wrapper.
  readonly #channels = new Map<keyof M, Map<AnyFn, AnyFn>>();
  readonly #onListenerError: ((err: unknown) => void) | undefined;

  constructor(onListenerError?: (err: unknown) => void) {
    this.#onListenerError = onListenerError;
  }

  #channel(name: keyof M): Map<AnyFn, AnyFn> {
    let channel = this.#channels.get(name);
    if (channel === undefined) {
      channel = new Map<AnyFn, AnyFn>();
      this.#channels.set(name, channel);
    }
    return channel;
  }

  on<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void {
    const fn = listener as unknown as AnyFn;
    this.#channel(name).set(fn, fn);
    return () => this.off(name, listener);
  }

  addEventListener<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void {
    return this.on(name, listener);
  }

  once<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void {
    const fn = listener as unknown as AnyFn;
    const wrapper: AnyFn = (payload) => {
      this.off(name, listener);
      fn(payload);
    };
    this.#channel(name).set(fn, wrapper);
    return () => this.off(name, listener);
  }

  off<K extends keyof M>(name: K, listener: EventListener<M[K]>): void {
    this.#channels.get(name)?.delete(listener as unknown as AnyFn);
  }

  removeEventListener<K extends keyof M>(name: K, listener: EventListener<M[K]>): void {
    this.off(name, listener);
  }

  removeAllListeners(name?: keyof M): void {
    if (name === undefined) {
      this.#channels.clear();
    } else {
      this.#channels.delete(name);
    }
  }

  emit<K extends keyof M>(name: K, payload: M[K]): void {
    const channel = this.#channels.get(name);
    if (channel === undefined) {
      return;
    }
    for (const [original, effective] of [...channel]) {
      // Recheck by original reference so a listener removed mid-dispatch (incl. a fired once-wrapper)
      // is not called; a listener added during dispatch is absent from the snapshot and so is skipped.
      if (channel.get(original) === effective) {
        try {
          effective(payload);
        } catch (err) {
          this.#onListenerError?.(err);
        }
      }
    }
  }
}

export function createMultiKeyEmitter<M>(
  onListenerError?: (err: unknown) => void,
): MultiKeyEmitter<M> {
  return new MultiKeyEmitterBase<M>(onListenerError);
}
