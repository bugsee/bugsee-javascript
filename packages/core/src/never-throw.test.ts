import { describe, expect, it, vi } from 'vitest';
import { guarded, neverThrow } from './never-throw';

describe('neverThrow — synchronous containment', () => {
  it('returns the value when nothing goes wrong', () => {
    expect(neverThrow(() => 42)).toBe(42);
  });

  it('contains a throw and reports it', () => {
    const onError = vi.fn();
    const boom = new Error('SDK BOOM');
    expect(
      neverThrow((): number => {
        throw boom;
      }, onError),
    ).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('contains a throw with no sink supplied', () => {
    expect(() =>
      neverThrow(() => {
        throw new Error('x');
      }),
    ).not.toThrow();
  });

  it('contains a non-Error throw', () => {
    const onError = vi.fn();
    neverThrow(() => {
      // biome-ignore lint/complexity/noUselessLoneBlockStatements: explicit non-Error throw
      throw 'a string';
    }, onError);
    expect(onError).toHaveBeenCalledWith('a string');
  });

  it('does not let a THROWING sink escape — the guard is the last line, so it cannot fail either', () => {
    expect(() =>
      neverThrow(
        () => {
          throw new Error('inner');
        },
        () => {
          throw new Error('the sink itself is broken');
        },
      ),
    ).not.toThrow();
  });
});

describe('neverThrow — asynchronous containment', () => {
  it('never leaves a rejection unhandled, and still reports it', async () => {
    // The idiomatic `void client.logException(...)` turns a rejection into an unhandled rejection in the
    // HOST process a tick later — which on Node is a crash again now that Wave 2.5 restored the default
    // disposition. A boundary guard that only catches synchronous throws would miss it entirely.
    // core declares no Node/DOM lib, so the runtime is reached through a cast (repo convention).
    const g = globalThis as unknown as {
      process: { on(e: string, l: () => void): void; off(e: string, l: () => void): void };
      setTimeout(fn: () => void, ms: number): unknown;
    };
    const onError = vi.fn();
    const rejection = new Error('async boom');
    const unhandled = vi.fn();
    g.process.on('unhandledRejection', unhandled);
    neverThrow(() => Promise.reject(rejection), onError);
    await new Promise((resolve) => g.setTimeout(() => resolve(undefined), 10));
    g.process.off('unhandledRejection', unhandled);
    expect(onError).toHaveBeenCalledWith(rejection);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('returns the ORIGINAL promise, so a caller that awaits still gets the value', async () => {
    const promise = Promise.resolve('value');
    expect(neverThrow(() => promise)).toBe(promise);
    await expect(neverThrow(() => Promise.resolve('v'))).resolves.toBe('v');
  });

  it('handles a thenable that is not a real promise', async () => {
    const onError = vi.fn();
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: a custom thenable is exactly what is under test
      then: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error('nope')),
    };
    neverThrow(() => thenable, onError);
    expect(onError).toHaveBeenCalled();
  });

  it('leaves a resolved promise’s value untouched', async () => {
    const onError = vi.fn();
    await neverThrow(() => Promise.resolve(1), onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not treat null or a plain object as a promise', () => {
    expect(neverThrow(() => null)).toBeNull();
    expect(neverThrow(() => ({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe('guarded', () => {
  it('wraps a function so every call is contained, preserving arguments and return', () => {
    const fn = guarded((a: number, b: number) => a + b);
    expect(fn(2, 3)).toBe(5);
  });

  it('contains a throw on call and reports it', () => {
    const onError = vi.fn();
    const fn = guarded((): number => {
      throw new Error('handler boom');
    }, onError);
    expect(fn()).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
