import type { PerformanceApi } from './controller';
import type { RecordChildSpanOptions, Span, SpanStatus, Transaction } from './span';

// The top-level performance calls the mobile SDKs expose as `Bugsee.startTransaction` /
// `Bugsee.startSpan` / `Bugsee.getActiveSpan` (Android Bugsee.java, iOS Bugsee.h). Thin pass-throughs over
// the `ext('performance')` API; when performance is not wired (or switched off) they hand back a no-op
// transaction/span, as the mobile SDKs do, so calling code never needs a guard.

/** The performance calls available directly on the launched client. */
export interface PerformanceFacade {
  /** Start a transaction (the root of a trace). A no-op transaction when performance is disabled. */
  startTransaction(
    name: string,
    operation: string,
    attributes?: Record<string, unknown>,
  ): Transaction;
  /**
   * Start a span. When a span is active it becomes the parent; otherwise the span is the root of a new
   * transaction named after `description` (or the operation). A no-op span when performance is disabled.
   */
  startSpan(operation: string, description?: string): Span;
  /** The active span, if any. */
  getActiveSpan(): Span | undefined;
}

function createNoopSpan(operation: string, description: string | undefined): Span {
  let finished = false;
  const span: Span = {
    setName: () => span,
    setDescription: () => span,
    setAttribute: () => span,
    setStatus: () => span,
    startChildSpan: (childOperation: string, childDescription?: string) =>
      createNoopSpan(childOperation, childDescription),
    recordChildSpan: (_operation: string, _options: RecordChildSpanOptions) => undefined,
    getSpanId: () => '',
    getTraceId: () => '',
    getStatus: (): SpanStatus => 'UNKNOWN',
    getOperation: () => operation,
    getDescription: () => description,
    getAttributes: () => ({}),
    isFinished: () => finished,
    finish: () => {
      finished = true;
    },
  };
  return span;
}

/** A transaction that records nothing: what the facade returns when performance is not available. */
export function createNoopTransaction(
  name: string,
  operation: string,
  description?: string,
): Transaction {
  const span = createNoopSpan(operation, description);
  const transaction: Transaction = {
    ...span,
    setName: () => transaction,
    setDescription: () => transaction,
    setAttribute: () => transaction,
    setStatus: () => transaction,
    getName: () => name,
    isSampled: () => false,
  };
  return transaction;
}

/**
 * Build the facade over a lazily-resolved {@link PerformanceApi}. `getApi` returns `undefined` when the
 * extension is not wired; it is consulted on every call, so a late registration is picked up.
 */
export function createPerformanceFacade(
  getApi: () => PerformanceApi | undefined,
): PerformanceFacade {
  return {
    startTransaction(name, operation, attributes) {
      const api = getApi();
      if (api === undefined) return createNoopTransaction(name, operation);
      const transaction = api.startTransaction({ name, operation });
      if (attributes !== undefined) {
        for (const [key, value] of Object.entries(attributes)) transaction.setAttribute(key, value);
      }
      return transaction;
    },
    startSpan(operation, description) {
      const api = getApi();
      if (api === undefined) return createNoopSpan(operation, description);
      const parent = api.getActiveSpan();
      if (parent !== undefined) return parent.startChildSpan(operation, description);
      return api.startTransaction({
        name: description ?? operation,
        operation,
        ...(description !== undefined ? { description } : {}),
      });
    },
    getActiveSpan() {
      return getApi()?.getActiveSpan();
    },
  };
}
