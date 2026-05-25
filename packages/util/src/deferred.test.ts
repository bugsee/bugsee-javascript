import { describe, expect, it } from 'vitest';
import { createDeferred } from './deferred';

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
});
