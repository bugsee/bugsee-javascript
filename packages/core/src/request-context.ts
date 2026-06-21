import { serviceToken } from '@bugsee/service';
import type { AttributeValue } from '@bugsee/types';

// A transient, per-request execution context (design: docs/design/framework-adapters.md). It is born when
// a request / unit of work begins, isolated across concurrent work by a runtime binding (the Node
// AsyncLocalStorage store), and discarded when it ends. It carries (a) the identity to MERGE into any
// report produced WITHIN it (user / attributes, over the global Environment) and (b) the correlation ids
// STAMPED onto every capture entry recorded within it (contextId always, the trace ids when a trace is
// active), so the full recording can later be focused on this one request ("correlation, not isolation").
//
// Portable: no runtime APIs here. Runtime bindings (@bugsee/node) + adapters (@bugsee/express) create and
// populate it; @bugsee/core only READS the active one through a ContextProvider.

export interface RequestContext {
  /** Stable id for this context; stamped onto every capture entry recorded within it, and onto the report. */
  readonly contextId: string;
  /** End-user identity for reports produced in this context (wire `email`); overrides the global user. */
  user?: string;
  /** Custom attributes merged into reports produced in this context (over the global attributes). */
  attributes?: Record<string, AttributeValue>;
  /** The active W3C trace when a transaction is in flight; stamped onto capture entries for correlation.
   * `sampled` is the trace's sampling decision (Profile v1 §8) — used for the outbound `traceparent` flags. */
  trace?: { readonly traceId: string; readonly spanId: string; readonly sampled: boolean };
}

/** Reads the active RequestContext for the current execution, or `undefined` when none is open. */
export interface ContextProvider {
  getCurrent(): RequestContext | undefined;
}

/**
 * DI token for the optional ContextProvider. A runtime binding (the Node ALS store) registers it when
 * present; it is absent by default, so the capture aggregator's stamping and report assembly's merge are
 * no-ops and the SDK's behavior is byte-identical to today's for non-adapter users.
 */
export const ContextProviderToken = serviceToken<ContextProvider>('context-provider');
