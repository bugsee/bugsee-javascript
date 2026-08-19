import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';
import { deepMerge } from './deep-merge';
import { jsonSafeStringify } from './json-safe-stringify';
import { utf8ByteLength } from './utf8-byte-length';

/**
 * Property-based tests for the tier-0 primitives.
 *
 * These are deliberately different in kind from the example-based tests next to them. An example test
 * pins the cases someone THOUGHT of; the interesting failures in this file's targets all live in inputs
 * nobody writes down by hand — lone surrogates, astral pairs split across a boundary, `__proto__`
 * arriving as an own enumerable key. Every property here is a differential or an invariant, so a
 * counterexample is a real defect rather than a changed opinion.
 *
 * Kept fast (a few hundred runs each) so they can live in the normal `pnpm test` run: a fuzz suite that
 * only runs nightly finds its regressions a day late.
 */

/**
 * Arbitrary UTF-16 code-unit sequences — NOT well-formed strings.
 *
 * `fc.string()` produces valid scalar values, which is exactly the input class these functions already
 * handle. Real capture data does not stay well-formed: a body sliced at a byte cap, a stack frame cut
 * mid-emoji, or a JS string built by `String.fromCharCode` can all carry an unpaired surrogate, and that
 * is where byte accounting historically goes wrong.
 */
const codeUnitString = (maxLength = 64): fc.Arbitrary<string> =>
  fc
    .array(fc.integer({ min: 0, max: 0xffff }), { maxLength })
    .map((units) => String.fromCharCode(...units));

/** The same, but biased hard toward surrogates so pairs and half-pairs actually collide. */
const surrogateHeavyString = (maxLength = 32): fc.Arbitrary<string> =>
  fc
    .array(
      fc.oneof(
        fc.integer({ min: 0xd800, max: 0xdfff }), // any surrogate, paired or not
        fc.integer({ min: 0, max: 0x7f }), // ASCII, to create boundaries
        fc.integer({ min: 0x80, max: 0x7ff }),
        fc.integer({ min: 0x800, max: 0xffff }),
      ),
      { maxLength },
    )
    .map((units) => String.fromCharCode(...units));

describe('utf8ByteLength (fuzz)', () => {
  // Reached through globalThis: this tier compiles without the DOM/Node libs (that is the point of the
  // allocation-free implementation under test), so `TextEncoder` is not in its type space.
  const { TextEncoder: Encoder } = globalThis as unknown as {
    TextEncoder: new () => { encode(input: string): Uint8Array };
  };
  const encoder = new Encoder();

  // THE contract, stated in its own doc comment: it exists to avoid allocating a Uint8Array on the
  // capture hot path, so it must agree with the encoder it replaces for every input. It feeds the
  // `maxDataSize` bound — undercount and a store silently exceeds its byte cap, overcount and capture is
  // dropped that should have been kept.
  it('agrees with TextEncoder for arbitrary well-formed strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 128 }), (s) => {
        expect(utf8ByteLength(s)).toBe(encoder.encode(s).length);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with TextEncoder for arbitrary UTF-16 code-unit sequences, lone surrogates included', () => {
    fc.assert(
      fc.property(codeUnitString(), (s) => {
        expect(utf8ByteLength(s)).toBe(encoder.encode(s).length);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with TextEncoder on surrogate-dense input, where pairing decisions collide', () => {
    fc.assert(
      fc.property(surrogateHeavyString(), (s) => {
        expect(utf8ByteLength(s)).toBe(encoder.encode(s).length);
      }),
      { numRuns: 1000 },
    );
  });

  // Additivity across a split is what a caller doing incremental accounting relies on. It holds for every
  // split EXCEPT one through the middle of a surrogate pair, where both halves become replacement
  // characters (3 + 3) instead of one 4-byte code point — so the sum can exceed the whole, but never
  // undershoot it. Undershooting would be the dangerous direction: it is how a cap gets exceeded.
  it('never undercounts a string relative to the sum of its parts', () => {
    fc.assert(
      fc.property(codeUnitString(), fc.nat(), (s, rawIndex) => {
        const at = s.length === 0 ? 0 : rawIndex % s.length;
        const whole = utf8ByteLength(s);
        const parts = utf8ByteLength(s.slice(0, at)) + utf8ByteLength(s.slice(at));
        expect(parts).toBeGreaterThanOrEqual(whole);
        expect(whole).toBe(encoder.encode(s).length);
      }),
      { numRuns: 500 },
    );
  });
});

describe('base64 (fuzz)', () => {
  it('round-trips arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
      }),
      { numRuns: 500 },
    );
  });

  // Every byte value must survive, including 0x00 and the high half that a naive charCode round-trip
  // mangles. Stated separately from the round-trip above so a failure names the cause.
  it('preserves every byte value, not merely the length', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), (bytes) => {
        const out = fromBase64(toBase64(bytes));
        expect(out.length).toBe(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
          expect(out[i]).toBe(bytes[i]);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('deepMerge (fuzz)', () => {
  /** Arbitrary JSON-ish trees, with the dangerous keys over-represented rather than left to chance. */
  const dangerousKey = fc.constantFrom(
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'a',
    'b',
  );
  const jsonish: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: 'small' },
      fc.integer(),
      fc.string({ maxLength: 8 }),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie('node'), { maxLength: 3 }),
      fc.dictionary(dangerousKey, tie('node'), { maxKeys: 4 }),
    ),
  })).node;

  const plainObject = fc.dictionary(dangerousKey, jsonish, { maxKeys: 5 });

  // The guarantee the doc comment makes: a `JSON.parse`d payload cannot corrupt anything global.
  // `JSON.parse('{"__proto__":{...}}')` yields `__proto__` as an OWN ENUMERABLE key, so it reaches the
  // merge loop as an ordinary key — which is precisely why the explicit skip exists and why removing it
  // must fail loudly.
  it('never pollutes Object.prototype, however the payload is shaped', () => {
    const prototypeKeysBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    fc.assert(
      fc.property(plainObject, plainObject, (target, source) => {
        // Round-tripping through JSON is what makes `__proto__` an own key rather than a setter call.
        const parsedSource = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        const parsedTarget = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
        const result = deepMerge(parsedTarget, parsedSource);

        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        // Compared as a SNAPSHOT of the prototype's own keys, not as "the payload's keys are absent
        // from it": `constructor`, `toString` and `valueOf` are natively own properties of
        // `Object.prototype`, so the latter reports pollution for a payload that merely mentions them.
        // What must hold is that the merge ADDED nothing.
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeysBefore);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      }),
      { numRuns: 500 },
    );
  });

  it('leaves both inputs unmutated', () => {
    fc.assert(
      fc.property(plainObject, plainObject, (target, source) => {
        const parsedTarget = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
        const parsedSource = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        const targetBefore = JSON.stringify(parsedTarget);
        const sourceBefore = JSON.stringify(parsedSource);

        deepMerge(parsedTarget, parsedSource);

        expect(JSON.stringify(parsedTarget)).toBe(targetBefore);
        expect(JSON.stringify(parsedSource)).toBe(sourceBefore);
      }),
      { numRuns: 500 },
    );
  });

  // Merging a payload into `{}` must not smuggle in a key the payload did not carry — the result's own
  // keys are exactly the source's, minus the one key that is deliberately refused.
  it('adds exactly the source keys it accepts, and no others', () => {
    fc.assert(
      fc.property(plainObject, (source) => {
        const parsed = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        const result = deepMerge({}, parsed);
        const expected = Object.keys(parsed).filter((k) => k !== '__proto__');
        expect(Object.keys(result).sort()).toEqual(expected.sort());
      }),
      { numRuns: 500 },
    );
  });
});

describe('jsonSafeStringify (fuzz)', () => {
  /**
   * Values an application can genuinely hand to `console.log` — and that `JSON.stringify` refuses.
   *
   * A throwing getter is not exotic: ORM row proxies, MobX/Vue reactive objects read outside their
   * scope, and detached DOM nodes all throw on property access. This function is the SDK's designated
   * safe stringifier for arbitrary captured data, so "arbitrary" has to include these.
   */
  const hostile = fc.oneof(
    fc.constant({
      get boom() {
        throw new Error('getter exploded');
      },
    }),
    fc.constant({
      toJSON() {
        throw new Error('toJSON exploded');
      },
    }),
    fc.constant(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('proxy trap exploded');
          },
        },
      ),
    ),
    fc.constant({ big: BigInt('123456789012345678901234567890') }),
    fc.constant(
      (() => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return cyclic;
      })(),
    ),
    fc.constant(
      (() => {
        // Deep enough to blow the recursion JSON.stringify does internally.
        let node: Record<string, unknown> = {};
        const root = node;
        for (let i = 0; i < 20000; i++) {
          const next: Record<string, unknown> = {};
          node.n = next;
          node = next;
        }
        return root;
      })(),
    ),
    fc.anything(),
  );

  // Totality is the whole contract. It is called from the console interceptor's patched `console.log`,
  // so a throw here does not merely lose capture — it lands inside the application's own call.
  it('never throws, and always returns a string', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        let out: string | undefined;
        expect(() => {
          out = jsonSafeStringify(value);
        }).not.toThrow();
        expect(typeof out).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  // Whatever it returns must survive the JSON round-trip it exists to guarantee, or the bundle carries a
  // field the backend cannot parse.
  it('returns parseable JSON for values JSON can represent', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => JSON.parse(jsonSafeStringify(value))).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
