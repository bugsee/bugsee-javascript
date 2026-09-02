import type { FilterableSpan } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionWire } from './span';
import { applySpanFilter } from './span-filter';

const txn = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: 't1',
  spanId: 's-root',
  name: 'GET /orders',
  operation: 'http.server',
  status: 'OK',
  sampled: true,
  startTimestampMs: 1000,
  endTimestampMs: 1100,
  isSnapshot: false,
  spans: [],
  ...over,
});

const child = (over: Partial<TransactionWire['spans'][number]> = {}) => ({
  spanId: 's-1',
  parentSpanId: 's-root',
  operation: 'db.query',
  status: 'OK' as const,
  startTimestampMs: 1010,
  endTimestampMs: 1050,
  attributes: { 'db.statement': "SELECT * FROM users WHERE email = 'a@b.com'" },
  ...over,
});

describe('applySpanFilter', () => {
  it('applies the BUILT-IN sanitizer when no filter is set', () => {
    // "No filter" does not mean "no scrubbing": consuming OpenTelemetry brings in SQL, prompts and
    // bodies the SDK never produced, and the default is that they are captured scrubbed.
    const out = applySpanFilter(txn({ spans: [child()] }), null, () => {});
    expect(out?.spans[0]?.attributes?.['db.statement']).toBe('SELECT * FROM users WHERE email = ?');
  });

  it('returns the SAME transaction by reference when the sanitizer changed nothing', () => {
    // The built-in runs on every transaction the SDK produces, so it must not rebuild all of them to
    // change nothing.
    const t = txn({ spans: [child({ attributes: { 'db.system': 'postgresql' } })] });
    expect(applySpanFilter(t, null, () => {})).toBe(t);
  });

  it('can be turned off, leaving the transaction untouched', () => {
    const t = txn({ spans: [child()] });
    expect(applySpanFilter(t, null, () => {}, false)).toBe(t);
  });

  it('scrubs an attribute on a CHILD span', () => {
    // The motivating case: `@opentelemetry/instrumentation-pg` puts the executed SQL, literals included,
    // on `db.statement`. Before this existed there was no seam to reach it.
    const redact = (s: FilterableSpan): FilterableSpan =>
      s.attributes?.['db.statement'] === undefined
        ? s
        : { ...s, attributes: { ...s.attributes, 'db.statement': '<redacted>' } };
    const out = applySpanFilter(txn({ spans: [child()] }), redact, () => {});
    expect(out?.spans[0]?.attributes?.['db.statement']).toBe('<redacted>');
  });

  it('DROPS a child the filter rejects, keeping the rest of the transaction', () => {
    const out = applySpanFilter(
      txn({ spans: [child(), child({ spanId: 's-2', operation: 'http.client' })] }),
      (s) => (s.operation === 'db.query' ? null : s),
      () => {},
    );
    expect(out?.spans.map((s) => s.spanId)).toEqual(['s-2']);
  });

  it('runs for the transaction ROOT too, and mutating it rewrites the transaction', () => {
    // The root carries attributes like any other span — a consumed OTel span assembled as a root would
    // otherwise be unreachable by the filter.
    const out = applySpanFilter(
      txn({ attributes: { 'http.url': 'https://x.test/?token=abc' } }),
      (s) => ({ ...s, attributes: { ...s.attributes, 'http.url': '<redacted>' } }),
      () => {},
    );
    expect(out?.attributes?.['http.url']).toBe('<redacted>');
    expect(out?.name).toBe('GET /orders'); // the root's NAME survives the projection round trip
  });

  it('lets the filter rename the root through `description`', () => {
    const out = applySpanFilter(
      txn(),
      (s) => ({ ...s, description: 'GET /orders/:id' }),
      () => {},
    );
    expect(out?.name).toBe('GET /orders/:id');
  });

  it('DROPS the whole transaction when the filter rejects the root', () => {
    // There is no transaction without its root, so children go with it rather than being re-parented.
    expect(
      applySpanFilter(
        txn({ spans: [child()] }),
        () => null,
        () => {},
      ),
    ).toBeNull();
  });

  it('DROPS the span and reports when the filter THROWS, rather than shipping it unscrubbed', () => {
    // Same rule the other filters follow: a throwing filter cannot be assumed to have scrubbed anything,
    // so the privacy-safe answer is to drop.
    const onError = vi.fn();
    const out = applySpanFilter(
      txn({ spans: [child()] }),
      (s) => {
        if (s.operation === 'db.query') throw new Error('bad filter');
        return s;
      },
      onError,
    );
    expect(out?.spans).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('drops the whole transaction when the filter throws on the ROOT', () => {
    const onError = vi.fn();
    expect(
      applySpanFilter(
        txn(),
        () => {
          throw new Error('bad filter');
        },
        onError,
      ),
    ).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('applySpanFilter — the optional fields survive the root projection', () => {
  it('round-trips a MINIMAL root (no parent, no duration, no attributes) without inventing fields', () => {
    // The projection builds the root's filter view field by field; a spread that fired unconditionally
    // would put `parentSpanId: undefined` on a root span, which is a different thing from a root with
    // no parent once it reaches the wire.
    const seen: FilterableSpan[] = [];
    const minimal = txn({ spans: [] });
    delete (minimal as { endTimestampMs?: number }).endTimestampMs;
    const out = applySpanFilter(
      minimal,
      (s) => {
        seen.push(s);
        return s;
      },
      () => {},
    );
    expect(Object.keys(seen[0] ?? {})).not.toContain('parentSpanId');
    expect(Object.keys(seen[0] ?? {})).not.toContain('durationNanos');
    expect(Object.keys(seen[0] ?? {})).not.toContain('attributes');
    expect(Object.keys(seen[0] ?? {})).not.toContain('endTimestampMs');
    expect(Object.keys(out ?? {})).not.toContain('attributes');
  });

  it('carries a root that DOES have every optional field through to the filter', () => {
    const seen: FilterableSpan[] = [];
    applySpanFilter(
      txn({ parentSpanId: 's-up', durationNanos: 5_000, attributes: { a: 1 } }),
      (s) => {
        seen.push(s);
        return s;
      },
      () => {},
    );
    expect(seen[0]).toMatchObject({
      parentSpanId: 's-up',
      durationNanos: 5_000,
      attributes: { a: 1 },
      endTimestampMs: 1100,
    });
  });
});
