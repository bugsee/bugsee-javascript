import type { SpanStatus, Transaction } from './span';

// The idle-transaction lifecycle (frontend-adapters design D7). Wraps an already-started transaction (a
// navigation / interaction root) and auto-finishes it on inactivity — the mechanism that closes
// open-ended SPA transactions (Sentry idleTimeout/finalTimeout parity):
//   - idle timeout  — finish OK after `idleTimeoutMs` with no `keepAlive()` (reset on each keepAlive, e.g.
//     a new child request); captures the active work without trailing idle time.
//   - final timeout — a hard cap: finish DEADLINE_EXCEEDED at most `finalTimeoutMs` after start, even if
//     activity keeps resetting the idle timer (a runaway never stays open forever).
//   - finishNow()   — finish immediately (e.g. the next navigation supersedes this one).
//   - cancel()      — finish CANCELLED (e.g. the tab is hidden / backgrounded).
// All transitions are idempotent (the first finish wins; later calls + stale timers are no-ops). Timers
// are injected (`IdleTimer`) so it is runtime-portable + testable; the default is the global one-shot timer.

/** A one-shot timer seam (the core `Scheduler` is interval-only). Default: the global setTimeout/clearTimeout. */
export interface IdleTimer {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdleTransactionOptions {
  /** The already-started transaction to manage (its lifetime is now owned by the idle policy). */
  transaction: Transaction;
  /** One-shot timer; default the global setTimeout/clearTimeout. */
  timer?: IdleTimer;
  /** Finish OK after this many ms with no `keepAlive()`. Default 1000. */
  idleTimeoutMs?: number;
  /** Hard cap: finish DEADLINE_EXCEEDED at most this many ms after creation. Default 30000. */
  finalTimeoutMs?: number;
}

export interface IdleTransactionHandle {
  readonly transaction: Transaction;
  /** Reset the idle timer (call on activity — a new child span / in-flight request). No-op once finished. */
  keepAlive(): void;
  /** Finish immediately (the next navigation supersedes this one). Default status OK. */
  finishNow(status?: SpanStatus): void;
  /** Finish as CANCELLED (the tab was hidden / backgrounded). */
  cancel(): void;
}

const globalTimers = globalThis as typeof globalThis & {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const DEFAULT_TIMER: IdleTimer = {
  setTimeout: (callback, ms) => globalTimers.setTimeout(callback, ms),
  clearTimeout: (handle) => globalTimers.clearTimeout(handle),
};

export function createIdleTransaction(options: IdleTransactionOptions): IdleTransactionHandle {
  const timer = options.timer ?? DEFAULT_TIMER;
  const idleMs = options.idleTimeoutMs ?? 1000;
  const finalMs = options.finalTimeoutMs ?? 30000;
  let done = false;

  const finishWith = (status: SpanStatus): void => {
    if (done) return;
    done = true;
    timer.clearTimeout(idleHandle);
    timer.clearTimeout(finalHandle);
    options.transaction.finish(status);
  };

  let idleHandle = timer.setTimeout(() => finishWith('OK'), idleMs);
  const finalHandle = timer.setTimeout(() => finishWith('DEADLINE_EXCEEDED'), finalMs);

  return {
    transaction: options.transaction,
    keepAlive() {
      if (done) return;
      timer.clearTimeout(idleHandle);
      idleHandle = timer.setTimeout(() => finishWith('OK'), idleMs);
    },
    finishNow(status) {
      finishWith(status ?? 'OK');
    },
    cancel() {
      finishWith('CANCELLED');
    },
  };
}
