import { describe, expect, it } from 'vitest';
import { checkOrSetAlreadyCaught } from './dedup';

describe('checkOrSetAlreadyCaught', () => {
  it('reports false on first sight of an error and true thereafter', () => {
    const err = new Error('boom');
    expect(checkOrSetAlreadyCaught(err)).toBe(false);
    expect(checkOrSetAlreadyCaught(err)).toBe(true);
    expect(checkOrSetAlreadyCaught(err)).toBe(true);
  });

  it('tracks distinct instances independently', () => {
    const a = new Error('a');
    const b = new Error('b');
    expect(checkOrSetAlreadyCaught(a)).toBe(false);
    expect(checkOrSetAlreadyCaught(b)).toBe(false); // b unaffected by a
    expect(checkOrSetAlreadyCaught(a)).toBe(true);
  });

  it('tags plain objects too', () => {
    const obj = { msg: 'x' };
    expect(checkOrSetAlreadyCaught(obj)).toBe(false);
    expect(checkOrSetAlreadyCaught(obj)).toBe(true);
  });

  it('tags functions (typeof function)', () => {
    const fn = () => {};
    expect(checkOrSetAlreadyCaught(fn)).toBe(false);
    expect(checkOrSetAlreadyCaught(fn)).toBe(true);
  });

  it.each([
    ['string', 'oops'],
    ['number', 42],
    ['boolean', true],
    ['null', null],
    ['undefined', undefined],
  ])('cannot tag a %s value, so always reports false', (_label, value) => {
    expect(checkOrSetAlreadyCaught(value)).toBe(false);
    expect(checkOrSetAlreadyCaught(value)).toBe(false);
  });

  it('does not throw and reports false for a frozen object (untaggable)', () => {
    const frozen = Object.freeze({ msg: 'x' });
    expect(() => checkOrSetAlreadyCaught(frozen)).not.toThrow();
    expect(checkOrSetAlreadyCaught(frozen)).toBe(false);
    expect(checkOrSetAlreadyCaught(frozen)).toBe(false); // still can't tag -> still false
  });

  it('adds the tag as a non-enumerable symbol that does not leak when cloning the error', () => {
    const err = Object.assign(new Error('boom'), { extra: 1 });
    checkOrSetAlreadyCaught(err);
    expect(Object.keys(err)).toEqual(['extra']); // string keys unaffected
    expect(Object.getOwnPropertySymbols(err).length).toBe(1); // the hidden tag exists on the error
    // enumerable:false means a spread/Object.assign clone does NOT carry the tag along.
    const clone = { ...err };
    expect(Object.getOwnPropertySymbols(clone)).toEqual([]);
  });
});
