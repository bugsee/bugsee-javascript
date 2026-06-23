import type { Clock } from '@bugsee/core';
import {
  createTransaction,
  type Span,
  serializeTransaction,
  type Transaction,
  type TransactionWire,
} from './span';
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
  /**
   * Continue an inbound distributed trace (Bugsee OTLP Profile v1 §12; design: cross-project-tracing.md).
   * The transaction adopts this W3C `traceId`, makes its root a CHILD of the upstream `parentSpanId`, and
   * adopts the upstream `sampled` decision — so the frontend and this backend transaction are one trace
   * with a real parent/child link. Omitted → a fresh random trace id, no parent, local sampling.
   */
  continuation?: { traceId: string; parentSpanId?: string; sampled?: boolean };
}

/** Provenance of a transaction's current NAME (frontend-adapters D5, the two-phase naming seam). `url` =
 *  the raw browser path (phase 1, on navigation start); `route` = a resolved/parameterized route
 *  (`/users/:id`, phase 2 — a framework adapter refined it once routing ran); `custom` = an app-supplied
 *  name. Stamped on the transaction as `bugsee.name_source`. */
export type TransactionNameSource = 'url' | 'route' | 'custom';

/** The attribute key the naming seam stamps to record {@link TransactionNameSource}. */
export const NAME_SOURCE_ATTRIBUTE = 'bugsee.name_source';

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
  /**
   * Rename the ACTIVE transaction (the in-flight pageload / navigation / interaction) and stamp the naming
   * provenance (`bugsee.name_source`). The frontend-adapters naming seam (D5) + the D10 REFINE half: a
   * framework adapter (or the app) refines the raw-URL navigation name to the resolved route once routing
   * has run — the second phase of two-phase naming. A NO-OP when no transaction is active (nothing to
   * name). Default `source` is `custom`.
   */
  setActiveTransactionName(name: string, opts?: { source?: TransactionNameSource }): void;
  /** Sugar for {@link setActiveTransactionName}(name, { source: 'route' }) — the manual route-naming
   *  escape hatch (D5); what a router adapter calls on navigation resolve. */
  setRouteName(name: string): void;
}

export interface PerformanceControllerDeps {
  clock: Clock;
  store: TransactionStore;
  appVersion?: string;
  appBuild?: string;
  /** Head sampling decision, made once per transaction. Default: sample everything. */
  sampler?: () => boolean;
  /** Called with the serialized wire of each SAMPLED finished transaction (e.g. to also route it to the
   *  capture ring for the bundle's performance.json, alongside the store's /v2 upload). */
  onFinished?: (transaction: TransactionWire) => void;
}

export function createPerformanceController(deps: PerformanceControllerDeps): PerformanceApi {
  const sampler = deps.sampler ?? (() => true);
  let active: Transaction | undefined;

  return {
    startTransaction(options) {
      const continuation = options.continuation;
      const transaction = createTransaction(
        {
          name: options.name,
          operation: options.operation,
          ...(options.description !== undefined ? { description: options.description } : {}),
          // Continuation: the root becomes a child of the upstream span, and we ADOPT the upstream
          // sampling decision (respect what the originator decided); otherwise our local sampler decides.
          ...(continuation?.parentSpanId !== undefined
            ? { parentSpanId: continuation.parentSpanId }
            : {}),
          sampled: continuation?.sampled ?? sampler(),
          ...(deps.appVersion !== undefined ? { appVersion: deps.appVersion } : {}),
          ...(deps.appBuild !== undefined ? { appBuild: deps.appBuild } : {}),
        },
        {
          clock: deps.clock,
          // Trace continuation: adopt the inbound trace id so the upstream trace and this transaction
          // share a trace (the root span starts a new span id under that trace).
          ...(continuation !== undefined ? { newTraceId: () => continuation.traceId } : {}),
          onFinish: (finished) => {
            if (finished.isSampled()) {
              const wire = serializeTransaction(finished);
              deps.store.add(wire); // the continuous /v2 (+ OTLP tee) buffer
              deps.onFinished?.(wire); // also route it to the capture ring (bundle performance.json)
            }
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
    setActiveTransactionName(name, opts) {
      if (active === undefined) return; // nothing in flight to name
      active.setName(name);
      active.setAttribute(NAME_SOURCE_ATTRIBUTE, opts?.source ?? 'custom');
    },
    setRouteName(name) {
      if (active === undefined) return;
      active.setName(name);
      active.setAttribute(NAME_SOURCE_ATTRIBUTE, 'route');
    },
  };
}
