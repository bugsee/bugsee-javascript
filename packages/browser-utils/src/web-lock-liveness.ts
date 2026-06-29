// Web Locks liveness for browser/worker multi-instance IndexedDB coexistence (docs/design/
// browser-multi-instance-coexistence.md, BD2/BD3) — the browser analog of node's pid-probe + heartbeat, but
// STRICTLY better: a lock held via `navigator.locks` is auto-released the instant its realm dies (tab close /
// crash / worker terminate), so there is no staleness window and no PID-reuse ambiguity. The same lock doubles
// as the recovery CLAIM + serializer: a dead sibling is recovered while HOLDING its lock, so a concurrent peer
// that probes it gets `null` and skips. Available in window + every worker type; degrades (no cross-instance
// recovery + one-time warn) where `navigator.locks` is absent.

export const WEB_LOCKS_UNAVAILABLE_WARNING =
  'navigator.locks unavailable; cross-instance crash recovery (a dead tab/worker recovered by a live one) ' +
  'is disabled. Each instance still delivers its own incidents.';

/** The minimal `LockManager` surface we use (the `(name, options, callback)` form of `navigator.locks`). */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

export interface WebLockLiveness {
  /** False when Web Locks is unavailable — cross-instance recovery then degrades to a no-op. */
  readonly available: boolean;
  /** Acquire `name` and HOLD it for the realm's lifetime (released automatically on tab/worker death). */
  holdSelf(name: string): void;
  /** If `name` is DEAD (its lock is acquirable), run `fn` while HOLDING the lock (so concurrent peers skip),
   *  then release. Resolves immediately (no-op) when the lock is held (alive) or Web Locks is unavailable. */
  recoverIfDead(name: string, fn: () => Promise<void>): Promise<void>;
}

/** Build the liveness over a `LockManager` (pass `navigator.locks`, or `undefined` to degrade). */
export function createWebLockLiveness(
  locks: LockManagerLike | undefined,
  warn: (message: string) => void = () => {},
): WebLockLiveness {
  if (locks === undefined) {
    let warned = false;
    return {
      available: false,
      holdSelf: () => {
        if (!warned) {
          warned = true;
          warn(WEB_LOCKS_UNAVAILABLE_WARNING);
        }
      },
      recoverIfDead: () => Promise.resolve(),
    };
  }
  return {
    available: true,
    holdSelf(name) {
      // Hold for the realm's lifetime: a never-resolving callback keeps the lock until the realm is destroyed.
      // A rejected request (e.g. an invalid lock name, or a sandboxed context) must NOT surface as an
      // unhandledrejection — Bugsee would self-report its own internal lock failure as an app error. Swallow
      // it to `warn` and degrade (this instance simply won't be lock-protected; siblings may double-recover
      // its bundles, which the server dedupes by signature).
      void locks
        .request(name, { mode: 'exclusive' }, () => new Promise<never>(() => {}))
        .catch((error) => warn(`failed to hold the instance liveness lock: ${String(error)}`));
    },
    recoverIfDead(name, fn) {
      return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        // `ifAvailable` invokes the callback with `null` when the lock is HELD (the owner is alive) → skip;
        // with a non-null lock when it was AVAILABLE (the owner is dead) → recover while holding it.
        if (lock !== null) {
          await fn();
        }
      }) as Promise<void>;
    },
  };
}
