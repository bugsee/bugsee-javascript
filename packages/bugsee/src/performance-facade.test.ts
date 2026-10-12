import { createClient } from '@bugsee/core';
import { createPerformanceController, createTransactionStore } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
import { withPerformanceFacade } from './performance-facade';

const clock = { wallNow: () => 1000, monotonicNow: () => 0 };

describe('withPerformanceFacade', () => {
  it('returns the same client object with the three calls installed on it', () => {
    const client = createClient();
    const facade = withPerformanceFacade(client);
    expect(facade).toBe(client);
    expect(typeof facade.startTransaction).toBe('function');
    expect(typeof facade.startSpan).toBe('function');
    expect(typeof facade.getActiveSpan).toBe('function');
  });

  it('is a harmless no-op while no performance extension is registered', () => {
    const client = withPerformanceFacade(createClient());
    const txn = client.startTransaction('Login', 'ui.load', { a: 1 });
    expect(txn.getName()).toBe('Login');
    expect(txn.isSampled()).toBe(false);
    expect(client.startSpan('db', 'q').getOperation()).toBe('db');
    expect(client.getActiveSpan()).toBeUndefined();
  });

  it('passes through to ext("performance") once it is registered, even after installation', () => {
    const client = withPerformanceFacade(createClient());
    const api = createPerformanceController({ clock, store: createTransactionStore() });
    client.registerExt('performance', api);
    const txn = client.startTransaction('Checkout', 'ui.load', { cart: 2 });
    expect(txn.isSampled()).toBe(true);
    expect(txn.getAttributes()).toMatchObject({ cart: 2 });
    expect(client.getActiveSpan()).toBe(txn);
    const child = client.startSpan('db.query', 'select');
    expect(child.getTraceId()).toBe(txn.getTraceId());
    expect(api.getActiveSpan()).toBe(txn);
  });

  it('is idempotent: a second install keeps the first methods', () => {
    const client = createClient();
    const first = withPerformanceFacade(client).startTransaction;
    expect(withPerformanceFacade(client).startTransaction).toBe(first);
  });
});
