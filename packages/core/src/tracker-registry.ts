// Trackers are SINGLETONS, but "global" is scoped to what the SDK is bound to: the window object passed to
// launch() (or the host's own `window`/`globalThis` by default). So the singleton is per KEY OBJECT: an injected
// window (tests, a hostile frame, an embedded document) gets its own tracker and never shares state with the host's.
// Keys are held weakly, so the registry cannot keep a torn-down window alive.
//
// A tracker's retention rule (what survives its last unsubscribe) belongs to the tracker; this registry only owns
// "which instance belongs to which key" and the test/teardown `reset`.

export interface TrackerRegistry<T extends object> {
  /** The tracker for `key`, created by `create(key)` on first use. */
  for(key: object, create: (key: object) => T): T;
  /** The existing tracker for `key`, without creating one. */
  peek(key: object): T | undefined;
  /**
   * Drop `key`'s tracker so the next `for()` builds a fresh one. Calls the tracker's own `reset()` first when it has
   * one (a throwing `reset()` never blocks the drop). A no-op for an unknown key.
   */
  reset(key: object): void;
}

export function createTrackerRegistry<T extends object>(): TrackerRegistry<T> {
  const trackers = new WeakMap<object, T>();
  return {
    for(key, create) {
      let tracker = trackers.get(key);
      if (tracker === undefined) {
        tracker = create(key);
        trackers.set(key, tracker);
      }
      return tracker;
    },
    peek: (key) => trackers.get(key),
    reset(key) {
      const tracker = trackers.get(key);
      if (tracker === undefined) return;
      trackers.delete(key);
      try {
        (tracker as { reset?: () => void }).reset?.();
      } catch {
        /* best-effort: the drop already happened */
      }
    },
  };
}
