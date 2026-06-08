import type { TransactionWire } from './span';

// The in-memory performance buffer: finished, serialized transactions accumulate here until they are
// drained — into the incident bundle's performance.json and/or the continuous /v2/performance/
// transactions upload. Bounded (FIFO eviction of the oldest) so it can never grow without limit.

export interface TransactionStore {
  /** Append a finished transaction wire (evicting the oldest if at capacity). */
  add(transaction: TransactionWire): void;
  /** Return every buffered transaction (a detached copy) and clear the buffer. */
  drain(): TransactionWire[];
  /** The number of buffered transactions. */
  size(): number;
}

export interface TransactionStoreOptions {
  /** Max buffered transactions before the oldest is dropped. Default 100. */
  maxTransactions?: number;
}

export function createTransactionStore(options: TransactionStoreOptions = {}): TransactionStore {
  const max = options.maxTransactions ?? 100;
  let buffer: TransactionWire[] = [];
  return {
    add(transaction) {
      buffer.push(transaction);
      if (buffer.length > max) buffer.shift(); // FIFO: drop the oldest
    },
    drain() {
      const drained = buffer;
      buffer = [];
      return drained;
    },
    size() {
      return buffer.length;
    },
  };
}
