import { describe, expect, it } from 'vitest';
import { describeValue } from './describe-value';

describe('describeValue (a diagnostic text for an invalid option value; never throws)', () => {
  it.each([
    ['a string is quoted', 'abc', '"abc"'],
    ['a number', 12.5, '12.5'],
    ['NaN', Number.NaN, 'NaN'],
    ['true', true, 'true'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a bigint (JSON.stringify throws on it)', 10n, '10n'],
    ['a symbol (String() of the description)', Symbol('why'), 'Symbol(why)'],
    ['an array', [1, 2, 3], 'array(3)'],
    ['a plain object', { a: 1 }, '[object Object]'],
    ['a Date', new Date(0), '[object Date]'],
  ])('%s', (_name, value, expected) => {
    expect(describeValue(value)).toBe(expected);
  });

  it('a function is named', () => {
    function namedHandler(): void {}
    expect(describeValue(namedHandler)).toBe('function namedHandler');
    expect(describeValue(() => 1)).toBe('function');
  });

  it('survives hostile values: a throwing name getter, a revoked proxy, an object with no prototype', () => {
    const fn = (): void => {};
    Object.defineProperty(fn, 'name', {
      get() {
        throw new Error('boom');
      },
    });
    expect(describeValue(fn)).toBe('function');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describeValue(proxy)).toBe('[object]');
    expect(describeValue(Object.create(null))).toBe('[object Object]');
  });

  it('keeps a string of exactly 60 characters and truncates 61', () => {
    expect(describeValue('y'.repeat(60))).toBe(`"${'y'.repeat(60)}"`);
    expect(describeValue('y'.repeat(61))).toBe(`"${'y'.repeat(57)}..."`);
  });

  it('truncates a long string', () => {
    const text = describeValue('x'.repeat(500));
    expect(text.length).toBeLessThanOrEqual(62);
    expect(text.endsWith('..."')).toBe(true);
  });
});
