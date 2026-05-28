// Multi-key (keyed) event emitter — the contract a decoupled component exposes so OTHERS can listen
// to it by interface alone (the single-key emitter in event-emitter.ts is separate). M maps each event
// name → its payload type. The well-known JS listener surface is provided under both conventions:
// on/off (+ once, removeAllListeners) and the DOM addEventListener/removeEventListener aliases, plus
// onAny for "every event from this source" (what a capture provider wants). EventSubscribable is the
// LISTENER side a component publishes (e.g. an Interceptor's stage hooks); MultiKeyEmitter adds emit().
//
// Listeners may fire from inside intercepted user operations, so a throwing listener must never break
// emit for the owner or other listeners: each call is isolated to `onListenerError` (which, if
// provided, must not throw). Dispatch snapshots the listener set and rechecks membership, so a
// listener (un)subscribed mid-dispatch — including a self-removing once() wrapper — is handled right.
//
// Subclasses observe listener PRESENCE via the protected onActiveChange hook (fired on the 0↔≥1
// transition) — this is what lets an interceptor lazily install/remove its global patch (§16).

export type EventListener<T> = (payload: T) => void;

/** The listener side of a multi-key emitter — what a component publishes for others to observe. */
export interface EventSubscribable<M> {
  /** Subscribe to `name`; returns an idempotent unsubscribe. */
  on<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void;
  /** Alias of {@link on} (DOM EventTarget naming). */
  addEventListener<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void;
  /** Subscribe to the next `name` only, then auto-unsubscribe; returns an unsubscribe to cancel early. */
  once<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void;
  /** Subscribe to EVERY channel; the listener also receives the channel name. Returns an unsubscribe. */
  onAny(listener: <K extends keyof M>(name: K, payload: M[K]) => void): () => void;
  /** Remove a listener (by the reference passed to on/once); a no-op if absent. */
  off<K extends keyof M>(name: K, listener: EventListener<M[K]>): void;
  /** Alias of {@link off} (DOM EventTarget naming). */
  removeEventListener<K extends keyof M>(name: K, listener: EventListener<M[K]>): void;
  /** Remove all listeners of `name`, or (when `name` is omitted) every listener incl. onAny. */
  removeAllListeners(name?: keyof M): void;
}

/** The full multi-key emitter: the listener side plus emit() for the owner that fires events. */
export interface MultiKeyEmitter<M> extends EventSubscribable<M> {
  /** Dispatch `payload` to every listener of `name` (then onAny listeners), in subscription order. */
  emit<K extends keyof M>(name: K, payload: M[K]): void;
}

type AnyFn = (payload: unknown) => void;
type AnyChannelFn = (name: PropertyKey, payload: unknown) => void;

/** Reusable basic implementation; components inherit it (or compose {@link createMultiKeyEmitter}). */
export class MultiKeyEmitterBase<M> implements MultiKeyEmitter<M> {
  // name → (original listener → effective callable). Map preserves subscription order and dedups by
  // original reference; a once() listener maps its original to a self-removing wrapper.
  readonly #channels = new Map<keyof M, Map<AnyFn, AnyFn>>();
  readonly #anyListeners = new Set<AnyChannelFn>();
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

  #hasListeners(): boolean {
    if (this.#anyListeners.size > 0) {
      return true;
    }
    for (const channel of this.#channels.values()) {
      if (channel.size > 0) {
        return true;
      }
    }
    return false;
  }

  // Run a listener-set mutation and notify onActiveChange when it crosses the 0↔≥1 boundary.
  #mutate<T>(fn: () => T): T {
    const before = this.#hasListeners();
    const result = fn();
    if (before !== this.#hasListeners()) {
      this.onActiveChange(!before);
    }
    return result;
  }

  #dispatch(run: () => void): void {
    try {
      run();
    } catch (err) {
      this.#onListenerError?.(err);
    }
  }

  /** Fired when listener presence crosses 0↔≥1 (active=true on the first, false when the last leaves). */
  protected onActiveChange(_active: boolean): void {}

  on<K extends keyof M>(name: K, listener: EventListener<M[K]>): () => void {
    const fn = listener as unknown as AnyFn;
    return this.#mutate(() => {
      this.#channel(name).set(fn, fn);
      return () => this.off(name, listener);
    });
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
    return this.#mutate(() => {
      this.#channel(name).set(fn, wrapper);
      return () => this.off(name, listener);
    });
  }

  onAny(listener: <K extends keyof M>(name: K, payload: M[K]) => void): () => void {
    const any = listener as unknown as AnyChannelFn;
    return this.#mutate(() => {
      this.#anyListeners.add(any);
      return () => this.#mutate(() => this.#anyListeners.delete(any));
    });
  }

  off<K extends keyof M>(name: K, listener: EventListener<M[K]>): void {
    this.#mutate(() => this.#channels.get(name)?.delete(listener as unknown as AnyFn));
  }

  removeEventListener<K extends keyof M>(name: K, listener: EventListener<M[K]>): void {
    this.off(name, listener);
  }

  removeAllListeners(name?: keyof M): void {
    this.#mutate(() => {
      if (name === undefined) {
        this.#channels.clear();
        this.#anyListeners.clear();
      } else {
        this.#channels.delete(name);
      }
    });
  }

  emit<K extends keyof M>(name: K, payload: M[K]): void {
    const channel = this.#channels.get(name);
    if (channel !== undefined) {
      for (const [original, effective] of [...channel]) {
        // Recheck by original reference so a listener removed mid-dispatch (incl. a fired once-wrapper)
        // is not called; a listener added during dispatch is absent from the snapshot and so skipped.
        if (channel.get(original) === effective) {
          this.#dispatch(() => effective(payload));
        }
      }
    }
    for (const any of [...this.#anyListeners]) {
      if (this.#anyListeners.has(any)) {
        this.#dispatch(() => any(name, payload));
      }
    }
  }
}

export function createMultiKeyEmitter<M>(
  onListenerError?: (err: unknown) => void,
): MultiKeyEmitter<M> {
  return new MultiKeyEmitterBase<M>(onListenerError);
}
