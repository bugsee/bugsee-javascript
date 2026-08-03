// Wave 2.1 — the host-boundary guard.
//
// The SDK's binding rule is that it never alters host application behaviour, and the review found the same
// shape of violation in nearly every tier: SDK code runs inside host code with no guard, so an SDK-internal
// failure becomes the HOST's failure. The worst instances are the framework error seams, whose entire purpose
// is to make an error survivable — there the SDK converts a recoverable error into an unrecoverable one, at
// exactly the moment the customer needs their own handler. Measured against real Vue: a customer error that
// a customer `errorHandler` fully recovered from became a throw out of `app.mount()` and an empty DOM, purely
// because Bugsee was installed (docs/review/frontend-adapters-vue-angular-svelte-solid.md SEV1 #1).
//
// One helper, applied at every host-facing entry point, so the rule is enforced by construction rather than
// by remembering a try/catch at ~15 call sites.

/** True for a thenable — a real promise or any object exposing `.then`. */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Run `fn` at a host boundary and contain ANY failure it produces.
 *
 * Two failure modes, because a host boundary has two:
 *
 *  - a SYNCHRONOUS throw is caught, routed to `onError`, and `undefined` is returned;
 *  - a returned PROMISE gets a rejection handler attached, because the idiomatic fire-and-forget
 *    `void somethingAsync()` turns a rejection into an unhandled rejection in the HOST process one tick
 *    later — which on Node is now a crash again, since Wave 2.5 restored the default disposition.
 *
 * The original promise is still returned, so a caller that awaits it still observes the rejection; the
 * attached handler only guarantees it is never *unhandled*. A caller that both awaits and supplies `onError`
 * will therefore see it twice — deliberate, since the alternative is swallowing it at a boundary whose whole
 * job is not to swallow things.
 */
export function neverThrow<T>(fn: () => T, onError?: (error: unknown) => void): T | undefined {
  try {
    const result = fn();
    if (isPromiseLike(result)) {
      void (result as PromiseLike<unknown>).then(undefined, (error: unknown) => {
        report(onError, error);
      });
    }
    return result;
  } catch (error) {
    report(onError, error);
    return undefined;
  }
}

/**
 * Wrap a function so every call is contained. For installing into a host's own extension points — a
 * framework error handler, a middleware, an event listener — where the boundary is the function itself.
 */
export function guarded<A extends unknown[], R>(
  fn: (...args: A) => R,
  onError?: (error: unknown) => void,
): (...args: A) => R | undefined {
  return (...args: A) => neverThrow(() => fn(...args), onError);
}

/** Route to the sink, and never let a THROWING sink defeat the guard — the last place a throw may escape. */
function report(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // A reporting sink that throws must not re-introduce the very failure this helper exists to contain.
  }
}
