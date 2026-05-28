// Keyed, typed, observe-only notification registry — a MULTI-channel EventEmitter (the single-channel
// one lives in event-emitter.ts; the hubs use that). It powers per-interceptor STAGE HOOKS (design
// §16): a source notifies observers at each processing stage (network 'before'/'complete'/'error',
// console 'log', …) keyed by stage name, each with its own typed payload. Observe-only by design —
// transformation/veto is the separate filter mechanism (setNetworkEventFilter, …).
//
// Like EventEmitter, hooks fire from inside intercepted user operations, so a throwing observer must
// never break emit for the source or other observers: each call is isolated to `onListenerError`
// (which, if provided, must not throw).

export interface Hooks<M> {
  /** Observe one channel; returns an idempotent unsubscribe. */
  on<K extends keyof M>(name: K, listener: (payload: M[K]) => void): () => void;
  /** Observe EVERY channel; the listener also receives the channel name. */
  onAny(listener: <K extends keyof M>(name: K, payload: M[K]) => void): () => void;
  /** Notify observers of `name` (then onAny observers) with `payload`, in subscription order. */
  emit<K extends keyof M>(name: K, payload: M[K]): void;
}

export function createHooks<M>(onListenerError?: (err: unknown) => void): Hooks<M> {
  type NamedListener = (payload: unknown) => void;
  type AnyListener = (name: keyof M, payload: unknown) => void;
  // Per-channel listener sets (insertion order preserved, duplicates deduped) + the catch-all set.
  const byName = new Map<keyof M, Set<NamedListener>>();
  const anyListeners = new Set<AnyListener>();

  const isolate = (run: () => void): void => {
    try {
      run();
    } catch (err) {
      onListenerError?.(err);
    }
  };

  return {
    on<K extends keyof M>(name: K, listener: (payload: M[K]) => void): () => void {
      let set = byName.get(name);
      if (set === undefined) {
        set = new Set<NamedListener>();
        byName.set(name, set);
      }
      const named = listener as NamedListener;
      set.add(named);
      return () => {
        set.delete(named);
      };
    },

    onAny(listener: <K extends keyof M>(name: K, payload: M[K]) => void): () => void {
      const any = listener as unknown as AnyListener;
      anyListeners.add(any);
      return () => {
        anyListeners.delete(any);
      };
    },

    emit<K extends keyof M>(name: K, payload: M[K]): void {
      // Snapshot each set so a listener subscribed during dispatch is not called for the in-flight
      // event; the membership recheck so a listener unsubscribed mid-dispatch is not called either.
      const set = byName.get(name);
      if (set !== undefined) {
        for (const listener of [...set]) {
          if (set.has(listener)) {
            isolate(() => listener(payload));
          }
        }
      }
      for (const listener of [...anyListeners]) {
        if (anyListeners.has(listener)) {
          isolate(() => listener(name, payload));
        }
      }
    },
  };
}
