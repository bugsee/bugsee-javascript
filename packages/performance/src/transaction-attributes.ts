import { flattenAttributes, normalizeAttributes } from './attribute-value';
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

/**
 * `normalizeAttributes`, but returning the SAME record when it was already normal (scalars and scalar arrays
 * only, nothing dropped), so the common path copies nothing. A record whose keys or values cannot be read
 * (a Proxy trap, a throwing getter) counts as changed and yields the normalized copy.
 */
function normalizedRecord(attributes: Record<string, unknown>): Record<string, unknown> {
  const normal = normalizeAttributes(attributes);
  try {
    const keys = Object.keys(attributes);
    const same =
      keys.length === Object.keys(normal).length &&
      keys.every((key) => normal[key] === attributes[key]);
    return same ? attributes : normal;
  } catch {
    return normal;
  }
}

/**
 * The FIRST step of the attribute pipeline, for EVERY transaction: bound each span's attributes (one shared
 * span budget, cycles marked, hostile getters contained) before anything walks them. Consumed OTel spans
 * already went through `normalizeAttributes`, but the SDK's own spans carry whatever `setAttribute`,
 * `recordChildSpan({ attributes })` and `recordExternal` were handed, and the redaction walk that follows
 * is only safe on a bounded tree: raw, a node:http request object took 1-2 s, a branching DAG 3-28 s and a
 * self-referencing object never finished. Returns the SAME transaction when nothing needed changing.
 */
export function normalizeTransactionAttributes(transaction: TransactionWire): TransactionWire {
  const root =
    transaction.attributes === undefined ? undefined : normalizedRecord(transaction.attributes);
  let changed = root !== transaction.attributes;
  const spans = transaction.spans.map((span) => {
    if (span.attributes === undefined) return span;
    const attributes = normalizedRecord(span.attributes);
    if (attributes === span.attributes) return span;
    changed = true;
    return { ...span, attributes };
  });
  if (!changed) return transaction;
  return { ...transaction, ...(root !== undefined ? { attributes: root } : {}), spans };
}
