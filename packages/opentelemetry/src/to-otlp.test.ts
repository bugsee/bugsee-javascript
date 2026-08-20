import type { TransactionWire } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
import { OtlpSpanKind, OtlpStatusCode } from './otlp-wire';
import {
  deriveRootSpanId,
  spanKindFor,
  toAnyValue,
  toKeyValues,
  toOtlpExportRequest,
  toStatus,
  toUnixNanoString,
  transactionToOtlpSpans,
} from './to-otlp';

describe('toUnixNanoString', () => {
  it('converts wall-clock ms to a decimal ns string WITHOUT precision loss (BigInt, not Number*1e6)', () => {
    // 1709990000123 * 1e6 = 1.709990000123e18 — beyond 2^53, so Number would lose the low digits.
    expect(toUnixNanoString(1709990000123)).toBe('1709990000123000000');
  });
  it('rounds fractional ms to the nearest ms before scaling', () => {
    expect(toUnixNanoString(10.7)).toBe('11000000');
    expect(toUnixNanoString(0)).toBe('0');
  });
});

describe('toAnyValue', () => {
  it('maps a string to stringValue', () => {
    expect(toAnyValue('x')).toEqual({ stringValue: 'x' });
  });
  it('maps a boolean to boolValue', () => {
    expect(toAnyValue(true)).toEqual({ boolValue: true });
    expect(toAnyValue(false)).toEqual({ boolValue: false });
  });
  it('maps an integer number to intValue as a STRING (int64 JSON)', () => {
    expect(toAnyValue(42)).toEqual({ intValue: '42' });
    expect(toAnyValue(-3)).toEqual({ intValue: '-3' });
  });
  it('maps a non-integer number to doubleValue', () => {
    expect(toAnyValue(3.14)).toEqual({ doubleValue: 3.14 });
  });
  it('maps a bigint to intValue as a string', () => {
    expect(toAnyValue(5n)).toEqual({ intValue: '5' });
  });
  it('JSON-stringifies an object/array into stringValue', () => {
    expect(toAnyValue({ a: 1 })).toEqual({ stringValue: '{"a":1}' });
    expect(toAnyValue([1, 2])).toEqual({ stringValue: '[1,2]' });
  });
  it('returns undefined for undefined/null (the key is dropped)', () => {
    expect(toAnyValue(undefined)).toBeUndefined();
    expect(toAnyValue(null)).toBeUndefined();
  });
  it('returns undefined for an unencodable value (function/symbol → JSON.stringify undefined)', () => {
    expect(toAnyValue(() => 1)).toBeUndefined();
    expect(toAnyValue(Symbol('x'))).toBeUndefined();
  });
});

describe('toKeyValues', () => {
  it('maps an attributes record to KeyValue[], dropping undefined/null values', () => {
    expect(toKeyValues({ a: 'x', b: undefined, c: 2, d: null })).toEqual([
      { key: 'a', value: { stringValue: 'x' } },
      { key: 'c', value: { intValue: '2' } },
    ]);
  });
  it('returns [] for undefined attributes', () => {
    expect(toKeyValues(undefined)).toEqual([]);
  });
});

describe('toStatus', () => {
  it('maps OK to code OK, UNKNOWN to UNSET, and error-ish to ERROR with the status as message', () => {
    expect(toStatus('OK')).toEqual({ code: OtlpStatusCode.OK });
    expect(toStatus('UNKNOWN')).toEqual({ code: OtlpStatusCode.UNSET });
    expect(toStatus('ERROR')).toEqual({ code: OtlpStatusCode.ERROR, message: 'ERROR' });
    expect(toStatus('TIMEOUT')).toEqual({ code: OtlpStatusCode.ERROR, message: 'TIMEOUT' });
    expect(toStatus('DEADLINE_EXCEEDED')).toEqual({
      code: OtlpStatusCode.ERROR,
      message: 'DEADLINE_EXCEEDED',
    });
  });
});

describe('spanKindFor', () => {
  it('maps http.client operations to CLIENT and everything else to INTERNAL', () => {
    expect(spanKindFor('http.client')).toBe(OtlpSpanKind.CLIENT);
    expect(spanKindFor('ui.load')).toBe(OtlpSpanKind.INTERNAL);
    expect(spanKindFor('resource.script')).toBe(OtlpSpanKind.INTERNAL);
  });
});

/**
 * The legacy escape hatch: a `TransactionWire` that predates the `spanId` field. `spanId` is REQUIRED on
 * the current type, so the fallback is unreachable through the type system and needs a cast to reach —
 * which is exactly why it was the one branch in the file no test entered.
 */
describe('transactionToOtlpSpans — the pre-spanId legacy wire', () => {
  it('derives the root span id when the transaction carries none', () => {
    const legacy = {
      traceId: '0123456789ABCDEF0123456789abcdef',
      name: '/legacy',
      operation: 'ui.load',
      status: 'OK',
      sampled: true,
      startTimestampMs: 1000,
      isSnapshot: false,
      spans: [
        { spanId: 'c1c1c1c1c1c1c1c1', operation: 'db.query', status: 'OK', startTimestampMs: 1000 },
      ],
    } as unknown as TransactionWire;

    const [root, child] = transactionToOtlpSpans(legacy);

    // Lowercased, because OTLP requires lowercase hex ids and the legacy trace id may not be.
    expect(root?.spanId).toBe('0123456789abcdef');
    // The child still links to whatever the root was emitted as — a derived id must not orphan it.
    expect(child?.parentSpanId).toBe(root?.spanId);
  });
});

describe('deriveRootSpanId', () => {
  it('derives a stable 8-byte (16-hex) span id from the trace id', () => {
    expect(deriveRootSpanId('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef');
  });
});

const txn = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: '0123456789abcdef0123456789abcdef',
  spanId: 'fedcba9876543210',
  name: '/checkout',
  operation: 'ui.load',
  status: 'OK',
  sampled: true,
  startTimestampMs: 1000,
  endTimestampMs: 1100,
  isSnapshot: false,
  appVersion: '1.2.3',
  appBuild: '456',
  attributes: { custom: 1 },
  spans: [
    {
      spanId: 'aaaaaaaaaaaaaaaa',
      parentSpanId: 'ffffffffffffffff', // the original (dropped) root id → dangling
      operation: 'http.client',
      description: 'GET https://x/a',
      status: 'OK',
      startTimestampMs: 1010,
      endTimestampMs: 1080,
    },
    {
      spanId: 'bbbbbbbbbbbbbbbb',
      parentSpanId: 'aaaaaaaaaaaaaaaa', // a real child → kept as-is
      operation: 'resource.script',
      status: 'OK',
      startTimestampMs: 1020,
      endTimestampMs: 1040,
    },
  ],
  ...over,
});

describe('transactionToOtlpSpans', () => {
  it('emits a root span (its OWN id, no parent) plus the children, linking the tree', () => {
    const spans = transactionToOtlpSpans(txn());
    expect(spans).toHaveLength(3);
    const [root, c1, c2] = spans;
    // Root: id derived from traceId, no parentSpanId, name = transaction name, INTERNAL.
    expect(root).toMatchObject({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: 'fedcba9876543210',
      name: '/checkout',
      kind: OtlpSpanKind.INTERNAL,
      startTimeUnixNano: '1000000000', // 1000 ms → ns
      endTimeUnixNano: '1100000000',
      status: { code: OtlpStatusCode.OK },
    });
    expect(root?.parentSpanId).toBeUndefined();
    // Dangling child parent (pointed at the dropped root id) is remapped to the derived root id.
    expect(c1).toMatchObject({
      spanId: 'aaaaaaaaaaaaaaaa',
      parentSpanId: 'fedcba9876543210',
      name: 'GET https://x/a', // description preferred over operation for the name
      kind: OtlpSpanKind.CLIENT,
    });
    // A real child (parent present among the children) keeps its parentSpanId.
    expect(c2).toMatchObject({
      spanId: 'bbbbbbbbbbbbbbbb',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      name: 'resource.script', // no description → operation is the name
      kind: OtlpSpanKind.INTERNAL,
    });
  });

  it('maps a child to a COMPLETE OTLP span (traceId, ids, kind, timestamps, attributes, non-OK status)', () => {
    // Full toEqual (not toMatchObject) so traceId / status / startTimeUnixNano are all pinned; a non-OK
    // status catches a "collapse to OK" regression.
    const spans = transactionToOtlpSpans(
      txn({
        spans: [
          {
            spanId: 'aaaaaaaaaaaaaaaa',
            parentSpanId: 'ffffffffffffffff', // dangling → remapped to root
            operation: 'http.client',
            description: 'GET https://x/a',
            status: 'ERROR',
            startTimestampMs: 1010,
            endTimestampMs: 1080,
            attributes: { 'http.status_code': 500 },
          },
        ],
      }),
    );
    expect(spans[1]).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: 'aaaaaaaaaaaaaaaa',
      parentSpanId: 'fedcba9876543210',
      name: 'GET https://x/a',
      kind: OtlpSpanKind.CLIENT,
      startTimeUnixNano: '1010000000',
      endTimeUnixNano: '1080000000',
      attributes: [
        { key: 'http.status_code', value: { intValue: '500' } },
        { key: 'bugsee.operation', value: { stringValue: 'http.client' } },
        { key: 'bugsee.span.status', value: { stringValue: 'ERROR' } },
      ],
      status: { code: OtlpStatusCode.ERROR, message: 'ERROR' },
      flags: 1, // the trace's sampled bit (§8), mirrored onto every span
    });
  });

  it('a continued transaction maps the root span as a CHILD of the upstream parent (§12)', () => {
    const root = transactionToOtlpSpans(txn({ parentSpanId: 'eeeeeeeeeeeeeeee' }))[0];
    expect(root?.parentSpanId).toBe('eeeeeeeeeeeeeeee'); // the derived root links up to the inbound span
    // a standalone (non-continued) transaction's root stays parentless:
    expect(transactionToOtlpSpans(txn())[0]?.parentSpanId).toBeUndefined();
  });

  it('maps the root span kind from its operation (http.client → CLIENT)', () => {
    expect(transactionToOtlpSpans(txn({ operation: 'http.client' }))[0]?.kind).toBe(
      OtlpSpanKind.CLIENT,
    );
  });

  it('lets the SDK bugsee.* attributes win over a colliding user attribute (no duplicate key)', () => {
    const root = transactionToOtlpSpans(txn({ attributes: { 'bugsee.operation': 'USER' } }))[0];
    expect(root?.attributes).toContainEqual({
      key: 'bugsee.operation',
      value: { stringValue: 'ui.load' },
    });
    expect(root?.attributes?.filter((a) => a.key === 'bugsee.operation')).toHaveLength(1);
  });

  it('stamps the profile root attrs (transaction.name/sampled/span.status/operation + app version/build), user attrs preserved', () => {
    const root = transactionToOtlpSpans(txn())[0];
    expect(root?.attributes).toEqual([
      { key: 'custom', value: { intValue: '1' } },
      { key: 'bugsee.transaction.name', value: { stringValue: '/checkout' } },
      { key: 'bugsee.sampled', value: { boolValue: true } },
      { key: 'bugsee.span.status', value: { stringValue: 'OK' } },
      { key: 'bugsee.operation', value: { stringValue: 'ui.load' } },
      { key: 'bugsee.app.version', value: { stringValue: '1.2.3' } },
      { key: 'bugsee.app.build', value: { stringValue: '456' } },
    ]);
  });

  it('reflects sampled:false as bugsee.sampled=false', () => {
    const root = transactionToOtlpSpans(txn({ sampled: false }))[0];
    expect(root?.attributes).toContainEqual({ key: 'bugsee.sampled', value: { boolValue: false } });
  });

  it('mirrors the sampled bit into the OTLP span trace flags on EVERY span (Profile v1 §8)', () => {
    const spans = transactionToOtlpSpans(txn()); // sampled: true
    expect(spans.map((s) => s.flags)).toEqual([1, 1, 1]); // root + 2 children all carry the W3C sampled bit
  });

  it('mirrors an UNSAMPLED transaction as trace flags 0 on every span (§8)', () => {
    const spans = transactionToOtlpSpans(txn({ sampled: false }));
    expect(spans.map((s) => s.flags)).toEqual([0, 0, 0]);
  });

  it('adds bugsee.snapshot only when isSnapshot is true; omits app version/build when absent', () => {
    const root = transactionToOtlpSpans(
      txn({ isSnapshot: true, appVersion: undefined, appBuild: undefined, attributes: undefined }),
    )[0];
    expect(root?.attributes).toEqual([
      { key: 'bugsee.transaction.name', value: { stringValue: '/checkout' } },
      { key: 'bugsee.sampled', value: { boolValue: true } },
      { key: 'bugsee.span.status', value: { stringValue: 'OK' } },
      { key: 'bugsee.operation', value: { stringValue: 'ui.load' } },
      { key: 'bugsee.snapshot', value: { boolValue: true } },
    ]);
  });

  it('falls back to the start time for endTimeUnixNano when the transaction has no end', () => {
    const root = transactionToOtlpSpans(txn({ endTimestampMs: undefined }))[0];
    expect(root?.endTimeUnixNano).toBe('1000000000'); // == start
  });

  it('stamps bugsee.operation + bugsee.span.status on child attributes too', () => {
    const c1 = transactionToOtlpSpans(txn())[1];
    expect(c1?.attributes).toEqual([
      { key: 'bugsee.operation', value: { stringValue: 'http.client' } },
      { key: 'bugsee.span.status', value: { stringValue: 'OK' } },
    ]);
  });

  it('maps kind: http.server → SERVER, and an explicit bugsee.span.kind attribute overrides', () => {
    expect(transactionToOtlpSpans(txn({ operation: 'http.server' }))[0]?.kind).toBe(
      OtlpSpanKind.SERVER,
    );
    // An explicit bugsee.span.kind wins over the operation-derived kind.
    expect(
      transactionToOtlpSpans(
        txn({ operation: 'http.client', attributes: { 'bugsee.span.kind': 'SERVER' } }),
      )[0]?.kind,
    ).toBe(OtlpSpanKind.SERVER);
  });

  it('falls back to the child start time for endTimeUnixNano when a child has no end', () => {
    const spans = transactionToOtlpSpans(
      txn({
        spans: [
          {
            spanId: 'dddddddddddddddd',
            operation: 'ui.long-task',
            status: 'OK',
            startTimestampMs: 1234,
          },
        ],
      }),
    );
    expect(spans[1]?.endTimeUnixNano).toBe('1234000000'); // == start
  });

  it('remaps a child with NO parentSpanId to the root', () => {
    const spans = transactionToOtlpSpans(
      txn({
        spans: [
          {
            spanId: 'cccccccccccccccc',
            operation: 'ui.long-task',
            status: 'OK',
            startTimestampMs: 1005,
            endTimestampMs: 1006,
          },
        ],
      }),
    );
    expect(spans[1]?.parentSpanId).toBe('fedcba9876543210');
  });
});

describe('toOtlpExportRequest', () => {
  it('wraps the spans in one resourceSpans/scopeSpans with the resource + scope', () => {
    const req = toOtlpExportRequest([txn()], {
      resource: { 'service.name': 'web', host: 2 },
      scope: { name: 'custom-scope', version: '9.9' },
    });
    expect(req.resourceSpans).toHaveLength(1);
    const rs = req.resourceSpans[0];
    expect(rs?.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'web' } },
      { key: 'host', value: { intValue: '2' } },
      // Profile v1 §4 fixed constants, always present (after the caller's resource).
      { key: 'telemetry.sdk.name', value: { stringValue: 'bugsee' } },
      { key: 'bugsee.profile.version', value: { stringValue: '1' } },
    ]);
    expect(rs?.scopeSpans[0]?.scope).toEqual({ name: 'custom-scope', version: '9.9' });
    expect(rs?.scopeSpans[0]?.spans).toHaveLength(3); // root + 2 children
  });

  it('flattens spans across multiple transactions', () => {
    const req = toOtlpExportRequest([txn(), txn({ traceId: 'fedcba9876543210fedcba9876543210' })]);
    expect(req.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(6);
  });

  it('defaults the scope name/resource and omits the scope version when not given', () => {
    const req = toOtlpExportRequest([txn()]);
    const rs = req.resourceSpans[0];
    // No caller resource → still the Profile v1 §4 fixed constants.
    expect(rs?.resource.attributes).toEqual([
      { key: 'telemetry.sdk.name', value: { stringValue: 'bugsee' } },
      { key: 'bugsee.profile.version', value: { stringValue: '1' } },
    ]);
    expect(rs?.scopeSpans[0]?.scope).toEqual({ name: '@bugsee/opentelemetry' });
    // toEqual ignores a stray `version: undefined`; pin the exact key set so the omit branch is real.
    expect(Object.keys(rs?.scopeSpans[0]?.scope ?? {})).toEqual(['name']);
  });

  it('returns no resourceSpans for an empty transaction list', () => {
    expect(toOtlpExportRequest([])).toEqual({ resourceSpans: [] });
  });
});

// WAVE 5.3 — the OTLP root span id was FABRICATED from the trace id, so a distributed trace never joined.
//
// `deriveRootSpanId(traceId) = traceId.slice(0, 16)` is deterministic, and two independent things break:
//
//  1. THE JOIN. `traceparent` carries `transaction.getSpanId()` — the transaction's REAL span id. A
//     downstream service records that as its `parentSpanId` and emits it. But the upstream service emitted
//     its own root under `traceId[0:16]` instead, so the downstream root points at a span id that was
//     never emitted by anyone. The trace breaks at every service boundary.
//  2. COLLISION. Every service sharing a trace derives the SAME root id, so a two-hop trace contains two
//     different root spans claiming one id.
//
// The real id existed the whole time — minted by `env.newSpanId()`, used as every child's `parentSpanId`,
// and returned by `getSpanId()` for propagation. `toTransactionWire()` simply dropped it.
describe('the OTLP root uses the transaction’s REAL span id (Wave 5.3)', () => {
  const txn = (over: Partial<TransactionWire> = {}): TransactionWire => ({
    traceId: 'a'.repeat(32),
    spanId: 'feedfacecafebeef',
    name: 'GET /users',
    operation: 'http.server',
    status: 'OK',
    sampled: true,
    startTimestampMs: 1000,
    endTimestampMs: 1010,
    isSnapshot: false,
    spans: [],
    ...over,
  });

  it('emits the root with the transaction’s own span id, not a slice of the trace id', () => {
    const [root] = transactionToOtlpSpans(txn());
    expect(root?.spanId).toBe('feedfacecafebeef');
    expect(root?.spanId).not.toBe('a'.repeat(16));
  });

  it('two services in ONE trace emit DIFFERENT root span ids', () => {
    // The collision case: same traceId, different transactions.
    const [a] = transactionToOtlpSpans(txn({ spanId: '1111111111111111' }));
    const [b] = transactionToOtlpSpans(txn({ spanId: '2222222222222222' }));
    expect(a?.spanId).not.toBe(b?.spanId);
  });

  it('a downstream root’s parent is the id the upstream actually EMITTED', () => {
    // The join. Upstream emits its root; downstream continues from the propagated id. The two must meet.
    const upstream = txn({ spanId: 'aaaaaaaaaaaaaaa1' });
    const [upstreamRoot] = transactionToOtlpSpans(upstream);
    // `traceparent` propagates `getSpanId()`, which is the same value the wire now carries.
    const downstream = txn({ spanId: 'bbbbbbbbbbbbbbb2', parentSpanId: upstream.spanId });
    const [downstreamRoot] = transactionToOtlpSpans(downstream);
    expect(downstreamRoot?.parentSpanId).toBe(upstreamRoot?.spanId);
  });

  it('children still hang off the root — the remap must keep working', () => {
    const t = txn({
      spanId: 'feedfacecafebeef',
      spans: [
        { spanId: 'c1', operation: 'db.query', status: 'OK', startTimestampMs: 1001 },
        {
          spanId: 'c2',
          parentSpanId: 'c1',
          operation: 'db.row',
          status: 'ok',
          startTimestampMs: 1002,
        },
      ] as TransactionWire['spans'],
    });
    const [root, first, second] = transactionToOtlpSpans(t);
    expect(first?.parentSpanId).toBe(root?.spanId); // dangling parent → the root
    expect(second?.parentSpanId).toBe('c1'); // a real child parent survives
  });
});
