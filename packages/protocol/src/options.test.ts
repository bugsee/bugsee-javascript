import { describe, expect, it } from 'vitest';
import { optionKeyFromWire, optionKeyToWire, optionsToWire } from './index';

describe('optionKeyToWire', () => {
  it('replaces every dot with a colon', () => {
    expect(optionKeyToWire('capture.network.bodies')).toBe('capture:network:bodies');
  });

  it('leaves a dotless key unchanged', () => {
    expect(optionKeyToWire('debug')).toBe('debug');
  });

  it('handles an empty key', () => {
    expect(optionKeyToWire('')).toBe('');
  });
});

describe('optionKeyFromWire', () => {
  it('replaces every colon with a dot', () => {
    expect(optionKeyFromWire('capture:network:bodies')).toBe('capture.network.bodies');
  });

  it('round-trips a dotted key', () => {
    expect(optionKeyFromWire(optionKeyToWire('a.b.c'))).toBe('a.b.c');
  });
});

describe('optionsToWire', () => {
  it('translates all keys to colon form, preserving values', () => {
    expect(optionsToWire({ 'capture.network': true, 'max.data.size': 10 })).toEqual({
      'capture:network': true,
      'max:data:size': 10,
    });
  });

  it('does not mutate the input', () => {
    const input = { 'a.b': 1 };
    optionsToWire(input);
    expect(input).toEqual({ 'a.b': 1 });
  });

  it('keeps a __proto__ key as own data without polluting any prototype', () => {
    const out = optionsToWire(JSON.parse('{"__proto__": {"polluted": true}, "a.b": 1}'));
    expect((out as Record<string, unknown>)['a:b']).toBe(1);
    expect((out as Record<string, unknown>).polluted).toBeUndefined(); // not via out's prototype
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // not via global prototype
  });
});
