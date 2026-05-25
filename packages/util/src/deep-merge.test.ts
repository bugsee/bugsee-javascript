import { describe, expect, it } from 'vitest';
import { deepMerge } from './deep-merge';

describe('deepMerge', () => {
  it('unions disjoint keys', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('overrides primitive values from source', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('merges nested plain objects recursively', () => {
    expect(deepMerge({ a: { x: 1, y: 1 } }, { a: { y: 2, z: 3 } })).toEqual({
      a: { x: 1, y: 2, z: 3 },
    });
  });

  it('replaces arrays instead of merging them', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it('replaces when source is an object but target is not', () => {
    expect(deepMerge({ a: 1 }, { a: { x: 2 } })).toEqual({ a: { x: 2 } });
  });

  it('lets a null source value override', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: null })).toEqual({ a: null });
  });

  it('replaces with a class instance rather than merging its keys', () => {
    const date = new Date(0);
    expect(deepMerge({ a: { x: 1 } }, { a: date }).a).toBe(date);
  });

  it('merges null-prototype objects (proto === null branch)', () => {
    const target = { a: Object.assign(Object.create(null), { x: 1 }) };
    const source = { a: Object.assign(Object.create(null), { y: 2 }) };
    expect(deepMerge(target, source)).toEqual({ a: { x: 1, y: 2 } });
  });

  it('does not mutate target or source', () => {
    const target = { a: { x: 1 } };
    const source = { a: { y: 2 } };
    deepMerge(target, source);
    expect(target).toEqual({ a: { x: 1 } });
    expect(source).toEqual({ a: { y: 2 } });
  });
});
