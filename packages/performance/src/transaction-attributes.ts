import { flattenAttributes } from './attribute-value';
import type { TransactionWire } from './span';

/**
 * The wire step for attributes: after redaction has seen any nested (OpenTelemetry `AnyValue`) value as a
 * tree, flatten what remains to scalars and bounded JSON strings (see attribute-value.ts for the pipeline).
 * Returns the SAME transaction, by reference, when nothing was complex, so the default path copies nothing.
 */
export function flattenTransactionAttributes(transaction: TransactionWire): TransactionWire {
  const root =
    transaction.attributes === undefined ? undefined : flattenAttributes(transaction.attributes);
  let changed = root !== transaction.attributes;
  const spans = transaction.spans.map((span) => {
    if (span.attributes === undefined) return span;
    const attributes = flattenAttributes(span.attributes);
    if (attributes === span.attributes) return span;
    changed = true;
    return { ...span, attributes };
  });
  if (!changed) return transaction;
  return { ...transaction, ...(root !== undefined ? { attributes: root } : {}), spans };
}
