import type { Clock } from '@bugsee/core';
import { NAME_SOURCE_ATTRIBUTE } from '@bugsee/protocol';
import {
  createTransaction,
  type Span,
  serializeTransaction,
  type Transaction,
  type TransactionWire,
} from './span';
import type { TransactionStore } from './transaction-store';

// R2-8: NAME_SOURCE_ATTRIBUTE is a plain wire attribute KEY, not APM logic — it now lives in
// @bugsee/protocol (constants.ts) so @bugsee/node's server-instrument.ts can read it off a Transaction's
// attributes without a runtime (value-level) dependency on this opt-in extension. Re-exported here for
// every existing @bugsee/performance consumer (this file's own setters below, navigations.ts, index.ts).
export { NAME_SOURCE_ATTRIBUTE };

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

/** The public ext('performance') surface. */
export interface PerformanceApi {
  /** Begin a transaction (the root of a trace). */
  startTransaction(options: StartTransactionOptions): Transaction;
  /**
   * The active span: the most recently STARTED transaction, cleared when it finishes. A minimal
   * single-slot tracker (starting a second transaction overwrites the first; no span stack) — proper
   * async-context nesting is a later slice.
   *
   * CONCURRENCY (round-2 D2, tracked, not yet fixed): this slot is process-wide, not per-request. On a
   * Node server handling concurrent requests, a second `startTransaction` (a second in-flight request)
   * overwrites the slot before the first request calls this — so a call intended for request A can read/
   * name request B's transaction. Android's parity implementation (`SpanContextHolder`) avoids this by
   * keying the active span off a `ThreadLocal`, i.e. per execution context, not one shared variable — the
   * fix here is the JS equivalent (per-async-context tracking, e.g. via the same `AsyncLocalStorage`-backed
   * `RequestContext` `@bugsee/node` already threads through `server-instrument.ts`). SAFE today: no
   * built-in server adapter calls `setActiveTransactionName`/`setRouteName` — they all refine their OWN
   * request's span via the request-scoped `ServerRequestSpan.setRoute()` (`@bugsee/node`), which reads the
   * per-request context, NOT this slot. Prefer that request-scoped path over this API from concurrent
   * server code; this API remains correct for a browser's single in-flight navigation/interaction.
   */
  getActiveSpan(): Span | undefined;
  /**
   * Rename the ACTIVE transaction (the in-flight pageload / navigation / interaction) and stamp the naming
   * provenance (`bugsee.name_source`). The frontend-adapters naming seam (D5) + the D10 REFINE half: a
   * framework adapter (or the app) refines the raw-URL navigation name to the resolved route once routing
   * has run — the second phase of two-phase naming. A NO-OP when no transaction is active (nothing to
   * name). Default `source` is `custom`.
   *
   * See the {@link getActiveSpan} CONCURRENCY note: on a Node server with requests in flight
   * concurrently, this can rename a DIFFERENT request's transaction than the caller intended. Server-side
   * route naming should go through the request-scoped `ServerRequestSpan.setRoute()` instead (what every
   * built-in adapter does); this method is safe for a browser's single active navigation.
   */
  setActiveTransactionName(name: string, opts?: { source?: TransactionNameSource }): void;
  /** Sugar for {@link setActiveTransactionName}(name, { source: 'route' }) — the manual route-naming
   *  escape hatch (D5); what a router adapter calls on navigation resolve. See the {@link getActiveSpan}
   *  CONCURRENCY note before calling this from concurrent Node server-request code. */
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
  /**
   * Redaction seam applied to each finished transaction before it reaches EITHER sink. Returns null to
   * drop the transaction entirely. Default: no filtering.
   *
   * It has to run here rather than at the sinks because the store and the capture ring are separate
   * writes — filtering at one would ship the unscrubbed span through the other.
   */
  filterTransaction?: (transaction: TransactionWire) => TransactionWire | null;
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
              const serialized = serializeTransaction(finished);
              // NOT `?? serialized`: the filter returning null MEANS drop, and `null ?? serialized`
              // would resurrect exactly the transaction it just rejected.
              const wire =
                deps.filterTransaction === undefined
                  ? serialized
                  : deps.filterTransaction(serialized);
              if (wire !== null) {
                deps.store.add(wire); // the continuous /v2 (+ OTLP tee) buffer
                deps.onFinished?.(wire); // also route it to the capture ring (performance.json)
              }
            }
            // Single-slot (D11): when the active root finishes, the slot CLEARS — it is NOT reverted to a
            // still-open pageload (there is no span stack). Consequence: a fetch between activity
            // transactions (after a navigation/interaction idle-finishes, before the next one) attaches to
            // nothing and is dropped, even though the pageload lingers. Accepted tradeoff of the single-slot
            // model; a span stack / pageload-fallback is a later slice (see frontend-adapters D11/D12).
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
