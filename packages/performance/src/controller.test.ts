import type { Clock } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createPerformanceController } from './controller';
import { createTransactionStore } from './transaction-store';

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

describe('createPerformanceController', () => {
  it('startTransaction returns a sampled transaction stamped with the app version/build', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      appVersion: '1.2.3',
      appBuild: '456',
    });
    const txn = api.startTransaction({
      name: 'Checkout',
      operation: 'ui.load',
      description: 'cart',
    });
    expect(txn.getName()).toBe('Checkout');
    expect(txn.getOperation()).toBe('ui.load');
    expect(txn.getDescription()).toBe('cart'); // a passed description is forwarded
    expect(txn.isSampled()).toBe(true);
  });

  it('tracks the active span: the started transaction, cleared when it finishes', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    expect(api.getActiveSpan()).toBeUndefined();
    const txn = api.startTransaction({ name: 'N', operation: 'op' });
    expect(api.getActiveSpan()).toBe(txn);
    txn.finish();
    expect(api.getActiveSpan()).toBeUndefined();
  });

  it('the latest started transaction becomes active; finishing a non-active one leaves it', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const first = api.startTransaction({ name: 'first', operation: 'op' });
    const second = api.startTransaction({ name: 'second', operation: 'op' });
    expect(api.getActiveSpan()).toBe(second);
    first.finish(); // finishing the NON-active transaction must NOT clear the active one
    expect(api.getActiveSpan()).toBe(second);
    second.finish(); // finishing the active one clears it
    expect(api.getActiveSpan()).toBeUndefined();
  });

  it('buffers a finished (sampled) transaction into the store, stamped with the app info', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      appVersion: '9.9',
      appBuild: 'b1',
    });
    const txn = api.startTransaction({ name: 'T', operation: 'op' });
    expect(store.size()).toBe(0); // nothing until it finishes
    txn.finish('OK');
    const drained = store.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      name: 'T',
      operation: 'op',
      appVersion: '9.9',
      appBuild: 'b1',
    });
  });

  it('drops an UNSAMPLED transaction (head sampling): returned but never buffered', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store, sampler: () => false });
    const txn = api.startTransaction({ name: 'T', operation: 'op' });
    expect(txn.isSampled()).toBe(false);
    txn.finish();
    expect(store.size()).toBe(0); // unsampled → not buffered
    expect(api.getActiveSpan()).toBeUndefined(); // still cleared as active
  });

  it('defaults to sampling everything when no sampler is injected', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    api.startTransaction({ name: 'T', operation: 'op' }).finish();
    expect(store.size()).toBe(1);
  });
});
