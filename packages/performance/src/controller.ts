import type { Clock } from '@bugsee/core';
import { NAME_SOURCE_ATTRIBUTE } from '@bugsee/protocol';
import { type ActiveSpanStore, createSingleSlotActiveSpanStore } from './active-span-store';
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
// performance.json / the /v2/performance/transactions upload). Active-span tracking lives behind the
// injectable `activeSpanStore` seam (a process-wide single slot by default; per-async-context on the
// Node umbrella launch); a span stack is a later slice.

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
   * The active span: the most recently STARTED transaction visible to this execution, cleared when it
   * finishes. No span stack — proper async-context nesting is a later slice.
   *
   * CONCURRENCY (round-2 D2): WHERE the slot lives is injectable (`activeSpanStore`). The DEFAULT is
   * a process-wide single slot (a second `startTransaction` overwrites the first) — correct for a
   * browser's single in-flight navigation/interaction. The Node launch instead supplies per-async-context
   * tracking keyed off the `AsyncLocalStorage`-backed `RequestContext` (the JS equivalent of Android's
   * `ThreadLocal`-keyed `SpanContextHolder`), so concurrent requests stay isolated ON THE DEFAULT
   * AUTO-INSTRUMENTED PATH, where every request runs in a fresh ALS context (the `node:http` emit patch,
   * native serve wraps, express/koa/hono). Requests that genuinely SHARE one context object (a lingering
   * `enterWith` reused across dispatches with `instrumentIncomingRequests: false`) share the stash too —
   * isolation is exactly as isolated as the context object is. Server-side route naming should still
   * prefer the request-scoped `ServerRequestSpan.setRoute()` (what every built-in adapter does) over
   * this API from concurrent server code.
   */
  getActiveSpan(): Span | undefined;
  /**
   * Rename the ACTIVE transaction (the in-flight pageload / navigation / interaction) and stamp the naming
   * provenance (`bugsee.name_source`). The frontend-adapters naming seam (D5) + the D10 REFINE half: a
   * framework adapter (or the app) refines the raw-URL navigation name to the resolved route once routing
   * has run — the second phase of two-phase naming. A NO-OP when no transaction is active (nothing to
   * name). Default `source` is `custom`.
   *
   * Without a request-scoped store (the bare-controller default), on a Node server with requests in
   * flight concurrently this can rename a DIFFERENT request's transaction than the caller intended
   * (see the {@link getActiveSpan} CONCURRENCY note). Under the Node umbrella launch the slot is
   * request-scoped, so this renames the caller's own request — though server-side route naming should
   * still prefer the request-scoped `ServerRequestSpan.setRoute()` (what every built-in adapter does).
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
  /**
   * Where the active transaction lives. Default a process-wide single slot (last-started wins) —
   * correct for a browser's one in-flight navigation/interaction. A concurrent server passes a
   * per-execution-context store (Node keys it off the AsyncLocalStorage-backed `RequestContext`)
   * so one request's `startTransaction` never overwrites another's (D2 part 2).
   */
  activeSpanStore?: ActiveSpanStore;
  /**
   * Internal-error sink. The ONLY thing reported here is a store that breaks its must-not-throw
   * contract (R-3): degrading silently would stop route naming dead with no signal anywhere. Latched
   * per call site, so a store throwing on every outgoing network call reports once, not once a call.
   */
  onError?: (error: unknown) => void;
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
  const activeSpanStore = deps.activeSpanStore ?? createSingleSlotActiveSpanStore();
  // A store that breaks its must-not-throw contract degrades the controller to untracked (usable
  // transactions, no active slot) rather than throwing into user code — but it is REPORTED, once per
  // site. Silence was the defect: a broken `get()` makes both naming seams no-ops, so route naming
  // stops with nothing to find it by. Latched per site (not per call) because `get()` runs on every
  // outgoing network call; latched per CONTROLLER (not module-hoisted) so sibling controllers in one
  // process each keep their own report. The sink is user code, so its own throw is absorbed.
  const reported = new Set<'get' | 'set' | 'clear' | 'name'>();
  const degraded = (site: 'get' | 'set' | 'clear' | 'name', error: unknown): void => {
    if (reported.has(site)) return;
    reported.add(site);
    try {
      deps.onError?.(error);
    } catch {
      // A broken sink must never become the caller's outcome (node active-span-store precedent).
    }
  };
  const readActive = (): Span | undefined => {
    try {
      return activeSpanStore.get();
    } catch (error) {
      degraded('get', error);
      return undefined;
    }
  };
  // Naming is guarded SEPARATELY from the read: a custom store can hand back a hostile transaction as
  // easily as it can throw from `get()`, and the contract promises the controller never propagates
  // either into the caller. Both naming seams run through here, so the guard covers exactly the
  // surface the contract claims. A degraded name is a lost rename, never a throw out of user code.
  const nameActive = (name: string, source: TransactionNameSource): void => {
    const active = readActive();
    if (active === undefined) return; // nothing in flight to name
    try {
      active.setName(name);
      active.setAttribute(NAME_SOURCE_ATTRIBUTE, source);
    } catch (error) {
      degraded('name', error);
    }
  };

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
            // When the active root finishes, the slot CLEARS — it is NOT reverted to a still-open
            // pageload (there is no span stack; D11). Consequence: a fetch between activity transactions
            // (after a navigation/interaction idle-finishes, before the next one) attaches to nothing and
            // is dropped, even though the pageload lingers. Accepted tradeoff of that model; a span stack /
            // pageload-fallback is a later slice (see frontend-adapters D11/D12).
            // Cleared by identity, not by re-reading: clear() drops the transaction WHEREVER the
            // store holds it, and a non-held finish clears nothing. (A scoped store may hold it somewhere
            // other than what the finishing execution observes — e.g. an ambient slot it can no longer
            // read — so matching by re-reading here would miss.)
            try {
              activeSpanStore.clear(finished);
            } catch (error) {
              // A throwing custom store (against the must-not-throw contract) degrades to untracked
              // rather than breaking the finish path.
              degraded('clear', error);
            }
          },
        },
      );
      try {
        activeSpanStore.set(transaction);
      } catch (error) {
        // A throwing custom store (against the must-not-throw contract) degrades to untracked: the
        // transaction stays usable, only active tracking is lost — never a throw into user code.
        degraded('set', error);
      }
      return transaction;
    },
    getActiveSpan() {
      return readActive();
    },
    setActiveTransactionName(name, opts) {
      nameActive(name, opts?.source ?? 'custom');
    },
    setRouteName(name) {
      nameActive(name, 'route');
    },
  };
}
