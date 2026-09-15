import type { ContextProvider, RequestContext } from '@bugsee/core';
import type { ActiveSpanStore, Transaction } from '@bugsee/performance';

// The Node active-span store (D2 part 2): the JS equivalent of Android's `ThreadLocal<Span>`
// (`SpanContextHolder`). The performance controller's active transaction is keyed off the
// AsyncLocalStorage-backed `RequestContext` — the same per-request isolation the capture
// correlation-by-tagging foundation needs — instead of one process-wide slot shared by every
// concurrent request. Mirrors `server-instrument.ts`'s stash pattern (realm-global symbol key,
// non-enumerable so it never leaks into report assembly / capture stamping, which read named
// fields only).
//
// Reads are strictly private whenever a request context is active: the slot holds this execution's
// own live stash or nothing — NEVER another execution's ambient transaction (R-1: the fallback had
// no producer — every built-in entry opens the context before starting its transaction — and every
// fallback read is the D2 hazard direction). The ambient single slot serves ONLY context-less
// executions (startup, background work), where the behavior is exactly today's. Writes with no
// current context land in the ambient slot. Known limitation, documented not fixed: contexts nested
// via a second store.run() inside an enterWith-opened context read private-empty (there is no
// parent handle to inherit through); the outer transaction's lifecycle is unaffected.
//
// A finished transaction NEVER reads back, so a transaction finished outside its originating
// execution — e.g. a response `close` firing after the ALS context exited, where the finish-time
// clear cannot reach the originating context's stash — can never resurface as a live one through
// a later read. The unreachable stash itself is retained only until its context is
// garbage-collected (run-scoped) or overwritten by the next start, exactly like
// `server-instrument.ts`'s stash, which is likewise never removed.
//
// Caveat (shared with `getActiveServerSpan`): an `enterWith`-opened context can linger across a
// shared async context (e.g. Elysia's `app.handle`), and a transaction stashed on it lingers with
// it. Run-scoped owners (the node:http emit patch, native serve wraps, express/koa/hono — the
// dominant path) each own a fresh context per request and are fully isolated.
//
// Caveat 2, MEASURED (R-11): with HTTP PIPELINING, node:http queues the second response
// (`state.outgoing`) and flushes it inside the FIRST response's completion chain, so a pipelined
// request's whole write/finish/close phase executes under the PREVIOUS request's context:
//   [close ctx=4] getStore=4   [close ctx=5] getStore=4   <- req 5 closing under req 4's context
// The store stays correct (the finish-time clear is identity-compared, so it deletes nothing, and a
// private read of the wrong context returns nothing rather than a foreign transaction), but anything
// calling `getActiveSpan()` from a `res.on('finish')` handler during that phase reads the previous
// context and gets `undefined` where the old process-wide slot returned the transaction. Pipelining
// is effectively dead in browsers, so this is accepted, not fixed. NOTE the same Node behaviour
// mis-attributes `server-instrument.ts`'s `http.route` merge and the capture-ring `contextId` for a
// pipelined request — pre-existing, wider than this seam, tracked separately.
//
// Type-only imports: `@bugsee/performance` stays value-free here (R2-8 — a value import would
// eagerly load the whole opt-in APM barrel into every `@bugsee/node` consumer).

const ACTIVE_TRANSACTION = Symbol.for('bugsee.performance.activeTransaction');

type ContextWithActive = RequestContext & { [ACTIVE_TRANSACTION]?: Transaction };

const stashed = (context: RequestContext): Transaction | undefined =>
  (context as ContextWithActive)[ACTIVE_TRANSACTION];

/** A stale (already-finished) entry reads as absent. See the module note. */
const live = (transaction: Transaction | undefined): Transaction | undefined =>
  transaction !== undefined && !transaction.isFinished() ? transaction : undefined;

export interface RequestScopedActiveSpanStoreOptions {
  /**
   * Surfaced exactly ONCE per cause-site per store: a throwing `source.getCurrent()` (a broken host
   * ALS binding or custom store), or a context object that cannot carry the stash (non-extensible —
   * its writes are dropped, so naming there would otherwise silently no-op). One latch per cause,
   * not one latch total, so the first anomaly never consumes the warning owed to the second.
   * A binding that merely reports no current context is indistinguishable from "no request active" —
   * the normal background-task shape — so that case never warns. Absent → both degradations stay
   * silent (still fail-safe, just undiscoverable).
   */
  onError?: (error: unknown) => void;
}

export function createRequestScopedActiveSpanStore(
  // NOTE: `getCurrent` must return a STABLE object per execution (the ALS binding does — the same
  // context object for the whole request). A binding returning a fresh wrapper per call defeats the
  // stash (writes land on an object no read ever sees again); such a binding degrades to ambient
  // sharing. Likewise the stash key is process-global by design (realm convergence across duplicate
  // module copies, mirroring server-instrument's stash) — two live stores over one context object
  // alias on it. That is safe in practice because the process launches exactly one store (the
  // carrier singleton guarantees a single launch owns the composition; R-12).
  source: Pick<ContextProvider, 'getCurrent'>,
  options: RequestScopedActiveSpanStoreOptions = {},
): ActiveSpanStore {
  let ambient: Transaction | undefined;
  // One latch per cause-site, not one latch total: a transient ALS breakage must not consume the
  // warning owed to a later frozen-context drop (or vice versa) — different root causes, each worth
  // exactly one report per store (a module-hoisted latch would silence sibling stores instead).
  const warnedKinds = new Set<'throw' | 'drop'>();
  const warnOnce = (kind: 'throw' | 'drop', error: unknown): void => {
    if (warnedKinds.has(kind)) return;
    warnedKinds.add(kind);
    try {
      options.onError?.(error);
    } catch {
      // A broken sink must never become the request's outcome (server-instrument.ts precedent).
    }
  };
  const current = (): RequestContext | undefined => {
    try {
      const context = source.getCurrent() as unknown;
      // A custom binding may return null (the idiomatic absent value) or a non-object where a
      // context object belongs. Normalize both to absent: everything below assumes an
      // object-or-undefined — `stashed(null)` throws on the property read, and
      // `Object.defineProperty('a-string', …)` throws in `set`.
      return typeof context === 'object' && context !== null
        ? (context as RequestContext)
        : undefined;
    } catch (error) {
      // A broken host ALS binding must never break the request path — degrade to ambient. Warn
      // once so the breakage is discoverable instead of failing silently on every request.
      warnOnce('throw', error);
      return undefined;
    }
  };
  return {
    get: () => {
      const context = current();
      // Strictly private under a context (R-1): this execution's own live stash or nothing. The
      // ambient slot serves context-less executions only — a context-bearing read must never observe
      // (and a naming call must never rename) another execution's transaction.
      if (context !== undefined) return live(stashed(context));
      return live(ambient);
    },
    set: (transaction) => {
      const context = current();
      if (context === undefined) {
        ambient = transaction;
        return;
      }
      try {
        Object.defineProperty(context, ACTIVE_TRANSACTION, {
          value: transaction,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } catch (error) {
        // A non-extensible (frozen/sealed) context object cannot carry the stash, and redirecting
        // the write to ambient would poison the shared slot every other execution reads (a later
        // context-less set would then orphan this request's own transaction too). So the write is
        // DROPPED: this request simply does not get a slot, nobody else is disturbed, and nothing
        // throws into the request path. Surfaced once via onError when a sink is configured — a
        // frozen context otherwise loses per-request naming with zero signal.
        //
        // What a dropped write leaves readable is whatever was stashed BEFORE: usually nothing, but
        // a context sealed after a successful stash keeps reading its own earlier live transaction
        // (asserted as correct in active-span-store.test.ts), and an integrator reusing ONE context
        // object across requests and freezing it between them would read the earlier request's
        // transaction. Both follow from reads being keyed on the context object: a shared context
        // object is a shared slot, which `controller.ts`'s getActiveSpan docstring states outright.
        warnOnce('drop', error);
      }
    },
    clear: (transaction) => {
      const context = current();
      if (context !== undefined) {
        try {
          if (stashed(context) === transaction) {
            // Assignment, not `delete`: removing a `defineProperty`-installed key forces V8 to
            // migrate the object to dictionary mode, while the descriptor is already
            // `writable: true` — so blanking is free and every read already treats `undefined`
            // as absent. On a sealed context the write still lands (sealed preserves
            // writability); on a frozen one it throws and is absorbed below.
            (context as ContextWithActive)[ACTIVE_TRANSACTION] = undefined;
          }
        } catch {
          // A frozen context's stash cannot be blanked; get() still hides it once finished.
        }
      }
      if (ambient === transaction) ambient = undefined;
    },
  };
}
