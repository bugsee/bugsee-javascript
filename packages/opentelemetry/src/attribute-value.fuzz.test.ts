import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_JSON_LENGTH,
  normalizeAttributes,
  normalizeAttributeValue,
  stringifyAnyValue,
  TRUNCATION_MARKER,
} from './attribute-value';
import { readableSpanToConsumed } from './span-processor';
import { toAnyValue, toKeyValues } from './to-otlp';

/**
 * Property tests for complex attribute values (OTel API 1.10 AnyValue). `onEnd` runs inside the customer's
 * `span.end()` and an attribute value is whatever their instrumentation put there, so the contract is
 * "never throws, always bounded, scalars untouched", over the values that actually break serializers:
 * cycles, bigint, typed arrays, sparse arrays, null-prototype objects, deep and wide trees.
 */

/** Arbitrary JSON-ish trees including the exotic leaves, with optional injected self-references. */
const exotic = fc.anything({
  withBigInt: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withNullPrototype: true,
  withSparseArray: true,
  withTypedArray: true,
  withObjectString: true,
  maxDepth: 6,
});

const withCycle = exotic.map((value) => {
  const holder: Record<string, unknown> = { value };
  holder.self = holder;
  holder.list = [holder, value];
  return holder;
});

const leaf = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(() => 1),
  fc.constant(Symbol('s')),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  fc.uint8Array({ maxLength: 64 }),
  fc.bigInt(),
);

const anyValue = fc.oneof(exotic, withCycle, leaf);

/** A chain nested `levels` deep in objects or arrays. */
const chain = (levels: number, asArray: boolean): unknown => {
  let node: unknown = 'leaf';
  for (let i = 0; i < levels; i++) node = asArray ? [node] : { n: node };
  return node;
};

describe('stringifyAnyValue (fuzz)', () => {
  it('never throws and never exceeds the length cap', () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        const out = stringifyAnyValue(value);
        if (out !== undefined) expect(out.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_JSON_LENGTH);
      }),
      { numRuns: 400 },
    );
  });

  it('emits parseable JSON unless it says it truncated', () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        const out = stringifyAnyValue(value);
        if (out === undefined || out.endsWith(TRUNCATION_MARKER)) return;
        expect(() => JSON.parse(out)).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });

  it('has no output only for values that have no JSON form', () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        const out = stringifyAnyValue(value);
        const noForm =
          value === undefined || typeof value === 'function' || typeof value === 'symbol';
        expect(out === undefined).toBe(noForm);
      }),
      { numRuns: 400 },
    );
  });

  it('never nests deeper than the depth cap, whatever the depth or the container kind', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fc.boolean(), (levels, asArray) => {
        const parsed = JSON.parse(stringifyAnyValue(chain(levels, asArray)) as string) as unknown;
        const depthOf = (node: unknown): number =>
          typeof node === 'object' && node !== null
            ? 1 + Math.max(0, ...Object.values(node).map(depthOf))
            : 0;
        const max = depthOf(parsed);
        expect(max).toBeLessThanOrEqual(MAX_ATTRIBUTE_DEPTH);
      }),
      { numRuns: 100 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        expect(stringifyAnyValue(value)).toBe(stringifyAnyValue(value));
      }),
      { numRuns: 200 },
    );
  });
});

describe('normalizeAttributeValue (fuzz)', () => {
  it('returns a scalar, a homogeneous scalar array, a bounded string, or nothing', () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        const out = normalizeAttributeValue(value);
        if (out === undefined) return;
        if (typeof out === 'string') {
          // A string input is passed through untouched; any other input is bounded.
          if (typeof value !== 'string')
            expect(out.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_JSON_LENGTH);
          return;
        }
        if (Array.isArray(out)) {
          const kinds = new Set(out.map((v) => typeof v));
          expect(kinds.size).toBeLessThanOrEqual(1);
          for (const kind of kinds) expect(['string', 'number', 'boolean']).toContain(kind);
          return;
        }
        expect(['number', 'boolean']).toContain(typeof out);
      }),
      { numRuns: 400 },
    );
  });

  it('leaves every scalar and every homogeneous scalar array untouched', () => {
    const scalar = fc.oneof(fc.string(), fc.boolean(), fc.double(), fc.integer());
    fc.assert(
      fc.property(scalar, (v) => {
        expect(normalizeAttributeValue(v)).toBe(v);
      }),
    );
    const arrays: fc.Arbitrary<unknown[]>[] = [
      fc.array(fc.string(), { maxLength: 50 }),
      fc.array(fc.boolean(), { maxLength: 50 }),
      fc.array(fc.double(), { maxLength: 50 }),
    ];
    for (const arb of arrays) {
      fc.assert(
        fc.property(arb, (arr) => {
          expect(normalizeAttributeValue(arr)).toBe(arr);
        }),
      );
    }
  });
});

describe('the OTLP and consume mappings accept any attribute value (fuzz)', () => {
  it('toAnyValue never throws and its result survives JSON serialization', () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        const out = toAnyValue(value);
        if (out === undefined) return;
        expect(JSON.parse(JSON.stringify(out))).toEqual(out);
      }),
      { numRuns: 400 },
    );
  });

  it('toKeyValues and readableSpanToConsumed keep working with an exotic value among the attributes', () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        const attributes = { before: 'a', hostile: value, after: 1 };
        expect(() => toKeyValues(attributes)).not.toThrow();
        const consumed = readableSpanToConsumed({
          spanContext: () => ({ traceId: 't', spanId: 's' }),
          name: 'n',
          startTime: [0, 0],
          endTime: [1, 0],
          status: { code: 0 },
          attributes,
        });
        expect(consumed.attributes?.before).toBe('a');
        expect(consumed.attributes?.after).toBe(1);
        expect(JSON.parse(JSON.stringify(consumed.attributes))).toBeDefined();
      }),
      { numRuns: 300 },
    );
  });

  it('normalizeAttributes output is always JSON-serializable', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 8 }), anyValue, { maxKeys: 8 }), (attrs) => {
        const out = normalizeAttributes(attrs);
        expect(() => JSON.stringify(out)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});
