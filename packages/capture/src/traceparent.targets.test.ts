import { describe, expect, it, vi } from 'vitest';
import type { OutgoingRequest } from './request-decorator';
import { createTraceparentDecorator, type TraceContextSource } from './traceparent';

const span: TraceContextSource = {
  getTraceId: () => '0123456789abcdef0123456789abcdef',
  getSpanId: () => 'aaaaaaaaaaaaaaaa',
  isSampled: () => true,
};
const req = (url: string): OutgoingRequest => ({ url, method: 'GET', headers: {} });
const make = (
  allowlist: unknown,
  onError?: (error: unknown) => void,
): ReturnType<typeof createTraceparentDecorator> =>
  createTraceparentDecorator({
    getActiveSpan: () => span,
    origin: 'https://app.test',
    allowlist: allowlist as ReadonlyArray<string | RegExp>,
    ...(onError !== undefined ? { onError } : {}),
  });

// `tracePropagationTargets` decides which THIRD PARTIES receive the trace + session ids.
describe('createTraceparentDecorator: the allow-list is validated', () => {
  it('an empty string matches nothing (it is a substring of every URL)', () => {
    const d = make(['']);
    expect(d(req('https://third-party.test/x'))).toBeUndefined();
    expect(d(req('https://another.test/'))).toBeUndefined();
  });

  it('an empty entry is dropped but the real ones stay (an unset env var split into a list)', () => {
    const d = make(['', 'api.internal.test']);
    expect(d(req('https://third-party.test/x'))).toBeUndefined();
    expect(d(req('https://api.internal.test/x'))).toBeDefined();
  });

  it('same-origin still propagates with a list of only empty strings', () => {
    expect(make([''])(req('https://app.test/x'))).toBeDefined();
  });

  it.each([
    ['a string', 'api.internal.test'],
    ['a RegExp', /internal/],
    ['an object', { 0: 'api.internal.test', length: 1 }],
    ['null', null],
    ['a number', 1],
    ['true', true],
  ])('%s instead of a list propagates to nobody and is reported', (_name, value) => {
    const onError = vi.fn();
    const d = make(value, onError);
    expect(d(req('https://api.internal.test/x'))).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/tracePropagationTargets/);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/array/);
  });

  it('an undefined list is simply absent (no report)', () => {
    const onError = vi.fn();
    expect(make(undefined, onError)(req('https://third-party.test/x'))).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['a number', 5, '5'],
    ['null', null, 'null'],
    ['an object', { a: 1 }, '[object Object]'],
    ['a function', function pick() {}, 'function pick'],
    ['a bigint', 3n, '3n'],
    ['a symbol', Symbol('s'), 'Symbol(s)'],
  ])('an entry that is %s is reported, skipped, and does not stop the valid ones', (_name, entry, text) => {
    const onError = vi.fn();
    const d = make([entry, 'api.internal.test'], onError);
    expect(d(req('https://api.internal.test/x'))).toBeDefined();
    expect(d(req('https://third-party.test/x'))).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain(text);
  });

  it('a throwing onError does not break creating the decorator', () => {
    const onError = vi.fn(() => {
      throw new Error('sink is down');
    });
    const d = make(['api.internal.test', 7], onError);
    expect(onError).toHaveBeenCalled();
    expect(d(req('https://api.internal.test/x'))).toBeDefined();
  });

  it('invalid input without an onError is dropped silently', () => {
    expect(make('nope')(req('https://api.internal.test/x'))).toBeUndefined();
    expect(make([7])(req('https://api.internal.test/x'))).toBeUndefined();
  });
});

describe('createTraceparentDecorator: a stateful RegExp matches the same way every time', () => {
  it('a /g regex does not alternate sent / not sent (lastIndex carried between calls)', () => {
    const d = make([/api\.internal\.test/g]);
    const results = [1, 2, 3, 4, 5, 6].map(
      () => d(req('https://api.internal.test/x')) !== undefined,
    );
    expect(results).toEqual([true, true, true, true, true, true]);
  });

  it('a /y regex does not alternate either', () => {
    const d = make([/^https:\/\/api\.internal\.test/y]);
    const results = [1, 2, 3, 4].map(() => d(req('https://api.internal.test/x')) !== undefined);
    expect(results).toEqual([true, true, true, true]);
  });

  it("the application's own regex is not mutated", () => {
    const pattern = /internal/g;
    pattern.lastIndex = 3;
    const d = make([pattern]);
    d(req('https://api.internal.test/x'));
    expect(pattern.lastIndex).toBe(3);
    expect(pattern.flags).toBe('g');
  });

  it('other flags survive (case-insensitive still matches)', () => {
    const d = make([/INTERNAL/gi]);
    expect(d(req('https://api.internal.test/x'))).toBeDefined();
    expect(d(req('https://api.internal.test/x'))).toBeDefined();
    expect(d(req('https://third-party.test/x'))).toBeUndefined();
  });
});
