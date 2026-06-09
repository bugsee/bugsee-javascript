import type { Scheduler } from '@bugsee/core';
import type { TransactionWire } from './span';
import type { TransactionStore } from './transaction-store';

// The continuous performance uploader: on an interval it drains the buffered transactions and hands them
// to an injected `send` (which owns the session/Bearer auth + the POST /v2/performance/transactions
// endpoint + the transport — provided by the launch/umbrella, so this stays runtime-portable + testable).
// Delivery is best-effort: a send failure goes to onError and the batch is dropped (the store is bounded
// and the next tick sends fresh data), so performance never blocks or back-pressures the app.

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export interface PerformanceUploaderDeps {
  store: TransactionStore;
  /** Delivers a batch (auth + endpoint + transport). Injected by the launch/umbrella. */
  send: (transactions: TransactionWire[]) => Promise<void>;
  scheduler: Scheduler;
  /** Batched-flush interval in ms. Default 30000. */
  flushIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface PerformanceUploader {
  /** Begin the periodic flush (idempotent). */
  start(): void;
  /** Stop the periodic flush (idempotent). */
  stop(): void;
  /** Drain + send the buffered transactions now. */
  flush(): Promise<void>;
}

export function createPerformanceUploader(deps: PerformanceUploaderDeps): PerformanceUploader {
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const onError = deps.onError ?? (() => {});
  let handle: unknown = null;

  const flush = async (): Promise<void> => {
    const transactions = deps.store.drain();
    if (transactions.length === 0) return;
    try {
      await deps.send(transactions);
    } catch (error) {
      onError(error); // best-effort: drop the batch
    }
  };

  return {
    flush,
    start() {
      if (handle !== null) return;
      handle = deps.scheduler.setInterval(() => {
        void flush();
      }, flushIntervalMs);
    },
    stop() {
      if (handle === null) return;
      deps.scheduler.clearInterval(handle);
      handle = null;
    },
  };
}
