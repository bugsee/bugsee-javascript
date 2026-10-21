import { describe, expect, it } from 'vitest';
import type { TransactionWire } from './span';
import { flattenTransactionAttributes } from './transaction-attributes';

const txn = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: 't'.repeat(32),
  spanId: 'r'.repeat(16),
  name: 'root',
  operation: 'op',
  status: 'OK',
  sampled: true,
  startTimestampMs: 1,
  isSnapshot: false,
  spans: [],
  ...over,
});

const child = (attributes?: Record<string, unknown>): TransactionWire['spans'][number] => ({
  spanId: 'c'.repeat(16),
  operation: 'child',
  status: 'OK',
  startTimestampMs: 1,
  ...(attributes !== undefined ? { attributes } : {}),
});

describe('flattenTransactionAttributes', () => {
  it('returns the SAME transaction when no attribute is complex (the common path copies nothing)', () => {
    const plain = txn({ attributes: { a: 1, tags: ['x'] }, spans: [child({ b: 'y' }), child()] });
    expect(flattenTransactionAttributes(plain)).toBe(plain);
    const bare = txn();
    expect(flattenTransactionAttributes(bare)).toBe(bare);
  });

  it('flattens complex attributes on the root and on every child, leaving the rest untouched', () => {
    const input = txn({
      attributes: { keep: 1, map: { a: { b: 1 } } },
      spans: [child({ list: [1, 'a'] }), child({ ok: true })],
    });
    const out = flattenTransactionAttributes(input);
    expect(out).not.toBe(input);
    expect(out.attributes).toEqual({ keep: 1, map: '{"a":{"b":1}}' });
    expect(out.spans[0]?.attributes).toEqual({ list: '[1,"a"]' });
    expect(out.spans[1]).toBe(input.spans[1]); // untouched child kept by reference
    expect(input.attributes?.map).toEqual({ a: { b: 1 } }); // the input is not mutated
  });

  it('copies only what changed: an unchanged root keeps its attributes reference', () => {
    const rootAttrs = { a: 1 };
    const input = txn({ attributes: rootAttrs, spans: [child({ m: { k: 1 } })] });
    const out = flattenTransactionAttributes(input);
    expect(out.attributes).toBe(rootAttrs);
    expect(out.spans[0]?.attributes).toEqual({ m: '{"k":1}' });
  });
});
