import { describe, expect, it, vi } from 'vitest';
import {
  boundedBase64,
  bytesToBase64,
  flattenAttributes,
  flattenAttributeValue,
  MAX_ATTRIBUTE_ARRAY_LENGTH,
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_JSON_LENGTH,
  MAX_ATTRIBUTE_NODES,
  MAX_ATTRIBUTE_STRING_LENGTH,
  MAX_ATTRIBUTE_TREE_CHARS,
  normalizeAttributes,
  normalizeAttributeValue,
  safeAnyValue,
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

  it('handles a nested bigint like a top-level one: a number when exact, decimal text beyond it', () => {
    expect(stringifyAnyValue({ n: 12345678901234567890n })).toBe('{"n":"12345678901234567890"}');
    expect(stringifyAnyValue({ n: 10n, list: [1n, -2n] })).toBe('{"n":10,"list":[1,-2]}');
    expect(safeAnyValue({ edge: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).toEqual({
      edge: '9007199254740992',
    });
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

  it('caps the output length and marks the cut', () => {
    const out = stringifyAnyValue({ big: 'x'.repeat(50_000) }) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_JSON_LENGTH);
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.startsWith('{"big":"xxx')).toBe(true);
    // Many mid-size leaves overflow the text cap itself: the text is cut and ends with the marker.
    const many = stringifyAnyValue(Array.from({ length: 20 }, () => 'y'.repeat(2000))) as string;
    expect(many.length).toBe(MAX_ATTRIBUTE_JSON_LENGTH);
    expect(many.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('does not truncate output that fits exactly at the cap', () => {
    // `["<a>","<b>"]` is a.length + b.length + 7 characters of JSON.
    const first = 'y'.repeat(4000);
    const second = 'z'.repeat(MAX_ATTRIBUTE_JSON_LENGTH - 7 - first.length);
    const out = stringifyAnyValue([first, second]) as string;
    expect(out).toBe(JSON.stringify([first, second]));
    expect(out.length).toBe(MAX_ATTRIBUTE_JSON_LENGTH);
  });

  it('cuts a single leaf string and a key to a bounded length, marked', () => {
    const leaf = JSON.parse(stringifyAnyValue('x'.repeat(100_000)) as string) as string;
    expect(leaf.length).toBeLessThan(MAX_ATTRIBUTE_JSON_LENGTH);
    expect(leaf.endsWith(TRUNCATION_MARKER)).toBe(true);
    const keyed = safeAnyValue({ ['k'.repeat(100_000)]: 1 }) as Record<string, unknown>;
    const [key] = Object.keys(keyed);
    expect((key as string).length).toBeLessThan(MAX_ATTRIBUTE_JSON_LENGTH);
    expect((key as string).endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('bounds WORK by size, not just count: a huge nested leaf is cut before it is copied or encoded', () => {
    const huge = 'x'.repeat(64 * 1024 * 1024);
    const out = stringifyAnyValue({ a: huge, b: [huge, { c: huge }] }) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_JSON_LENGTH);
    const safe = safeAnyValue({ a: huge, b: [huge, { c: huge }] });
    expect(JSON.stringify(safe).length).toBeLessThanOrEqual(MAX_ATTRIBUTE_TREE_CHARS + 1024);
  });

  it('stops copying string leaves after the character budget, however many leaves there are', () => {
    const megabyte = 'x'.repeat(1_000_000);
    const many = Array.from({ length: 1000 }, () => megabyte);
    const safe = safeAnyValue(many) as unknown[];
    expect(safe.at(-1)).toBe('[Truncated]');
    expect(JSON.stringify(safe).length).toBeLessThan(MAX_ATTRIBUTE_TREE_CHARS * 2);
    expect((stringifyAnyValue(many) as string).length).toBeLessThanOrEqual(
      MAX_ATTRIBUTE_JSON_LENGTH,
    );
  });

  it('reads a non-byte typed array by index within the node budget instead of listing every key', () => {
    const embedding = new Float32Array(MAX_ATTRIBUTE_NODES * 10).fill(0.5);
    const safe = safeAnyValue(embedding) as unknown[];
    expect(safe[0]).toBe(0.5);
    expect(safe.at(-1)).toBe('[Truncated]');
    expect(safe.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_NODES);
  });

  it('does not throw when the serialized tree cannot be stringified', () => {
    // A tree is JSON-safe by construction; force the failure path through an unusable JSON.stringify.
    const original = JSON.stringify;
    JSON.stringify = () => {
      throw new RangeError('Invalid string length');
    };
    try {
      expect(stringifyAnyValue({ a: 1 })).toBe('"[Unreadable]"');
    } finally {
      JSON.stringify = original;
    }
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

const Url = (globalThis as unknown as { URL: new (input: string) => object }).URL;

describe('non-plain values (deliberate handling)', () => {
  it('writes a URL as its href with any credentials removed', () => {
    expect(safeAnyValue({ u: new Url('https://user:pw@example.com/a?b=1#c') })).toEqual({
      u: 'https://example.com/a?b=1#c',
    });
    expect(normalizeAttributeValue(new Url('https://example.com/x'))).toBe('https://example.com/x');
  });

  it('writes an Error as its name and message only (never the stack)', () => {
    const out = safeAnyValue({ e: new TypeError('bad input') }) as { e: Record<string, unknown> };
    expect(out.e).toEqual({ name: 'TypeError', message: 'bad input' });
    expect(JSON.stringify(out)).not.toContain('at ');
  });

  it('writes a top-level Date as a plain ISO string, not JSON text', () => {
    expect(normalizeAttributeValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(normalizeAttributeValue(new Date(Number.NaN))).toBeUndefined();
  });

  it('reads ArrayBuffer, DataView and a cross-realm Uint8Array as bytes', () => {
    const bytes = new Uint8Array([102, 111, 111]);
    expect(normalizeAttributeValue(bytes.buffer)).toBe('Zm9v');
    expect(normalizeAttributeValue(new DataView(bytes.buffer, 1, 2))).toBe('b28=');
    // A typed array from another realm fails `instanceof Uint8Array` (it became an index map before).
    const vm = (
      globalThis as unknown as {
        process: { getBuiltinModule(id: string): { runInNewContext(code: string): unknown } };
      }
    ).process.getBuiltinModule('node:vm');
    const foreign = vm.runInNewContext('new Uint8Array([102, 111, 111])') as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(normalizeAttributeValue(foreign)).toBe('Zm9v');
    const huge = vm.runInNewContext('new Uint8Array(100000)') as Uint8Array;
    const out = normalizeAttributeValue(huge) as string;
    expect(out.length).toBe(MAX_ATTRIBUTE_JSON_LENGTH);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('leaves Map and Set as empty objects (documented: no own enumerable properties)', () => {
    expect(safeAnyValue({ m: new Map([['a', 1]]), s: new Set([1]) })).toEqual({ m: {}, s: {} });
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

  it('keeps a mixed array, an array with null, or a nested array as a bounded COPY, not text', () => {
    expect(normalizeAttributeValue([1, 'a', true])).toEqual([1, 'a', true]);
    expect(normalizeAttributeValue(['a', null])).toEqual(['a', null]);
    expect(normalizeAttributeValue([[1], [2]])).toEqual([[1], [2]]);
  });

  it('passes a homogeneous scalar array that contains null/undefined entries through unchanged', () => {
    const withNull = ['a', null, 'b'];
    const nums = [1, undefined, 3];
    expect(normalizeAttributeValue(withNull)).toBe(withNull);
    expect(normalizeAttributeValue(nums)).toBe(nums);
    expect(flattenAttributeValue(withNull)).toBe(withNull);
    // ...but a mixed array still goes the tree route
    expect(normalizeAttributeValue(['a', 1, null])).toEqual(['a', 1, null]);
    expect(normalizeAttributeValue(['a', 1, null])).not.toBe(withNull);
  });

  it('routes a primitive array past the length cap through the bounded tree (truncated)', () => {
    const long = Array.from({ length: MAX_ATTRIBUTE_ARRAY_LENGTH + 1 }, () => 'a');
    const out = normalizeAttributeValue(long) as unknown[];
    expect(out).not.toBe(long);
    expect(out.at(-1)).toBe('[Truncated]');
    const atCap = Array.from({ length: MAX_ATTRIBUTE_ARRAY_LENGTH }, () => 'a');
    expect(normalizeAttributeValue(atCap)).toBe(atCap);
  });

  it('keeps an object as a safe copy (nested keys still visible to redaction) and bytes as base64', () => {
    const input = { a: { b: [1, 'x'] } };
    const out = normalizeAttributeValue(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(normalizeAttributeValue(new Uint8Array([102, 111, 111]))).toBe('Zm9v');
    expect(normalizeAttributeValue(nodeBuffer.from('hi'))).toBe('aGk=');
  });

  it('caps a scalar string at the documented limit, marked, and leaves one at the limit alone', () => {
    const atLimit = 'x'.repeat(MAX_ATTRIBUTE_STRING_LENGTH);
    expect(normalizeAttributeValue(atLimit)).toBe(atLimit);
    const over = normalizeAttributeValue(`${atLimit}y`) as string;
    expect(over.length).toBe(MAX_ATTRIBUTE_STRING_LENGTH);
    expect(over.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('does not pass a string array through when its strings add up past the string limit', () => {
    const big = Array.from({ length: 4 }, () => 'x'.repeat(MAX_ATTRIBUTE_STRING_LENGTH / 2));
    const out = normalizeAttributeValue(big) as string[];
    expect(out).not.toBe(big);
    const small = [
      'a'.repeat(MAX_ATTRIBUTE_STRING_LENGTH / 2),
      'b'.repeat(MAX_ATTRIBUTE_STRING_LENGTH / 2),
    ];
    expect(normalizeAttributeValue(small)).toBe(small);
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
    ).toEqual({ s: 'x', n: 3, tags: ['a', 'b'], obj: { k: 1 }, mixed: [1, 'a'], bytes: 'AQ==' });
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

  it('yields no attributes, not a throw, when the keys cannot be listed (Proxy ownKeys trap)', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    expect(normalizeAttributes(hostile)).toEqual({});
  });

  it('reads only own enumerable string keys', () => {
    const inherited = Object.create({ inherited: 'no' }) as Record<string, unknown>;
    inherited.own = 'yes';
    expect(normalizeAttributes(inherited)).toEqual({ own: 'yes' });
  });
});

describe('work bounds that output alone cannot show', () => {
  it('encodes at most what could fit: a huge byte array is cut BEFORE it is base64-encoded', () => {
    const spy = vi.spyOn(Uint8Array.prototype, 'subarray');
    try {
      boundedBase64(new Uint8Array(1_000_000));
      expect(spy).toHaveBeenCalledWith(0, Math.ceil((MAX_ATTRIBUTE_JSON_LENGTH * 3) / 4) + 3);
      spy.mockClear();
      boundedBase64(new Uint8Array(10));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('copies exactly MAX_ATTRIBUTE_NODES - 1 members of a wide object, then flags truncation', () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_ATTRIBUTE_NODES + 50 }, (_, i) => [`k${i}`, 0]),
    );
    const keys = Object.keys(safeAnyValue(wide) as Record<string, unknown>);
    expect(keys).toHaveLength(1024); // 1023 members + the flag: MAX_ATTRIBUTE_NODES is 1024
    expect(keys.at(-1)).toBe('[Truncated]');
  });
});

describe('truncated keys cannot hide a sensitive name', () => {
  it('redacts the value of a key too long to keep, instead of shipping it under a key that lost its tail', () => {
    const key = `${'x'.repeat(MAX_ATTRIBUTE_JSON_LENGTH)}password`;
    const out = safeAnyValue({ [key]: 'longkeysecret', fine: 1 }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('longkeysecret');
    expect(out.fine).toBe(1);
    const [cut] = Object.keys(out);
    expect(cut).toContain(TRUNCATION_MARKER);
    expect(out[cut as string]).toBe('<redacted>');
  });

  it('keeps a key exactly at the limit', () => {
    const key = 'k'.repeat(MAX_ATTRIBUTE_JSON_LENGTH - 64);
    expect(safeAnyValue({ [key]: 'v' })).toEqual({ [key]: 'v' });
  });
});

describe('boundedBase64', () => {
  it('encodes small arrays whole and cuts a huge one with the marker', () => {
    expect(boundedBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v');
    const out = boundedBase64(new Uint8Array(1_000_000));
    expect(out.length).toBe(MAX_ATTRIBUTE_JSON_LENGTH);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe('flattenAttributeValue (the wire form)', () => {
  it('leaves scalars and small homogeneous scalar arrays untouched', () => {
    const arr = ['a', 'b'];
    expect(flattenAttributeValue('s')).toBe('s');
    expect(flattenAttributeValue(3)).toBe(3);
    expect(flattenAttributeValue(arr)).toBe(arr);
  });

  it('turns any remaining complex value into one bounded JSON string', () => {
    expect(flattenAttributeValue({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
    expect(flattenAttributeValue([1, 'a'])).toBe('[1,"a"]');
    expect(flattenAttributeValue(new Uint8Array([102, 111, 111]))).toBe('Zm9v');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(flattenAttributeValue(cyc)).toBe('{"self":"[Circular]"}');
    expect((flattenAttributeValue({ big: 'x'.repeat(1e6) }) as string).length).toBeLessThanOrEqual(
      MAX_ATTRIBUTE_JSON_LENGTH,
    );
  });

  it('drops what has no representation', () => {
    expect(flattenAttributeValue(null)).toBeUndefined();
    expect(flattenAttributeValue(() => 1)).toBeUndefined();
  });
});

describe('flattenAttributes', () => {
  it('returns the SAME record when nothing needed changing', () => {
    const attrs = { a: 'x', n: 1, tags: ['a', 'b'] };
    expect(flattenAttributes(attrs)).toBe(attrs);
  });

  it('flattens only the complex entries and drops the unrepresentable ones', () => {
    const out = flattenAttributes({ a: 'x', o: { k: 1 }, nul: null });
    expect(out).toEqual({ a: 'x', o: '{"k":1}' });
  });

  it('never throws: an unreadable attribute is dropped, an unlistable record is emptied', () => {
    const getter = {
      ok: 1,
      get boom(): never {
        throw new Error('getter');
      },
    };
    expect(flattenAttributes(getter)).toEqual({ ok: 1 });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    expect(flattenAttributes(hostile)).toEqual({});
  });
});
