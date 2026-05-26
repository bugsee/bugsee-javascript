import { describe, expect, it } from 'vitest';
import { sanitizeHeaders, sanitizeJson, sanitizeParams } from './index';

const R = '<redacted>';
const GH = `ghp_${'a'.repeat(36)}`;

describe('sanitizeHeaders', () => {
  it('redacts the value of a sensitive header, preserving its name/casing', () => {
    expect(sanitizeHeaders({ Authorization: 'Bearer x', Cookie: 'a=b' })).toEqual({
      Authorization: R,
      Cookie: R,
    });
  });

  it('shape-scans non-sensitive header values and leaves clean ones', () => {
    expect(sanitizeHeaders({ 'X-Trace': GH, 'Content-Type': 'application/json' })).toEqual({
      'X-Trace': R,
      'Content-Type': 'application/json',
    });
  });

  it('does not mutate the input', () => {
    const input = { Authorization: 'Bearer x' };
    sanitizeHeaders(input);
    expect(input).toEqual({ Authorization: 'Bearer x' });
  });

  it('keeps a __proto__ header as own data (no prototype pollution / value loss)', () => {
    const out = sanitizeHeaders(JSON.parse('{"__proto__":"x","Accept":"*/*"}')) as Record<
      string,
      unknown
    >;
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('x');
    expect(out.Accept).toBe('*/*');
  });

  it('threads the creditCards option into the shape pass', () => {
    // CC shape is off by default; only redacts a non-sensitive header value when the option is on.
    expect(sanitizeHeaders({ 'X-Card': '5555555555554444' })).toEqual({
      'X-Card': '5555555555554444',
    });
    expect(sanitizeHeaders({ 'X-Card': '5555555555554444' }, { creditCards: true })).toEqual({
      'X-Card': R,
    });
  });
});

describe('sanitizeParams', () => {
  it('redacts sensitive keys and shape-scans other values', () => {
    expect(sanitizeParams({ password: 'hunter2', note: 'sk_live_x', q: 'hello' })).toEqual({
      password: R,
      note: R,
      q: 'hello',
    });
  });

  it('keeps a __proto__ param as own data (no prototype pollution / value loss)', () => {
    const out = sanitizeParams(JSON.parse('{"__proto__":"x","q":"ok"}')) as Record<string, unknown>;
    // own data property, not dropped by the prototype setter (which would happen on a plain {})
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('x');
    expect(out.q).toBe('ok');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('threads the creditCards option into the shape pass', () => {
    expect(sanitizeParams({ note: '5555555555554444' }, { creditCards: true })).toEqual({
      note: R,
    });
  });
});

describe('sanitizeJson', () => {
  it('redacts sensitive keys and recurses into objects', () => {
    expect(sanitizeJson({ token: 'x', user: { name: 'a', secret: 's' } })).toEqual({
      token: R,
      user: { name: 'a', secret: R },
    });
  });

  it('recurses into arrays and shape-scans string values', () => {
    expect(sanitizeJson({ items: [GH, 'ok'] })).toEqual({ items: [R, 'ok'] });
  });

  it('recurses into objects nested inside arrays and leaves non-string elements', () => {
    expect(sanitizeJson([{ token: 'x' }, 42])).toEqual([{ token: R }, 42]);
  });

  it('threads the creditCards option into the recursive shape pass', () => {
    expect(sanitizeJson({ note: '5555555555554444' }, { creditCards: true })).toEqual({ note: R });
  });

  it('leaves non-string primitives unchanged', () => {
    expect(sanitizeJson({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });

  it('shape-scans a bare string', () => {
    expect(sanitizeJson('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N')).toBe(
      `jwt ${R}`,
    );
  });

  it('keeps a __proto__ key as own data without polluting any prototype', () => {
    const out = sanitizeJson(JSON.parse('{"__proto__": {"polluted": true}, "a": "ok"}')) as Record<
      string,
      unknown
    >;
    expect(out.a).toBe('ok');
    expect(out.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const input = { token: 'x', nested: { secret: 's' } };
    sanitizeJson(input);
    expect(input).toEqual({ token: 'x', nested: { secret: 's' } });
  });
});
