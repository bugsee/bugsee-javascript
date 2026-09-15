import type { Transaction } from './span';

// The active-span store (D2 part 2): where the performance controller keeps the in-flight
// transaction behind `getActiveSpan()` / the naming seam. A process-wide single slot is WRONG on
// a concurrent server — a second in-flight request's `startTransaction` overwrites the first
// request's slot, so a rename intended for request A lands on request B's transaction (Android's
// parity implementation, `SpanContextHolder`, keys the active span off a `ThreadLocal`, i.e. per
// execution context). This seam lets a platform supply per-execution-context tracking (Node keys
// it off the AsyncLocalStorage-backed `RequestContext`) while the default stays the historical
// single slot — correct for a browser's one in-flight navigation/interaction.

/**
 * Where the controller's active transaction lives; `undefined` = nothing in flight.
 *
 * Implementations MUST NOT throw: the controller calls into the store on `startTransaction`,
 * `getActiveSpan`, every naming call and every finish — straight from user code — and degrades a
 * throwing store to untracked (usable transactions, no active slot) rather than propagating. The
 * built-in stores never throw on the transactions the SDK puts into them (controller-created
 * `TransactionImpl`s, whose `isFinished()` is a plain flag read); this is the contract a custom
 * implementation upholds.
 */
export interface ActiveSpanStore {
  /**
   * The live in-flight transaction, or `undefined` when none is in flight. NEVER returns a
   * finished transaction: a stale entry reads as absent, so a transaction finished outside its
   * originating execution — e.g. a response `close` firing after the ALS context exited — can
   * never resurface as a live one through a later read.
   */
  get(): Transaction | undefined;
  /** Hold `transaction` as the active one (overwrites). */
  set(transaction: Transaction): void;
  /**
   * Drop `transaction` wherever this store holds it — the finish path, called with the finishing
   * transaction itself. Identity-compared (finishing one transaction never clears another) and a
   * no-op when held nowhere. A scoped store must check EVERY place it can hold a transaction —
   * context stash and any process-wide slot — independently, and must not make the clear conditional
   * on being able to READ the transaction first: a transaction started outside any execution scope
   * and finished from inside one is invisible to that execution's read, yet must still be released.
   */
  clear(transaction: Transaction): void;
}

/** The historical behavior: one process-wide slot, last-started wins, cleared on its finish. */
export function createSingleSlotActiveSpanStore(): ActiveSpanStore {
  let active: Transaction | undefined;
  return {
    get: () => (active !== undefined && !active.isFinished() ? active : undefined),
    set: (transaction) => {
      active = transaction;
    },
    clear: (transaction) => {
      if (active === transaction) active = undefined;
    },
  };
}
