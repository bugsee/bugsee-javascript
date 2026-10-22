import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readableSpanToConsumed } from './span-processor';
import { toAnyValue, toKeyValues } from './to-otlp';

/**
 * The produce and consume mappings accept ANY attribute value. The values come from application
 * instrumentation and from whatever OTel SDK the host runs, and both mappings run where a throw is expensive:
 * `onEnd` inside the customer's `span.end()`, and the exporter, where one throw rejects the whole batch.
 */

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
        expect(() => JSON.stringify(consumed.attributes)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});
