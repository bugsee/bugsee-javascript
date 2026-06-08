import { type BugseeClient, type Clock, ClockToken } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import type { PerformanceApi } from './controller';
import { createPerformanceExtension } from './extension';
import { createTransactionStore } from './transaction-store';

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

function fakeClient() {
  const registered = new Map<string, unknown>();
  const client = {
    getService: (token: unknown) => (token === ClockToken ? fixedClock : undefined),
    registerExt: (name: string, api: unknown) => registered.set(name, api),
  } as unknown as BugseeClient;
  return { client, registered, ext: () => registered.get('performance') as PerformanceApi };
}

describe('createPerformanceExtension', () => {
  it('is named "performance", owns a store, and has a callable no-op stop()', () => {
    const extension = createPerformanceExtension();
    expect(extension.name).toBe('performance');
    expect(extension.store.size()).toBe(0);
    expect(() => extension.stop()).not.toThrow();
  });

  it('setup registers a working ext("performance") API backed by the extension store + injected clock', () => {
    const extension = createPerformanceExtension();
    const { client, registered, ext } = fakeClient();
    extension.setup(client);
    expect(registered.has('performance')).toBe(true);
    const txn = ext().startTransaction({ name: 'T', operation: 'op' });
    expect(ext().getActiveSpan()).toBe(txn);
    txn.finish('OK');
    // the finished transaction lands in the extension's own store
    expect(extension.store.drain()).toHaveLength(1);
  });

  it('stamps transactions with the configured app version/build', () => {
    const extension = createPerformanceExtension({ appVersion: '2.0', appBuild: 'b9' });
    const { client, ext } = fakeClient();
    extension.setup(client);
    ext().startTransaction({ name: 'T', operation: 'op' }).finish();
    expect(extension.store.drain()[0]).toMatchObject({ appVersion: '2.0', appBuild: 'b9' });
  });

  it('applies the injected sampler (head sampling)', () => {
    const extension = createPerformanceExtension({ sampler: () => false });
    const { client, ext } = fakeClient();
    extension.setup(client);
    const txn = ext().startTransaction({ name: 'T', operation: 'op' });
    expect(txn.isSampled()).toBe(false);
    txn.finish();
    expect(extension.store.size()).toBe(0); // unsampled → not buffered
  });

  it('uses an injected store when provided (so the launch can wire its drains)', () => {
    const store = createTransactionStore();
    const extension = createPerformanceExtension({ store });
    expect(extension.store).toBe(store);
    const { client, ext } = fakeClient();
    extension.setup(client);
    ext().startTransaction({ name: 'T', operation: 'op' }).finish();
    expect(store.size()).toBe(1);
  });

  it('honours maxTransactions on its default store', () => {
    const extension = createPerformanceExtension({ maxTransactions: 1 });
    const { client, ext } = fakeClient();
    extension.setup(client);
    ext().startTransaction({ name: 'a', operation: 'op' }).finish();
    ext().startTransaction({ name: 'b', operation: 'op' }).finish();
    expect(extension.store.size()).toBe(1); // bounded to 1 → only the newest kept
    expect(extension.store.drain()[0]).toMatchObject({ name: 'b' });
  });
});
