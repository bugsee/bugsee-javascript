import type { Clock } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { type ActiveSpanStore, createSingleSlotActiveSpanStore } from './active-span-store';
import { createTransaction, type Transaction } from './span';

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

const txn = (name: string): Transaction =>
  createTransaction({ name, operation: 'op' }, { clock: fixedClock });

describe('createSingleSlotActiveSpanStore', () => {
  it('starts empty — get() is undefined before any set()', () => {
    const store = createSingleSlotActiveSpanStore();
    expect(store.get()).toBeUndefined();
  });

  it('returns what was set, by identity', () => {
    const store = createSingleSlotActiveSpanStore();
    const first = txn('first');
    store.set(first);
    expect(store.get()).toBe(first);
  });

  it('the latest set() wins', () => {
    const store = createSingleSlotActiveSpanStore();
    const first = txn('first');
    const second = txn('second');
    store.set(first);
    store.set(second);
    expect(store.get()).toBe(second);
  });

  it('clear() drops the held transaction on identity match, and only on match', () => {
    const store = createSingleSlotActiveSpanStore();
    const held = txn('held');
    const other = txn('other');
    store.set(held);
    store.clear(other); // finishing some other transaction must NOT clear this one
    expect(store.get()).toBe(held);
    store.clear(held);
    expect(store.get()).toBeUndefined();
  });

  it('clear() on an empty store is a no-op', () => {
    const store = createSingleSlotActiveSpanStore();
    expect(() => store.clear(txn('ghost'))).not.toThrow();
    expect(store.get()).toBeUndefined();
  });

  it('get() never returns a finished transaction', () => {
    const store = createSingleSlotActiveSpanStore();
    const finished = txn('done');
    finished.finish();
    store.set(finished);
    expect(store.get()).toBeUndefined(); // stale entries read as absent, not as dead transactions
  });

  it('each factory call mints an independent slot', () => {
    const a = createSingleSlotActiveSpanStore();
    const b: ActiveSpanStore = createSingleSlotActiveSpanStore();
    a.set(txn('A'));
    expect(b.get()).toBeUndefined();
  });
});
