import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  MAX_ATTRIBUTE_ARRAY_LENGTH,
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_JSON_LENGTH,
  MAX_ATTRIBUTE_NODES,
  normalizeAttributes,
  normalizeAttributeValue,
  stringifyAnyValue,
  TRUNCATION_MARKER,
} from './attribute-value';

/** Node's `Buffer` (a Uint8Array subclass) without pulling @types/node into this portable package. */
const nodeBuffer = (
  globalThis as unknown as {
    Buffer: {
      from(input: string | Uint8Array): Uint8Array & { toString(encoding: string): string };
    };
  }
).Buffer;

describe('bytesToBase64', () => {
  it.each([
    [[], ''],
    [[102], 'Zg=='],
    [[102, 111], 'Zm8='],
    [[102, 111, 111], 'Zm9v'],
    [[0, 255, 254, 253], 'AP/+/Q=='],
  ])('encodes %j as %s (RFC 4648, padded)', (bytes, expected) => {
    expect(bytesToBase64(new Uint8Array(bytes))).toBe(expected);
  });

  it('agrees with Buffer on every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(bytesToBase64(all)).toBe(nodeBuffer.from(all).toString('base64'));
  });

  it('encodes a Node Buffer (a Uint8Array subclass)', () => {
    expect(bytesToBase64(nodeBuffer.from('hello'))).toBe('aGVsbG8=');
  });
});

describe('stringifyAnyValue', () => {
  it('serializes plain JSON-shaped values exactly like JSON.stringify', () => {
    const value = { a: 1, b: ['x', true, null, { c: 2.5 }], d: { e: { f: 'g' } } };
    expect(stringifyAnyValue(value)).toBe(JSON.stringify(value));
    expect(stringifyAnyValue([1, 'a', true])).toBe('[1,"a",true]');
    expect(stringifyAnyValue('s')).toBe('"s"');
    expect(stringifyAnyValue(null)).toBe('null');
  });

  it('has no output for a value with no JSON form at the top level', () => {
    expect(stringifyAnyValue(undefined)).toBeUndefined();
    expect(stringifyAnyValue(() => 1)).toBeUndefined();
    expect(stringifyAnyValue(Symbol('s'))).toBeUndefined();
  });

  it('writes a byte array as base64, at any depth', () => {
    expect(stringifyAnyValue(new Uint8Array([102, 111, 111]))).toBe('"Zm9v"');
    expect(stringifyAnyValue({ blob: new Uint8Array([1, 2]) })).toBe('{"blob":"AQI="}');
    expect(stringifyAnyValue([nodeBuffer.from('hi')])).toBe('["aGk="]');
  });

  it('keeps a bigint exact as a decimal string (JSON.stringify would throw)', () => {
    expect(stringifyAnyValue({ n: 12345678901234567890n })).toBe('{"n":"12345678901234567890"}');
  });

  it('spells non-finite numbers the way the OTLP double does (JSON would say null)', () => {
    expect(
      stringifyAnyValue([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
    ).toBe('["NaN","Infinity","-Infinity"]');
  });

  it('drops function/symbol/undefined members of an object and nulls them in an array (JSON semantics)', () => {
    expect(stringifyAnyValue({ a: 1, f: () => 1, s: Symbol('x'), u: undefined })).toBe('{"a":1}');
    expect(stringifyAnyValue([1, () => 1, Symbol('x'), undefined])).toBe('[1,null,null,null]');
  });

  it('writes a Date as ISO-8601 and an invalid Date as null', () => {
    expect(stringifyAnyValue({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
    expect(stringifyAnyValue([new Date(Number.NaN)])).toBe('[null]');
  });

  it('does not run user code: toJSON is ignored and a class instance is read by own enumerable keys', () => {
    let called = 0;
    class Thing {
      x = 1;
      toJSON() {
        called++;
        return 'boom';
      }
    }
    expect(stringifyAnyValue(new Thing())).toBe('{"x":1}');
    expect(called).toBe(0);
  });

  it('marks a cycle instead of throwing, but does not mistake a shared (acyclic) reference for one', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(stringifyAnyValue(cyc)).toBe('{"a":1,"self":"[Circular]"}');

    const shared = { v: 1 };
    expect(stringifyAnyValue({ x: shared, y: shared })).toBe('{"x":{"v":1},"y":{"v":1}}');
  });

  it('marks a deep structure at the depth cap rather than recursing without bound', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10_000; i++) deep = { n: deep };
    const out = stringifyAnyValue(deep) as string;
    expect(out).toContain('"[MaxDepth]"');
    expect(out.split('{').length - 1).toBe(MAX_ATTRIBUTE_DEPTH);
  });

  it('stops visiting after the node budget, keeps what it read, and says so once', () => {
    const wide = Array.from({ length: MAX_ATTRIBUTE_NODES * 3 }, (_, i) => i);
    const parsed = JSON.parse(stringifyAnyValue(wide) as string) as unknown[];
    expect(parsed.filter((v) => v === '[Truncated]')).toHaveLength(1);
    expect(parsed.at(-1)).toBe('[Truncated]');
    expect(parsed[0]).toBe(0);
    // The array itself is one visited node, so MAX - 1 elements fit before the marker.
    expect(parsed).toHaveLength(MAX_ATTRIBUTE_NODES);
  });

  it('applies the node budget across an object too, flagging it with a [Truncated] key', () => {
    // Each member costs 4 nodes (the member, its array, two elements): the budget runs out near 256 members.
    const wide = Object.fromEntries(
      Array.from({ length: MAX_ATTRIBUTE_NODES }, (_, i) => [`k${i}`, [0, 0]]),
    );
    const parsed = JSON.parse(stringifyAnyValue(wide) as string) as Record<string, unknown>;
    expect(parsed['[Truncated]']).toBe(true);
    expect(parsed.k0).toEqual([0, 0]);
    expect(Object.keys(parsed).length).toBeGreaterThan(200);
    expect(Object.keys(parsed).length).toBeLessThan(MAX_ATTRIBUTE_NODES / 3);
  });

  it('caps the output length and ends with the truncation marker', () => {
    const out = stringifyAnyValue({ big: 'x'.repeat(50_000) }) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_JSON_LENGTH);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.startsWith('{"big":"xxx')).toBe(true);
  });

  it('does not truncate output that fits exactly at the cap', () => {
    const exact = 'y'.repeat(MAX_ATTRIBUTE_JSON_LENGTH - 2); // the two quotes make it exactly the cap
    expect(stringifyAnyValue(exact)).toBe(JSON.stringify(exact));
  });

  it('survives a hostile object: a throwing getter or a throwing Proxy never escapes', () => {
    const getter = {
      ok: 1,
      get bad(): never {
        throw new Error('getter');
      },
    };
    expect(stringifyAnyValue(getter)).toBe('{"ok":1,"bad":"[Unreadable]"}');

    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    expect(stringifyAnyValue({ p: proxy })).toBe('{"p":"[Unreadable]"}');
    expect(stringifyAnyValue(proxy)).toBe('"[Unreadable]"');
  });

  it('survives a throwing array element and a Proxy that throws on type probing', () => {
    const arr: unknown[] = [1, 2, 3];
    Object.defineProperty(arr, 1, {
      get() {
        throw new Error('element');
      },
    });
    expect(stringifyAnyValue(arr)).toBe('[1,"[Unreadable]",3]');

    const protoTrap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('getPrototypeOf');
        },
      },
    );
    expect(stringifyAnyValue(protoTrap)).toBe('"[Unreadable]"');
    expect(stringifyAnyValue([protoTrap])).toBe('["[Unreadable]"]');
  });

  it('keeps a __proto__ key as data', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as unknown;
    const out = JSON.parse(stringifyAnyValue(parsed) as string) as Record<string, unknown>;
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('normalizeAttributeValue', () => {
  it('leaves primitives unchanged; a bigint becomes a number when exact, decimal text otherwise', () => {
    for (const v of ['s', '', 0, -1.5, true, false, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeAttributeValue(v)).toBe(v);
    }
    expect(normalizeAttributeValue(7n)).toBe(7);
    expect(normalizeAttributeValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeAttributeValue(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
    expect(normalizeAttributeValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe('9007199254740992');
    expect(normalizeAttributeValue(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toBe('-9007199254740992');
  });

  it('leaves a homogeneous array of primitives unchanged (the same array)', () => {
    const strs = ['a', 'b'];
    const nums = [1, 2.5];
    const bools = [true, false];
    expect(normalizeAttributeValue(strs)).toBe(strs);
    expect(normalizeAttributeValue(nums)).toBe(nums);
    expect(normalizeAttributeValue(bools)).toBe(bools);
    const empty: unknown[] = [];
    expect(normalizeAttributeValue(empty)).toBe(empty);
  });

  it('turns a mixed array, an array with null, or a nested array into a JSON string', () => {
    expect(normalizeAttributeValue([1, 'a', true])).toBe('[1,"a",true]');
    expect(normalizeAttributeValue(['a', null])).toBe('["a",null]');
    expect(normalizeAttributeValue([[1], [2]])).toBe('[[1],[2]]');
  });

  it('turns a primitive array past the length cap into a (truncated) JSON string', () => {
    const long = Array.from({ length: MAX_ATTRIBUTE_ARRAY_LENGTH + 1 }, () => 'a');
    const out = normalizeAttributeValue(long);
    expect(typeof out).toBe('string');
    const atCap = Array.from({ length: MAX_ATTRIBUTE_ARRAY_LENGTH }, () => 'a');
    expect(normalizeAttributeValue(atCap)).toBe(atCap);
  });

  it('turns an object into a JSON string and a byte array into a base64 string', () => {
    expect(normalizeAttributeValue({ a: { b: [1, 'x'] } })).toBe('{"a":{"b":[1,"x"]}}');
    expect(normalizeAttributeValue(new Uint8Array([102, 111, 111]))).toBe('Zm9v');
    expect(normalizeAttributeValue(nodeBuffer.from('hi'))).toBe('aGk=');
  });

  it('drops the attribute for the OTel empty value and for values with no JSON form', () => {
    expect(normalizeAttributeValue(null)).toBeUndefined();
    expect(normalizeAttributeValue(undefined)).toBeUndefined();
    expect(normalizeAttributeValue(() => 1)).toBeUndefined();
    expect(normalizeAttributeValue(Symbol('s'))).toBeUndefined();
  });

  it('caps a huge base64 attribute at the JSON length cap', () => {
    const out = normalizeAttributeValue(new Uint8Array(100_000)) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_JSON_LENGTH);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe('normalizeAttributes', () => {
  it('normalizes every value and drops the ones with no representation', () => {
    expect(
      normalizeAttributes({
        s: 'x',
        n: 3,
        tags: ['a', 'b'],
        obj: { k: 1 },
        mixed: [1, 'a'],
        bytes: new Uint8Array([1]),
        nul: null,
        und: undefined,
        fn: () => 1,
      }),
    ).toEqual({ s: 'x', n: 3, tags: ['a', 'b'], obj: '{"k":1}', mixed: '[1,"a"]', bytes: 'AQ==' });
  });

  it('keeps the other attributes when one attribute is unreadable', () => {
    const attrs = {
      ok: 'yes',
      get boom(): never {
        throw new Error('getter');
      },
      after: 2,
    };
    expect(normalizeAttributes(attrs)).toEqual({ ok: 'yes', after: 2 });
  });

  it('stores a __proto__ attribute as an own key and never rewrites the prototype', () => {
    const attrs = JSON.parse('{"__proto__":["a","b"],"k":1}') as Record<string, unknown>;
    const out = normalizeAttributes(attrs);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.k).toBe(1);
  });

  it('reads only own enumerable string keys', () => {
    const inherited = Object.create({ inherited: 'no' }) as Record<string, unknown>;
    inherited.own = 'yes';
    expect(normalizeAttributes(inherited)).toEqual({ own: 'yes' });
  });
});
