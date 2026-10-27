import { describe, expect, it } from 'vitest';
import {
  MAX_ROUTE_CHARS,
  MAX_VIEW_FIELD_CHARS,
  normalizeView,
  sanitizeRoutePattern,
  VIEW_NONE,
} from './screen-names';

const R = '%3Credacted%3E';
const MARK = '%3Ctruncated%3E';

describe('sanitizeRoutePattern', () => {
  it.each([
    ['/orders/:id', '/orders/:id'],
    ['/orders/[id]', '/orders/[id]'],
    ['/(app)/[[lang]]/x', '/(app)/[[lang]]/x'],
    ['/user/:id(\\d+)?/edit', '/user/:id(\\d+)?/edit'], // an optional-param `?` is pattern syntax, not a query
    ['/user/:id?', '/user/:id?'],
    ['/a/:b?/:c?', '/a/:b?/:c?'],
    ['/:p(\\d+?)/x', '/:p(\\d+?)/x'], // `?` before `)` is regexp syntax inside a param pattern
    ['/post/:slug+', '/post/:slug+'],
    ['/', '/'],
  ])('keeps the pattern %s as given', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it.each([
    ['/x?token=abc', '/x'],
    ['/x?tab=items', '/x'],
    ['/a/:b?/c?x=1', '/a/:b?/c'],
    ['/x#frag', '/x'],
    ['/x#access_token=abc', '/x'],
    ['/x?a=1#b', '/x'],
    ['/x#a?b=1', '/x'],
  ])('never keeps a query or fragment: %s', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it('redacts a secret-shaped token in the path (the shared sanitizer runs on the pathname fallback)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
    expect(sanitizeRoutePattern(`/a/${jwt}`)).toBe('/a/<redacted>');
  });

  it('redacts a sensitive matrix segment', () => {
    expect(sanitizeRoutePattern('/app;jsessionid=1/x')).toBe(`/app;jsessionid=${R}/x`);
  });

  it('returns undefined for a non-string, empty or whitespace-only route, or one that is only a query', () => {
    for (const bad of [undefined, null, 5, {}, ['/x'], '', '   ', '?a=1', '#x']) {
      expect(sanitizeRoutePattern(bad)).toBeUndefined();
    }
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeRoutePattern('  /x/:id \n')).toBe('/x/:id');
  });

  it('clips at MAX_ROUTE_CHARS and marks the clip', () => {
    expect(MAX_ROUTE_CHARS).toBe(1024);
    const exact = `/${'a'.repeat(MAX_ROUTE_CHARS - 1)}`;
    expect(sanitizeRoutePattern(exact)).toBe(exact);
    const over = `${exact}b`;
    expect(sanitizeRoutePattern(over)).toBe(`${exact}${MARK}`);
  });

  it('is linear-ish on huge input (bounded work)', () => {
    const out = sanitizeRoutePattern(`/${'a'.repeat(5_000_000)}`);
    expect(out?.length).toBe(MAX_ROUTE_CHARS + MARK.length);
  });
});

describe('normalizeView', () => {
  it('maps null to the "$$none" sentinel', () => {
    expect(VIEW_NONE).toBe('$$none');
    expect(normalizeView(null)).toBe('$$none');
  });

  it('maps a string to {name}', () => {
    expect(normalizeView('OrderDetail')).toEqual({ name: 'OrderDetail' });
  });

  it('keeps name and type of an object, and drops an unusable type', () => {
    expect(normalizeView({ name: 'OrderDetail', type: 'angular' })).toEqual({
      name: 'OrderDetail',
      type: 'angular',
    });
    expect(normalizeView({ name: 'A1', type: '' })).toStrictEqual({ name: 'A1' });
    expect(normalizeView({ name: 'A1', type: 5 as never })).toStrictEqual({ name: 'A1' });
    expect(normalizeView({ name: 'A1', type: undefined })).toStrictEqual({ name: 'A1' });
    expect(normalizeView('A1')).toStrictEqual({ name: 'A1' }); // no `type` key at all
  });

  it('writes keys in a fixed order (name, type) so equal views serialize equally', () => {
    const v = normalizeView({ type: 'vue', name: 'X1' } as never);
    expect(Object.keys(v as object)).toEqual(['name', 'type']);
  });

  it('returns undefined for anything that is not a usable view', () => {
    for (const bad of [
      undefined,
      5,
      true,
      '',
      '   ',
      {},
      { name: '' },
      { name: 5 },
      { type: 'x' },
      [],
    ]) {
      expect(normalizeView(bad as never)).toBeUndefined();
    }
  });

  it('runs name and type through the shared sanitizer', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
    expect(normalizeView(jwt)).toEqual({ name: '<redacted>' });
    expect(normalizeView({ name: 'ok', type: jwt })).toEqual({ name: 'ok', type: '<redacted>' });
    expect(normalizeView('javascript:alert(1)')).toEqual({ name: `javascript:${R}` });
  });

  it('keeps ordinary names with spaces and punctuation', () => {
    expect(normalizeView('Order Detail (v2)')).toEqual({ name: 'Order Detail (v2)' });
  });

  it('clips each field at MAX_VIEW_FIELD_CHARS and marks the clip', () => {
    expect(MAX_VIEW_FIELD_CHARS).toBe(256);
    const exact = 'a'.repeat(MAX_VIEW_FIELD_CHARS);
    expect(normalizeView(exact)).toEqual({ name: exact });
    expect(normalizeView({ name: `${exact}b`, type: `${exact}c` })).toEqual({
      name: exact + MARK,
      type: exact + MARK,
    });
  });
});
