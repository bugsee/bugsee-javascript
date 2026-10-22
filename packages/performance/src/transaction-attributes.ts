import { flattenAttributes, normalizeAttributes } from './attribute-value';
import type { TransactionWire } from './span';

/**
 * The wire step for attributes: after redaction has seen any nested (OpenTelemetry `AnyValue`) value as a
 * tree, flatten what remains to scalars and bounded JSON strings (see attribute-value.ts for the pipeline).
 * Returns the SAME transaction, by reference, only when every attribute is already a scalar; any array
 * attribute is copied (a filter may hold the array it set), so a transaction with one comes back as a new record.
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

/**
 * The FIRST step of the attribute pipeline, for EVERY transaction: bound each span's attributes (one shared
 * span budget, cycles marked, hostile getters contained) before anything walks them. Consumed OTel spans
 * already went through `normalizeAttributes`, but the SDK's own spans carry whatever `setAttribute`,
 * `recordChildSpan({ attributes })` and `recordExternal` were handed, and the redaction walk that follows
 * is only safe on a bounded tree: raw, a node:http request object took 1-2 s, a branching DAG 3-28 s and a
 * self-referencing object never finished. Always carries the normalized COPY forward (never the caller's record), so every later step reads plain
 * data properties once-evaluated instead of re-reading getters or proxies. A transaction with no attributes
 * is returned as is.
 */
export function normalizeTransactionAttributes(transaction: TransactionWire): TransactionWire {
  if (
    transaction.attributes === undefined &&
    transaction.spans.every((span) => span.attributes === undefined)
  ) {
    return transaction; // nothing to read, nothing copied
  }
  return {
    ...transaction,
    ...(transaction.attributes !== undefined
      ? { attributes: normalizeAttributes(transaction.attributes) }
      : {}),
    spans: transaction.spans.map((span) =>
      span.attributes === undefined
        ? span
        : { ...span, attributes: normalizeAttributes(span.attributes) },
    ),
  };
}
