// Instance dedup (design §7.7): tag a thrown object with a hidden symbol on first capture so a
// re-capture of the SAME instance (e.g. an error that propagates through several handlers) is a
// no-op. Distinct from the signature-based 100 ms window dedup, which lives in the capture pipeline.

const ALREADY_CAUGHT = Symbol('bugsee.alreadyCaught');

/**
 * Returns whether `err` was already marked caught, and marks it if not. Non-object values (string,
 * number, null, …) can't be tagged, so they always report `false` (never deduped). Frozen/sealed
 * objects that reject tagging also report `false` (safer to re-capture than to silently drop).
 */
export function checkOrSetAlreadyCaught(err: unknown): boolean {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) {
    return false;
  }
  const obj = err as Record<symbol, unknown>;
  if (obj[ALREADY_CAUGHT]) {
    return true;
  }
  try {
    Object.defineProperty(obj, ALREADY_CAUGHT, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    // Non-extensible/frozen object: can't tag it, so treat as not-yet-caught.
  }
  return false;
}
