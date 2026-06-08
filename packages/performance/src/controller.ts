import type { Clock } from '@bugsee/core';
import { createTransaction, type Span, serializeTransaction, type Transaction } from './span';
import type { TransactionStore } from './transaction-store';

// The performance controller — the runtime-portable implementation of the ext('performance') API. It
// starts transactions (head-sampled, stamped with the app version/build), tracks the active span, and
// buffers each SAMPLED transaction into the store when it finishes (the extension drains the store into
// performance.json / the /v2/performance/transactions upload). Active-span tracking is minimal here (the
// most recently started transaction, cleared on its finish); proper async-context propagation is a later
// slice.

/** Options for {@link PerformanceApi.startTransaction}. */
export interface StartTransactionOptions {
  name: string;
  operation: string;
  description?: string;
}

/** The public ext('performance') surface. */
export interface PerformanceApi {
  /** Begin a transaction (the root of a trace). */
  startTransaction(options: StartTransactionOptions): Transaction;
  /**
   * The active span: the most recently STARTED transaction, cleared when it finishes. A minimal
   * single-slot tracker (starting a second transaction overwrites the first; no span stack) — proper
   * async-context nesting is a later slice.
   */
  getActiveSpan(): Span | undefined;
}

export interface PerformanceControllerDeps {
  clock: Clock;
  store: TransactionStore;
  appVersion?: string;
  appBuild?: string;
  /** Head sampling decision, made once per transaction. Default: sample everything. */
  sampler?: () => boolean;
}

export function createPerformanceController(deps: PerformanceControllerDeps): PerformanceApi {
  const sampler = deps.sampler ?? (() => true);
  let active: Transaction | undefined;

  return {
    startTransaction(options) {
      const transaction = createTransaction(
        {
          name: options.name,
          operation: options.operation,
          ...(options.description !== undefined ? { description: options.description } : {}),
          sampled: sampler(),
          ...(deps.appVersion !== undefined ? { appVersion: deps.appVersion } : {}),
          ...(deps.appBuild !== undefined ? { appBuild: deps.appBuild } : {}),
        },
        {
          clock: deps.clock,
          onFinish: (finished) => {
            if (finished.isSampled()) deps.store.add(serializeTransaction(finished));
            if (active === finished) active = undefined;
          },
        },
      );
      active = transaction;
      return transaction;
    },
    getActiveSpan() {
      return active;
    },
  };
}
