import {
  type BugseeClient,
  type CaptureAggregator,
  type CaptureDataEntry,
  type CaptureProvider,
  type Clock,
  ClockToken,
  createFilterStore,
  type FilterStore,
  FiltersToken,
  type OperationDispatcher,
  type OptionsContainer,
} from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceApi } from './controller';
import { createPerformanceExtension } from './extension';
import type { TransactionWire } from './span';
import { createTransactionStore } from './transaction-store';

const externalWire = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: 'ext',
  spanId: 's0',
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

function fakeClient(filters?: FilterStore) {
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
    getService: (token: unknown) =>
      token === ClockToken ? fixedClock : token === FiltersToken ? filters : undefined,
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

describe('createPerformanceExtension — the span filter reaches CONSUMED spans', () => {
  it('scrubs a consumed OTel span attribute before either sink sees it', () => {
    // The whole point of the seam. `recordExternal` is the path a consumed OpenTelemetry span takes, and
    // `@opentelemetry/instrumentation-pg` puts the executed SQL — literals included — on `db.statement`.
    // Before this, every attribute went through verbatim with no way to reach it.
    const filters = createFilterStore(() => {});
    filters.span = (span) =>
      span.attributes?.['db.statement'] === undefined
        ? span
        : { ...span, attributes: { ...span.attributes, 'db.statement': '<redacted>' } };
    const { client, captured } = fakeClient(filters);
    const extension = createPerformanceExtension();
    extension.setup(client as unknown as BugseeClient);
    extension.recordExternal({
      traceId: 't',
      spanId: 's',
      name: 'pg.query',
      operation: 'db',
      status: 'OK',
      sampled: true,
      startTimestampMs: 1,
      endTimestampMs: 2,
      isSnapshot: false,
      attributes: { 'db.statement': "SELECT * FROM users WHERE email = 'a@b.com'" },
      spans: [],
    });
    // BOTH sinks: the continuous-upload store …
    expect(extension.store.drain()[0]?.attributes?.['db.statement']).toBe('<redacted>');
    // … and the incident-bundle capture ring, which is a separate write.
    expect(JSON.stringify(captured)).toContain('<redacted>');
    expect(JSON.stringify(captured)).not.toContain('a@b.com');
  });

  it('drops a consumed span whose filter THREW, and reports it once', () => {
    // Same rule as every other filter: a filter that threw cannot be assumed to have scrubbed anything,
    // so the span is dropped rather than shipped with whatever it was meant to remove still on it.
    const onError = vi.fn();
    const filters = createFilterStore(onError);
    filters.span = () => {
      throw new Error('bad filter');
    };
    const { client, captured } = fakeClient(filters);
    const extension = createPerformanceExtension();
    extension.setup(client as unknown as BugseeClient);
    extension.recordExternal({
      traceId: 't',
      spanId: 's',
      name: 'pg.query',
      operation: 'db',
      status: 'OK',
      sampled: true,
      startTimestampMs: 1,
      isSnapshot: false,
      attributes: { 'db.statement': 'SELECT 1' },
      spans: [],
    });
    expect(extension.store.drain()).toEqual([]);
    expect(captured).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('drops a consumed span the filter rejects, from both sinks', () => {
    const filters = createFilterStore(() => {});
    filters.span = () => null;
    const { client, captured } = fakeClient(filters);
    const extension = createPerformanceExtension();
    extension.setup(client as unknown as BugseeClient);
    extension.recordExternal({
      traceId: 't',
      spanId: 's',
      name: 'pg.query',
      operation: 'db',
      status: 'OK',
      sampled: true,
      startTimestampMs: 1,
      isSnapshot: false,
      spans: [],
    });
    expect(extension.store.drain()).toEqual([]);
    expect(captured).toEqual([]);
  });
});
