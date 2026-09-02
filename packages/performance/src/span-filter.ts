import { type FilterableSpan, runFilter, type SpanFilter } from '@bugsee/core';
import type { SpanStatus, TransactionWire } from './span';

// The span redaction seam (core's `filters.span`), applied to every finished transaction — the SDK's own
// and every externally recorded one, which is where consumed OpenTelemetry spans arrive.
//
// WHY THIS EXISTS. A consumed OTel span reaches the SDK with its attributes intact: register
// `@opentelemetry/instrumentation-pg` and `db.statement` arrives as raw SQL with literal values in it,
// and the same path carries GenAI prompts/completions and HTTP bodies. Network, log, breadcrumb and
// report streams have all had a filter since the redaction slice; spans had none, so there was no way
// to scrub or drop one short of not consuming OTel at all.

/**
 * The transaction root as a filter sees it. The root IS a span — it has attributes like any other — so
 * it goes through the same filter rather than being exempt, which is what makes a consumed OTel span
 * assembled as a root reachable at all. `name` maps to `description` because that is the field a child
 * span carries the same information in.
 */
const projectRoot = (transaction: TransactionWire): FilterableSpan => ({
  spanId: transaction.spanId,
  ...(transaction.parentSpanId !== undefined ? { parentSpanId: transaction.parentSpanId } : {}),
  operation: transaction.operation,
  description: transaction.name,
  status: transaction.status,
  startTimestampMs: transaction.startTimestampMs,
  ...(transaction.endTimestampMs !== undefined
    ? { endTimestampMs: transaction.endTimestampMs }
    : {}),
  ...(transaction.durationNanos !== undefined ? { durationNanos: transaction.durationNanos } : {}),
  ...(transaction.attributes !== undefined ? { attributes: transaction.attributes } : {}),
});

/**
 * Run `filter` over a transaction's root and every child.
 *
 * Returns the transaction (unchanged and by REFERENCE when no filter is set, so the common path copies
 * nothing), a rewritten one, or `null` when the root was dropped — there is no transaction without its
 * root, so its children go with it rather than being re-parented onto nothing.
 *
 * A throwing filter DROPS the span it threw on and reports once, which is the rule every other filter
 * follows: a filter that threw cannot be assumed to have scrubbed anything, so shipping the span would
 * be shipping exactly the value the user was trying to remove.
 */
export function applySpanFilter(
  transaction: TransactionWire,
  filter: SpanFilter | null,
  onError: (error: unknown) => void,
): TransactionWire | null {
  if (filter === null) {
    return transaction;
  }
  const root = runFilter(filter, projectRoot(transaction), onError);
  if (root === null) {
    return null;
  }
  const spans: TransactionWire['spans'] = [];
  for (const span of transaction.spans) {
    const kept = runFilter(filter, span as FilterableSpan, onError);
    if (kept !== null) {
      // The cast mirrors `FilterableSpan`'s widening of `status` to `string`: core sits below this
      // package and cannot name the `SpanStatus` union, so the narrowing is restored here.
      spans.push(kept as TransactionWire['spans'][number]);
    }
  }
  return {
    ...transaction,
    name: root.description ?? transaction.name,
    operation: root.operation,
    status: root.status as SpanStatus,
    ...(root.attributes !== undefined ? { attributes: root.attributes } : {}),
    spans,
  };
}
