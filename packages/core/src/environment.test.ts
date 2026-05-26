import { describe, expect, it } from 'vitest';
import { createEnvironment } from './environment';

describe('createEnvironment — user identifier', () => {
  it('is null before being set', () => {
    expect(createEnvironment().getUserIdentifier()).toBeNull();
  });

  it('round-trips a set identifier', () => {
    const env = createEnvironment();
    env.setUserIdentifier('user-42');
    expect(env.getUserIdentifier()).toBe('user-42');
  });

  it('overwrites a previously set identifier', () => {
    const env = createEnvironment();
    env.setUserIdentifier('a');
    env.setUserIdentifier('b');
    expect(env.getUserIdentifier()).toBe('b');
  });

  it('clears back to null', () => {
    const env = createEnvironment();
    env.setUserIdentifier('a');
    env.clearUserIdentifier();
    expect(env.getUserIdentifier()).toBeNull();
  });
});

describe('createEnvironment — attributes', () => {
  it('returns undefined for an unset attribute', () => {
    expect(createEnvironment().getAttribute('missing')).toBeUndefined();
  });

  it('stores and reads back each attribute value type', () => {
    const env = createEnvironment();
    env.setAttribute('s', 'str');
    env.setAttribute('n', 7);
    env.setAttribute('b', true);
    env.setAttribute('arr', ['a', 'b']);
    expect(env.getAttribute('s')).toBe('str');
    expect(env.getAttribute('n')).toBe(7);
    expect(env.getAttribute('b')).toBe(true);
    expect(env.getAttribute('arr')).toEqual(['a', 'b']);
  });

  it('overwrites an existing attribute', () => {
    const env = createEnvironment();
    env.setAttribute('k', 1);
    env.setAttribute('k', 2);
    expect(env.getAttribute('k')).toBe(2);
  });

  it('getAllAttributes returns every attribute', () => {
    const env = createEnvironment();
    env.setAttribute('a', 1);
    env.setAttribute('b', 2);
    expect(env.getAllAttributes()).toEqual({ a: 1, b: 2 });
  });

  it('clearAttribute removes a single attribute', () => {
    const env = createEnvironment();
    env.setAttribute('a', 1);
    env.setAttribute('b', 2);
    env.clearAttribute('a');
    expect(env.getAttribute('a')).toBeUndefined();
    expect(env.getAllAttributes()).toEqual({ b: 2 });
  });

  it('clearAllAttributes empties the set', () => {
    const env = createEnvironment();
    env.setAttribute('a', 1);
    env.clearAllAttributes();
    expect(env.getAllAttributes()).toEqual({});
  });

  it('getAllAttributes returns a copy (mutation does not affect the environment)', () => {
    const env = createEnvironment();
    env.setAttribute('a', 1);
    const snap = env.getAllAttributes();
    snap.a = 999;
    snap.b = 2;
    expect(env.getAttribute('a')).toBe(1);
    expect(env.getAllAttributes()).toEqual({ a: 1 });
  });

  it('a __proto__ attribute key is own data and does not pollute Object.prototype', () => {
    const env = createEnvironment();
    env.setAttribute('__proto__', 'x');
    const all = env.getAllAttributes();
    expect(Object.getOwnPropertyDescriptor(all, '__proto__')?.value).toBe('x');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(all)).toBe(Object.prototype);
  });
});
