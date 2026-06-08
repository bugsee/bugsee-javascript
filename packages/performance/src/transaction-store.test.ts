import { describe, expect, it } from 'vitest';
import type { TransactionWire } from './span';
import { createTransactionStore } from './transaction-store';

const wire = (name: string): TransactionWire => ({ name }) as TransactionWire;

describe('createTransactionStore', () => {
  it('collects transactions and drains them all (clearing the buffer)', () => {
    const store = createTransactionStore();
    store.add(wire('a'));
    store.add(wire('b'));
    expect(store.size()).toBe(2);
    expect(store.drain().map((t) => t.name)).toEqual(['a', 'b']);
    expect(store.size()).toBe(0); // drain clears
    expect(store.drain()).toEqual([]); // a second drain is empty
  });

  it('drains a copy (the returned array is detached from the store)', () => {
    const store = createTransactionStore();
    store.add(wire('a'));
    const drained = store.drain();
    drained.push(wire('x')); // mutating the result must not affect the store
    store.add(wire('b'));
    expect(store.drain().map((t) => t.name)).toEqual(['b']);
  });

  it('bounds the buffer to maxTransactions, dropping the oldest (FIFO)', () => {
    const store = createTransactionStore({ maxTransactions: 2 });
    store.add(wire('a'));
    store.add(wire('b'));
    store.add(wire('c')); // 'a' is evicted
    expect(store.size()).toBe(2);
    expect(store.drain().map((t) => t.name)).toEqual(['b', 'c']);
  });
});
