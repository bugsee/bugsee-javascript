import { describe, expect, it } from 'vitest';
import { createDeferred, isThenable } from './deferred';

describe('createDeferred', () => {
  it('resolves its promise with the provided value', async () => {
    const d = createDeferred<number>();
    d.resolve(42);
    await expect(d.promise).resolves.toBe(42);
  });

  it('resolves to the awaited value when given a thenable', async () => {
    const d = createDeferred<number>();
    d.resolve(Promise.resolve(7));
    await expect(d.promise).resolves.toBe(7);
  });

  it('rejects its promise with the provided reason', async () => {
    const d = createDeferred<number>();
    const reason = new Error('boom');
    d.reject(reason);
    await expect(d.promise).rejects.toBe(reason);
  });

  it('is not settled before resolve or reject', () => {
    const d = createDeferred<number>();
    expect(d.settled).toBe(false);
  });

  it('is settled after resolve', () => {
    const d = createDeferred<number>();
    d.resolve(1);
    expect(d.settled).toBe(true);
  });

  it('is settled after reject', async () => {
    const d = createDeferred<number>();
    d.reject(new Error('x'));
    expect(d.settled).toBe(true);
    await d.promise.catch(() => undefined); // consume rejection
  });

  it('keeps the first settlement (native promise idempotency)', async () => {
    const d = createDeferred<number>();
    d.resolve(1);
    d.resolve(2);
    await expect(d.promise).resolves.toBe(1);
  });

  it('keeps the resolved value if reject is called afterward, and stays settled', async () => {
    const d = createDeferred<number>();
    d.resolve(1);
    d.reject(new Error('late'));
    expect(d.settled).toBe(true);
    await expect(d.promise).resolves.toBe(1);
  });
});

describe('isThenable', () => {
  it('accepts a native promise', () => {
    expect(isThenable(Promise.resolve())).toBe(true);
  });

  it('accepts a hand-rolled thenable', () => {
    // biome-ignore lint/suspicious/noThenProperty: a hand-rolled thenable is exactly what is under test
    expect(isThenable({ then: () => undefined })).toBe(true);
  });

  it.each([
    undefined,
    null,
    0,
    '',
    'x',
    42,
    {},
    // biome-ignore lint/suspicious/noThenProperty: a NON-callable `then` is the case being rejected
    { then: 1 },
    [],
    () => {},
  ])('rejects %o, which has no callable `then`', (value) => {
    expect(isThenable(value)).toBe(false);
  });

  it('does not throw on a value whose `then` getter throws', () => {
    // A store's return value is caller-supplied; probing it must not become the failure.
    // biome-ignore lint/suspicious/noThenProperty: a hostile `then` getter is the case being guarded
    const hostile = Object.defineProperty({}, 'then', {
      get() {
        throw new Error('hostile');
      },
    });
    expect(() => isThenable(hostile)).not.toThrow();
    expect(isThenable(hostile)).toBe(false);
  });
});
