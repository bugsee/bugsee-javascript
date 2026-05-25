import { describe, expect, it } from 'vitest';
import { jsonSafeStringify } from './json-safe-stringify';

describe('jsonSafeStringify', () => {
  it('stringifies plain values like JSON.stringify', () => {
    expect(jsonSafeStringify({ a: 1, b: 'x', c: [true, null] })).toBe(
      '{"a":1,"b":"x","c":[true,null]}',
    );
  });

  it('serializes BigInt as its decimal string', () => {
    expect(jsonSafeStringify({ n: 10n })).toBe('{"n":"10"}');
  });

  it('replaces circular references with "[Circular]"', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(jsonSafeStringify(o)).toBe('{"a":1,"self":"[Circular]"}');
  });

  it('detects a cycle back to an ancestor at depth', () => {
    const a: Record<string, unknown> = { b: {} };
    (a.b as Record<string, unknown>).parent = a;
    expect(jsonSafeStringify(a)).toBe('{"b":{"parent":"[Circular]"}}');
  });

  it('keeps explicit null values', () => {
    expect(jsonSafeStringify({ a: null })).toBe('{"a":null}');
  });

  it('returns "null" for top-level undefined', () => {
    expect(jsonSafeStringify(undefined)).toBe('null');
  });

  it('returns "null" for a top-level function', () => {
    expect(jsonSafeStringify(() => 1)).toBe('null');
  });

  it('honors the space argument for pretty printing', () => {
    expect(jsonSafeStringify({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
  });

  it('reports repeated (non-circular) references as "[Circular]" (documented limitation)', () => {
    const shared = { v: 1 };
    expect(jsonSafeStringify({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":"[Circular]"}');
  });

  it('serializes a top-level BigInt as its decimal string', () => {
    expect(jsonSafeStringify(10n)).toBe('"10"');
  });

  it('omits nested undefined and function values (standard JSON behavior)', () => {
    expect(jsonSafeStringify({ a: undefined, b: () => 1, c: 2 })).toBe('{"c":2}');
  });
});
