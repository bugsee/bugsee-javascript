import type { SpanStatus, SpanWire, TransactionWire } from '@bugsee/performance';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromOtlpStatus } from './from-otlp';
import { OTLP_SPAN_FLAG_SAMPLED, OtlpSpanKind } from './otlp-wire';
import {
  spanKindFor,
  toAnyValue,
  toKeyValues,
  toOtlpExportRequest,
  toStatus,
  transactionToOtlpSpans,
} from './to-otlp';

/**
 * Property-based tests for the OTLP mapping.
 *
 * This package's output is a WIRE CONTRACT with software we do not control: whatever we POST to
 * `/v1/traces` is parsed by a third-party collector against the OTLP/JSON schema, and a payload that
 * violates it is rejected WHOLE — one malformed attribute on one span loses the entire batch, silently,
 * in the customer's collector rather than anywhere we can see.
 *
 * So the properties here assert the SPEC, not the implementation: the proto3 JSON mapping says uint64
 * fields are decimal strings and doubles are JSON numbers or one of three special strings, and OTLP adds
 * that ids are lowercase hex. Example-based tests confirm the mapping on values a developer thinks of;
 * these confirm it on the values that actually break encoders — the non-finite, the very large, the
 * fractional.
 */

const ALL_STATUSES: SpanStatus[] = [
  'OK',
  'ERROR',
  'TIMEOUT',
  'CANCELLED',
  'DEADLINE_EXCEEDED',
  'UNKNOWN',
];

const KIND_VALUES: number[] = Object.values(OtlpSpanKind);

/** The kind names the override accepts — the OTLP enum keys minus the unspecified sentinel. */
const KIND_NAMES: string[] = Object.keys(OtlpSpanKind).filter((k) => k !== 'UNSPECIFIED');

/** A hex id generator, at the real widths (32 for a trace, 16 for a span). */
const hexId = (length: number) =>
  fc.stringMatching(new RegExp(`^[0-9a-f]{${length}}$`)) as fc.Arbitrary<string>;

/** Attribute values spanning every branch of the AnyValue one-of, INCLUDING the encoder-breaking ones. */
const attributeValue = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.bigInt(),
  fc.constantFrom<unknown>(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e21, // `Number.isInteger` is TRUE here, and `String(1e21)` is "1e+21"
    -1e21,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    -0,
    null,
    undefined,
    { nested: 1 },
    [1, 2],
  ),
);

const attributes = fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), attributeValue, {
  maxKeys: 6,
});

const spanWire = (): fc.Arbitrary<SpanWire> =>
  fc.record(
    {
      spanId: hexId(16),
      parentSpanId: fc.option(hexId(16), { nil: undefined }),
      operation: fc.constantFrom('http.client', 'http.server', 'db.query', 'ui.render'),
      description: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
      status: fc.constantFrom(...ALL_STATUSES),
      startTimestampMs: fc.double({ min: 0, max: 4e12, noNaN: true }),
      endTimestampMs: fc.option(fc.double({ min: 0, max: 4e12, noNaN: true }), { nil: undefined }),
      attributes: fc.option(attributes, { nil: undefined }),
    },
    { requiredKeys: ['spanId', 'operation', 'status', 'startTimestampMs'] },
  );

const transactionWire = (): fc.Arbitrary<TransactionWire> =>
  fc.record(
    {
      traceId: hexId(32),
      spanId: hexId(16),
      name: fc.string({ maxLength: 24 }),
      operation: fc.constantFrom('http.server', 'http.client', 'navigation', 'interaction'),
      parentSpanId: fc.option(hexId(16), { nil: undefined }),
      status: fc.constantFrom(...ALL_STATUSES),
      sampled: fc.boolean(),
      startTimestampMs: fc.double({ min: 0, max: 4e12, noNaN: true }),
      endTimestampMs: fc.option(fc.double({ min: 0, max: 4e12, noNaN: true }), { nil: undefined }),
      isSnapshot: fc.boolean(),
      appVersion: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
      appBuild: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
      attributes: fc.option(attributes, { nil: undefined }),
      spans: fc.array(spanWire(), { maxLength: 5 }),
    },
    {
      requiredKeys: [
        'traceId',
        'spanId',
        'name',
        'operation',
        'status',
        'sampled',
        'startTimestampMs',
        'isSnapshot',
        'spans',
      ],
    },
  );

/** What a collector actually receives: the request after a JSON serialize/parse round-trip. */
const overTheWire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe('OTLP AnyValue encoding (fuzz)', () => {
  /**
   * Every `AnyValue` we emit must survive JSON and still be a legal proto3 JSON scalar.
   *
   * The two ways this can fail are invisible in the in-memory object and only appear AFTER serialization:
   * a non-finite `doubleValue` becomes `null` (not a number, and not one of the three permitted special
   * strings), and a `String()`-formatted large integer becomes `"1e+21"` (not a decimal string).
   */
  it('emits a scalar the proto3 JSON mapping permits, after serialization', () => {
    fc.assert(
      fc.property(attributeValue, (raw) => {
        const value = toAnyValue(raw);
        if (value === undefined) {
          return; // the key is dropped — nothing reaches the wire
        }
        const wire = overTheWire(value) as Record<string, unknown>;
        const keys = Object.keys(wire);
        expect(keys, `AnyValue for ${String(raw)} is not a one-of`).toHaveLength(1);

        const [key] = keys;
        const encoded = wire[key as string];
        if (key === 'intValue') {
          // proto3 JSON: int64/uint64 are DECIMAL strings. "1e+21" is not one.
          expect(typeof encoded).toBe('string');
          expect(String(encoded), `intValue "${String(encoded)}" is not a decimal string`).toMatch(
            /^-?\d+$/,
          );
          // …and the exact value, since an int64 field is where precision is being claimed.
          expect(BigInt(String(encoded)), `intValue lost the value ${String(raw)}`).toBe(
            BigInt(raw as number | bigint),
          );
        } else if (key === 'doubleValue') {
          // proto3 JSON: a double is a JSON number, or "NaN"/"Infinity"/"-Infinity". And it must be the
          // RIGHT one — a legal-but-wrong spelling (−Infinity sent as "Infinity") is a silent data lie,
          // which membership alone would not catch.
          expect(
            typeof raw === 'number' || typeof raw === 'bigint',
            'a non-number reached doubleValue',
          ).toBe(true);
          if (typeof raw === 'number' && !Number.isFinite(raw)) {
            // The spelling is EXACT — the mapping names three strings, and `Number("nan")` is also NaN,
            // so a value-only check would accept a spelling no collector recognises.
            expect(encoded, 'a non-finite double is not spelled as the mapping requires').toBe(
              String(raw),
            );
          } else {
            expect(Number(encoded), `doubleValue lost the value ${String(raw)}`).toBe(Number(raw));
          }
        } else {
          expect(['stringValue', 'boolValue']).toContain(key);
        }
      }),
      { numRuns: 1000 },
    );
  });

  /** A value that does not encode drops its KEY entirely rather than emitting a null-valued attribute. */
  it('drops a key whose value does not encode, and keeps every key that does', () => {
    fc.assert(
      fc.property(attributes, (record) => {
        const pairs = toKeyValues(record);
        const emitted = pairs.map((p) => p.key);
        expect(new Set(emitted).size, 'a key was emitted twice').toBe(emitted.length);
        for (const [key, raw] of Object.entries(record)) {
          const encodes = toAnyValue(raw) !== undefined;
          expect(
            emitted.includes(key),
            `key ${key} (${String(raw)}) was ${encodes ? 'dropped' : 'kept'}`,
          ).toBe(encodes);
        }
        for (const pair of pairs) {
          expect(pair.value, `key ${pair.key} carries no value`).toBeDefined();
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never encodes null or undefined', () => {
    expect(toAnyValue(null)).toBeUndefined();
    expect(toAnyValue(undefined)).toBeUndefined();
    // Functions and symbols are unencodable via JSON, so their keys drop too.
    expect(toAnyValue(() => 1)).toBeUndefined();
    expect(toAnyValue(Symbol('s'))).toBeUndefined();
  });
});

describe('OTLP span emission (fuzz)', () => {
  /**
   * `*UnixNano` is uint64, so the OTLP/JSON mapping makes it a DECIMAL STRING — the whole reason this
   * package converts through BigInt rather than `String(ms * 1e6)`, which would go exponential.
   */
  it('emits every timestamp as a decimal nanosecond string', () => {
    fc.assert(
      fc.property(transactionWire(), (txn) => {
        for (const span of transactionToOtlpSpans(txn)) {
          for (const field of ['startTimeUnixNano', 'endTimeUnixNano'] as const) {
            expect(span[field], `${field} is not a decimal string`).toMatch(/^-?\d+$/);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  /** `kind` is a required OTLP enum. An unrecognised override must fall back, never leave it absent. */
  it('always emits a known span kind', () => {
    fc.assert(
      fc.property(transactionWire(), (txn) => {
        for (const span of transactionToOtlpSpans(txn)) {
          expect(typeof span.kind, 'kind is not a number').toBe('number');
          expect(KIND_VALUES, `kind ${span.kind} is not an OTLP SpanKind`).toContain(span.kind);
        }
      }),
      { numRuns: 300 },
    );
  });

  /**
   * `bugsee.span.kind` is an OVERRIDE, so it is attacker/caller-shaped: an unknown name, or a non-string,
   * must fall through to the operation-derived kind rather than emitting `undefined`.
   */
  it('falls back to the operation-derived kind for an unusable override', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 12 }).filter((s) => !KIND_NAMES.includes(s)),
          fc.constantFrom<unknown>(undefined, null, 3, true, {}, ['SERVER'], 'server', 'Internal'),
        ),
        fc.constantFrom('http.server', 'http.client', 'db.query'),
        (override, operation) => {
          const kind = spanKindFor(operation, { 'bugsee.span.kind': override });
          expect(typeof kind, `override ${String(override)} produced ${String(kind)}`).toBe(
            'number',
          );
          expect(kind).toBe(spanKindFor(operation));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('honours a recognised override over the operation', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KIND_NAMES),
        fc.constantFrom('http.server', 'http.client', 'db.query'),
        (name, operation) => {
          expect(spanKindFor(operation, { 'bugsee.span.kind': name })).toBe(
            OtlpSpanKind[name as keyof typeof OtlpSpanKind],
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * The kind rule is a PREFIX match, so a namespaced operation still maps. `http.server` today is exact,
   * which makes prefix-vs-suffix invisible — until an operation is refined to `http.server.GET` and a
   * suffix match silently reclassifies every server span as INTERNAL.
   */
  it('derives the kind from the operation PREFIX, not the whole string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10 }), (suffix) => {
        expect(spanKindFor(`http.server${suffix}`)).toBe(OtlpSpanKind.SERVER);
        expect(spanKindFor(`http.client${suffix}`)).toBe(OtlpSpanKind.CLIENT);
        // …and a string merely ENDING in one of them is not a server/client span.
        expect(spanKindFor(`prefixed.http.server`)).toBe(OtlpSpanKind.INTERNAL);
        expect(spanKindFor(`prefixed.http.client`)).toBe(OtlpSpanKind.INTERNAL);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Tree integrity: no span may reference a parent that is not in the batch. The §8.8 wire drops the
   * root's id from its children, so every "dangling" child is remapped — if that remap ever missed, the
   * collector would render an orphan span with no path to the trace root.
   */
  it('links every child to a span that is actually emitted', () => {
    fc.assert(
      fc.property(transactionWire(), (txn) => {
        const spans = transactionToOtlpSpans(txn);
        const [root, ...children] = spans;
        const emitted = new Set(spans.map((s) => s.spanId));
        for (const child of children) {
          expect(child.parentSpanId, 'a child has no parent').toBeDefined();
          expect(
            emitted.has(child.parentSpanId as string),
            `child ${child.spanId} points at un-emitted parent ${String(child.parentSpanId)}`,
          ).toBe(true);
        }
        // Only the ROOT may point outside the batch — at the upstream span of a continued trace.
        expect(root?.parentSpanId).toBe(txn.parentSpanId);
      }),
      { numRuns: 400 },
    );
  });

  /**
   * The root carries the transaction's REAL span id — the one `traceparent` propagated. Deriving it from
   * the trace id gave every service in a distributed trace the same root id and left downstream parents
   * pointing at a span nobody emitted (Wave 5.3).
   */
  it('emits the root under the transaction span id that was propagated', () => {
    fc.assert(
      fc.property(transactionWire(), (txn) => {
        const [root] = transactionToOtlpSpans(txn);
        expect(root?.spanId, 'the root span id was fabricated').toBe(txn.spanId);
        expect(root?.traceId).toBe(txn.traceId);
      }),
      { numRuns: 300 },
    );
  });

  /** Profile v1 §8: the sampled trace-flag bit mirrors the decision, on EVERY span, not just the root. */
  it('mirrors the sampling decision into the trace flags of every span', () => {
    fc.assert(
      fc.property(transactionWire(), (txn) => {
        const expected = txn.sampled ? OTLP_SPAN_FLAG_SAMPLED : 0;
        for (const span of transactionToOtlpSpans(txn)) {
          expect(span.flags, `flags disagree with sampled=${txn.sampled}`).toBe(expected);
        }
        const rootAttributes = new Map(
          (transactionToOtlpSpans(txn)[0]?.attributes ?? []).map((kv) => [kv.key, kv.value]),
        );
        expect(rootAttributes.get('bugsee.sampled')).toEqual({ boolValue: txn.sampled });
      }),
      { numRuns: 300 },
    );
  });

  /**
   * The two profile-fixed resource constants are applied AFTER the caller's resource precisely so a
   * caller cannot override them away — a Bugsee payload that does not identify itself as one would be
   * processed as a generic OTLP trace and lose every profile-specific field.
   */
  it('keeps the profile-fixed resource attributes whatever the caller supplies', () => {
    fc.assert(
      fc.property(
        transactionWire(),
        fc.dictionary(
          fc.constantFrom('telemetry.sdk.name', 'bugsee.profile.version', 'service.name'),
          attributeValue,
          { maxKeys: 3 },
        ),
        (txn, resource) => {
          const request = toOtlpExportRequest([txn], { resource });
          const fixed = new Map(
            (request.resourceSpans[0]?.resource.attributes ?? []).map((kv) => [kv.key, kv.value]),
          );
          expect(fixed.get('telemetry.sdk.name'), 'the sdk name was overridden').toEqual({
            stringValue: 'bugsee',
          });
          expect(fixed.get('bugsee.profile.version'), 'the profile version was overridden').toEqual(
            {
              stringValue: '1',
            },
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  /** The whole request must serialize — it is POSTed as `JSON.stringify(request)`. */
  it('produces a request that serializes and re-parses intact', () => {
    fc.assert(
      fc.property(fc.array(transactionWire(), { maxLength: 4 }), (transactions) => {
        const request = toOtlpExportRequest(transactions);
        const round = overTheWire(request) as typeof request;
        expect(round).toEqual(JSON.parse(JSON.stringify(request)));
        const spans = round.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
        expect(spans).toHaveLength(transactions.reduce((n, t) => n + 1 + t.spans.length, 0));
      }),
      { numRuns: 300 },
    );
  });
});

describe('status mapping (fuzz)', () => {
  /**
   * A differential round-trip: every Bugsee status survives the trip through OTLP and back.
   *
   * The statuses are enumerated from the `SpanStatus` union rather than read out of the module's own
   * `ERROR_STATUSES` set — a property that iterates the implementation's list cannot defend that list.
   */
  it('round-trips every span status through the OTLP status', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_STATUSES), (status) => {
        expect(fromOtlpStatus(toStatus(status)), `${status} did not survive the round trip`).toBe(
          status,
        );
      }),
      { numRuns: 200 },
    );
  });

  /** An OTel status we did not produce still maps to something valid — never `undefined`. */
  it('maps any inbound OTel status code to a known span status', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            code: fc.oneof(fc.integer({ min: -5, max: 10 }), fc.integer()),
            message: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
          },
          { requiredKeys: ['code'] },
        ),
        (status) => {
          expect(ALL_STATUSES, `code ${status.code} mapped outside the union`).toContain(
            fromOtlpStatus(status),
          );
        },
      ),
      { numRuns: 600 },
    );
  });
});
