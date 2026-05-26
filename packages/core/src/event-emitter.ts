// Pub/sub primitive (design §16.2), mirroring Android contracts/common/EventEmitter.java.
//
// Sources emit to hubs UNCONDITIONALLY, from inside intercepted user operations (§16.1), so a
// throwing subscriber must never break emit for the source or for other subscribers: each listener
// call is isolated and failures route to the optional `onListenerError` handler (hubs wire it to
// debug.warn). `onListenerError`, if provided, must not throw.

export type Listener<T> = (event: T) => void;

export interface EventEmitter<T> {
  /** Register a listener; returns an idempotent unsubscribe function. */
  subscribe(listener: Listener<T>): () => void;
  /** Remove a listener by reference; a no-op if it was never subscribed. */
  unsubscribe(listener: Listener<T>): void;
  /** Dispatch `event` to every current listener, in subscription order. */
  emit(event: T): void;
}

export function createEventEmitter<T>(onListenerError?: (err: unknown) => void): EventEmitter<T> {
  // Set: dedups a listener subscribed twice and preserves insertion (subscription) order.
  const listeners = new Set<Listener<T>>();

  return {
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    unsubscribe(listener: Listener<T>): void {
      listeners.delete(listener);
    },

    emit(event: T): void {
      // Snapshot so a listener that subscribes during dispatch is not called for the in-flight
      // event; the membership recheck so a listener unsubscribed mid-dispatch is not called either.
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) {
          continue;
        }
        try {
          listener(event);
        } catch (err) {
          onListenerError?.(err);
        }
      }
    },
  };
}
