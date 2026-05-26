import { describe, expect, it } from 'vitest';
import { type Breadcrumb, createScope } from './scope';

const crumb = (over: Partial<Breadcrumb> = {}): Breadcrumb => ({ timestamp: 1, ...over });

describe('createScope — user identifier', () => {
  it('is null before being set', () => {
    expect(createScope().getUserIdentifier()).toBeNull();
  });

  it('round-trips a set identifier', () => {
    const scope = createScope();
    scope.setUserIdentifier('user-42');
    expect(scope.getUserIdentifier()).toBe('user-42');
  });

  it('overwrites a previously set identifier', () => {
    const scope = createScope();
    scope.setUserIdentifier('a');
    scope.setUserIdentifier('b');
    expect(scope.getUserIdentifier()).toBe('b');
  });

  it('clears back to null', () => {
    const scope = createScope();
    scope.setUserIdentifier('a');
    scope.clearUserIdentifier();
    expect(scope.getUserIdentifier()).toBeNull();
  });
});

describe('createScope — attributes', () => {
  it('returns undefined for an unset attribute', () => {
    expect(createScope().getAttribute('missing')).toBeUndefined();
  });

  it('stores and reads back each attribute value type', () => {
    const scope = createScope();
    scope.setAttribute('s', 'str');
    scope.setAttribute('n', 7);
    scope.setAttribute('b', true);
    scope.setAttribute('arr', ['a', 'b']);
    expect(scope.getAttribute('s')).toBe('str');
    expect(scope.getAttribute('n')).toBe(7);
    expect(scope.getAttribute('b')).toBe(true);
    expect(scope.getAttribute('arr')).toEqual(['a', 'b']);
  });

  it('overwrites an existing attribute', () => {
    const scope = createScope();
    scope.setAttribute('k', 1);
    scope.setAttribute('k', 2);
    expect(scope.getAttribute('k')).toBe(2);
  });

  it('getAllAttributes returns every attribute', () => {
    const scope = createScope();
    scope.setAttribute('a', 1);
    scope.setAttribute('b', 2);
    expect(scope.getAllAttributes()).toEqual({ a: 1, b: 2 });
  });

  it('clearAttribute removes a single attribute', () => {
    const scope = createScope();
    scope.setAttribute('a', 1);
    scope.setAttribute('b', 2);
    scope.clearAttribute('a');
    expect(scope.getAttribute('a')).toBeUndefined();
    expect(scope.getAllAttributes()).toEqual({ b: 2 });
  });

  it('clearAllAttributes empties the set', () => {
    const scope = createScope();
    scope.setAttribute('a', 1);
    scope.clearAllAttributes();
    expect(scope.getAllAttributes()).toEqual({});
  });

  it('getAllAttributes returns a copy (mutation does not affect the scope)', () => {
    const scope = createScope();
    scope.setAttribute('a', 1);
    const snap = scope.getAllAttributes();
    snap.a = 999;
    snap.b = 2;
    expect(scope.getAttribute('a')).toBe(1);
    expect(scope.getAllAttributes()).toEqual({ a: 1 });
  });

  it('a __proto__ attribute key is own data and does not pollute Object.prototype', () => {
    const scope = createScope();
    scope.setAttribute('__proto__', 'x');
    const all = scope.getAllAttributes();
    expect(Object.getOwnPropertyDescriptor(all, '__proto__')?.value).toBe('x');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(all)).toBe(Object.prototype);
  });
});

describe('createScope — breadcrumbs', () => {
  it('starts empty', () => {
    expect(createScope().getBreadcrumbs()).toEqual([]);
  });

  it('records breadcrumbs in insertion order', () => {
    const scope = createScope();
    const a = crumb({ message: 'a' });
    const b = crumb({ message: 'b' });
    scope.addBreadcrumb(a);
    scope.addBreadcrumb(b);
    expect(scope.getBreadcrumbs()).toEqual([a, b]);
  });

  it('caps at maxBreadcrumbs, evicting oldest', () => {
    const scope = createScope({ maxBreadcrumbs: 2 });
    scope.addBreadcrumb(crumb({ message: '1' }));
    scope.addBreadcrumb(crumb({ message: '2' }));
    scope.addBreadcrumb(crumb({ message: '3' }));
    expect(scope.getBreadcrumbs().map((b) => b.message)).toEqual(['2', '3']);
  });

  it('defaults to a cap of 100', () => {
    const scope = createScope();
    for (let i = 0; i < 101; i += 1) {
      scope.addBreadcrumb(crumb({ message: String(i) }));
    }
    const crumbs = scope.getBreadcrumbs();
    expect(crumbs).toHaveLength(100);
    expect(crumbs[0]?.message).toBe('1'); // breadcrumb 0 evicted
  });

  it('clearBreadcrumbs empties the ring', () => {
    const scope = createScope();
    scope.addBreadcrumb(crumb());
    scope.clearBreadcrumbs();
    expect(scope.getBreadcrumbs()).toEqual([]);
  });

  it('getBreadcrumbs returns a copy (mutation does not affect the scope)', () => {
    const scope = createScope();
    scope.addBreadcrumb(crumb({ message: 'a' }));
    const snap = scope.getBreadcrumbs();
    snap.push(crumb({ message: 'injected' }));
    expect(scope.getBreadcrumbs()).toHaveLength(1);
  });

  it('throws for an invalid maxBreadcrumbs', () => {
    expect(() => createScope({ maxBreadcrumbs: 0 })).toThrow(RangeError);
  });
});
