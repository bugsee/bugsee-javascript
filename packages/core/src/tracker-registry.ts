// Trackers are SINGLETONS, but "global" is scoped to what the SDK is bound to: the window object passed to
// launch() (or the host's own `window`/`globalThis` by default). So the singleton is per KEY OBJECT: an injected
// window (tests, a hostile frame, an embedded document) gets its own tracker and never shares state with the host's.
// Keys are held weakly, so the registry cannot keep a torn-down window alive.
//
// A tracker's retention rule (what survives its last unsubscribe) belongs to the tracker; this registry only owns
// "which instance belongs to which key" and the test/teardown `reset`.

export interface TrackerRegistry<T extends object> {
  /**
   * The tracker for `key`, created by `create(key)` on first use. If `create` itself re-enters `for` with the same key,
   * the FIRST-registered instance is the singleton: the other is discarded and its `reset()` is NOT called, so a
   * factory must not acquire resources it cannot lose.
   */
  for(key: object, create: (key: object) => T): T;
  /** The existing tracker for `key`, without creating one. */
  peek(key: object): T | undefined;
  /**
   * Detaches `key`'s tracker, THEN calls its own `reset()` if it has one, so the next `for()` builds a fresh one.
   * During `reset()`, `peek(key)` is `undefined`, and anything `reset()` re-registers for the key is discarded
   * (again without its `reset()` being called). A throwing `reset()` never blocks the drop. A no-op for an unknown key.
   */
  reset(key: object): void;
}

export function createTrackerRegistry<T extends object>(): TrackerRegistry<T> {
  const trackers = new WeakMap<object, T>();
  return {
    for(key, create) {
      const existing = trackers.get(key);
      if (existing !== undefined) return existing;
      const created = create(key);
      // `create` may itself have asked for this key (a tracker built from a sibling tracker): the instance the
      // registry already holds is THE singleton, so keep it and drop the one just built.
      const raced = trackers.get(key);
      if (raced !== undefined) return raced;
      trackers.set(key, created);
      return created;
    },
    peek: (key) => trackers.get(key),
    reset(key) {
      const tracker = trackers.get(key);
      if (tracker === undefined) return;
      trackers.delete(key);
      try {
        (tracker as { reset?: () => void }).reset?.();
      } catch {
        /* best-effort: the drop happens regardless */
      } finally {
        // a reset() that re-requested this key would otherwise leave a fresh tracker behind
        trackers.delete(key);
      }
    },
  };
}
