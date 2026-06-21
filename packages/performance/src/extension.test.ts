import {
  type BugseeClient,
  type CaptureAggregator,
  type CaptureDataEntry,
  type CaptureProvider,
  type Clock,
  ClockToken,
  type OperationDispatcher,
  type OptionsContainer,
} from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import type { PerformanceApi } from './controller';
import { createPerformanceExtension } from './extension';
import type { TransactionWire } from './span';
import { createTransactionStore } from './transaction-store';

const externalWire = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: 'ext',
  name: 'app.start',
  operation: 'startup',
  status: 'OK',
  sampled: true,
  startTimestampMs: 7,
  isSnapshot: false,
  spans: [],
  ...over,
});

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };
const enabledOptions: OptionsContainer = { get: (_k, fallback) => fallback, has: () => false };

function fakeClient() {
  const registered = new Map<string, unknown>();
  const providers: CaptureProvider[] = [];
  const captured: CaptureDataEntry[] = [];
  const aggregator: CaptureAggregator = {
    addEntry: (e) => void captured.push(e),
    addEntries: (es) => void captured.push(...es),
    clear: () => {
      captured.length = 0;
    },
  };
  const client = {
    getService: (token: unknown) => (token === ClockToken ? fixedClock : undefined),
    registerExt: (name: string, api: unknown) => registered.set(name, api),
    // Mirror the capture coordinator's post-launch path: an added provider is init'd + started now.
    addCaptureProvider: (p: CaptureProvider) => {
      providers.push(p);
      p.init({ operations: {} as OperationDispatcher, captureAggregator: aggregator });
      p.start(enabledOptions);
    },
  } as unknown as BugseeClient;
  return {
    client,
    registered,
    providers,
    captured,
    ext: () => registered.get('performance') as PerformanceApi,
  };
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

  it('adds a `performance` capture provider that routes finished transactions into the capture ring', () => {
    const extension = createPerformanceExtension();
    const { client, providers, captured, ext } = fakeClient();
    extension.setup(client);
    expect(providers.map((p) => p.name)).toContain('performance');
    ext().startTransaction({ name: 'ring', operation: 'op' }).finish('OK');
    // The same finished transaction reaches BOTH the store (continuous upload) and the capture ring.
    expect(extension.store.drain()).toHaveLength(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe('performance');
    expect(captured[0]?.data).toMatchObject({ name: 'ring' });
  });

  it('recordExternal dual-writes an externally-finished transaction to BOTH the store and the capture ring', () => {
    const extension = createPerformanceExtension();
    const { client, captured } = fakeClient();
    extension.setup(client);
    const wire = externalWire({ name: 'consumed-otel' });
    extension.recordExternal(wire);
    // continuous /v2 upload buffer …
    expect(extension.store.drain()).toEqual([wire]);
    // … AND the incident-bundle capture ring (so app.start / consumed OTel reach performance.json too).
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe('performance');
    expect(captured[0]?.data).toBe(wire);
    expect(captured[0]?.timestamp).toBe(7); // the transaction's start
  });

  it('recordExternal before setup buffers to the store only (no provider yet — safe no-op on the ring)', () => {
    const extension = createPerformanceExtension();
    expect(() => extension.recordExternal(externalWire())).not.toThrow();
    expect(extension.store.size()).toBe(1);
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
