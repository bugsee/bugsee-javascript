import { describe, expect, it } from 'vitest';
import type { TransactionWire } from './span';
import {
  flattenTransactionAttributes,
  normalizeTransactionAttributes,
} from './transaction-attributes';

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
  it('returns a NEW record (equal content) when an attribute is an array: arrays are always copied', () => {
    const input = txn({ attributes: { tags: ['x'] }, spans: [child({ list: ['a', 'b'] })] });
    const out = flattenTransactionAttributes(input);
    expect(out).toEqual(input);
    expect(out.attributes?.tags === input.attributes?.tags).toBe(false);
    expect(out.spans[0]?.attributes?.list === input.spans[0]?.attributes?.list).toBe(false);
  });

  it('returns the SAME transaction when no attribute is complex (the common path copies nothing)', () => {
    const plain = txn({ attributes: { a: 1, ok: true }, spans: [child({ b: 'y' }), child()] });
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

const dag = (levels: number, fanout: number): unknown => {
  let node: unknown = { leaf: 'v' };
  for (let i = 0; i < levels; i++) {
    const level: Record<string, unknown> = {};
    for (let j = 0; j < fanout; j++) level[`k${j}`] = node;
    node = level;
  }
  return node;
};

describe('normalizeTransactionAttributes (SDK-produced spans carry RAW values too)', () => {
  it('returns an equal transaction when every attribute is already a scalar or scalar array', () => {
    const plain = txn({ attributes: { a: 1, tags: ['x'] }, spans: [child({ b: 'y' }), child()] });
    expect(normalizeTransactionAttributes(plain)).toEqual(plain);
    const bare = txn();
    expect(normalizeTransactionAttributes(bare)).toBe(bare); // nothing to read, nothing copied
  });

  it('always carries a COPY forward: a getter cannot answer differently when a later step re-reads it', () => {
    let reads = 0;
    const attributes = {
      get flip(): unknown {
        reads++;
        return reads === 1 ? 'ok' : dag(14, 3);
      },
    };
    const out = normalizeTransactionAttributes(txn({ attributes }));
    expect(reads).toBe(1); // read exactly once, by the normalization itself
    expect(out.attributes).toEqual({ flip: 'ok' });
    expect(out.attributes === attributes).toBe(false); // (a matcher would re-read the getter)
    expect(Object.getOwnPropertyDescriptor(out.attributes, 'flip')?.get).toBeUndefined();
    expect(out.attributes?.flip).toBe('ok'); // a plain data property, stable on every read
    expect(reads).toBe(1);
  });

  it('keeps a child without attributes as is, and handles a root without attributes', () => {
    const bare = child();
    const out = normalizeTransactionAttributes(txn({ attributes: { a: 1 }, spans: [bare] }));
    expect(out.spans[0]).toBe(bare);
    const rootless = normalizeTransactionAttributes(txn({ spans: [child({ b: 1 })] }));
    expect(rootless.attributes).toBeUndefined();
    expect(rootless.spans[0]?.attributes).toEqual({ b: 1 });
  });

  it('drops a key whose value is undefined (the copy differs from the input)', () => {
    const t = txn({ attributes: { ok: 'x', gone: undefined } });
    const n = normalizeTransactionAttributes(t);
    expect(n).not.toBe(t);
    expect(Object.hasOwn(n.attributes ?? {}, 'gone')).toBe(false);
  });

  it('turns raw complex values (a DAG, a cycle, a throwing getter) into bounded trees on root and children', () => {
    const cyc: Record<string, unknown> = {};
    for (let j = 0; j < 3; j++) cyc[`k${j}`] = cyc;
    const hostile = {
      ok: 1,
      get boom(): never {
        throw new Error('getter');
      },
    };
    const input = txn({
      attributes: { dag: dag(14, 3), cyc, plain: 1 },
      spans: [child({ hostile, nul: null })],
    });
    const started = Date.now();
    const out = normalizeTransactionAttributes(input);
    expect(Date.now() - started).toBeLessThan(2000); // 3^14 = 4.7M paths walked raw
    expect(JSON.stringify(out.attributes).length).toBeLessThan(200_000);
    expect(out.attributes?.plain).toBe(1);
    expect(JSON.stringify(out.attributes?.cyc)).toContain('[Circular]');
    expect(out.spans[0]?.attributes).toEqual({ hostile: { ok: 1, boom: '[Unreadable]' } });
    expect(input.attributes?.plain).toBe(1); // input untouched
  });

  it('shares one budget across a span: many large attributes cannot each take a full share', () => {
    const wide = (): Record<string, unknown> =>
      Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, 0]));
    const attributes = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a${i}`, wide()]));
    const out = normalizeTransactionAttributes(txn({ attributes }));
    const sizes = Object.values(out.attributes ?? {}).map(
      (v) => Object.keys(v as Record<string, unknown>).length,
    );
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(6000); // 40 x 1000 members unbounded; the span budget is 4096 nodes
    expect(out.attributes?.a39).toBe('[Truncated]');
  });

  it('also caps the characters copied per span, not only the node count', () => {
    const attributes = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`a${i}`, { text: 'x'.repeat(8000) }]),
    );
    const out = normalizeTransactionAttributes(txn({ attributes }));
    expect(JSON.stringify(out.attributes).length).toBeLessThan(120_000); // 40 x 8 KB unbounded
    expect(out.attributes?.a0).toEqual({ text: 'x'.repeat(8000) });
    expect(out.attributes?.a39).toBe('[Truncated]');
  });

  it('survives an attribute record whose keys cannot be listed (a Proxy with a throwing ownKeys trap)', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    const out = normalizeTransactionAttributes(
      txn({ attributes: hostile, spans: [child(hostile)] }),
    );
    expect(out.attributes).toEqual({});
    expect(out.spans[0]?.attributes).toEqual({});
  });
});
