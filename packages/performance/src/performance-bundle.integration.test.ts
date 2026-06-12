import {
  assembleBundle,
  type BugseeClient,
  type BundleAssemblyContext,
  type CaptureProvider,
  type Clock,
  ClockToken,
  createCaptureAggregator,
  createCaptureExporter,
  createMemoryCaptureStore,
  createReportingRequest,
  type OperationDispatcher,
  type OptionsContainer,
} from '@bugsee/core';
import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import { createPerformanceCaptureProvider } from './capture-provider';
import { createPerformanceController } from './controller';
import { createPerformanceExtension } from './extension';
import type { TransactionWire } from './span';
import { createTransactionStore } from './transaction-store';

// Cross-package integration (standard #3): the FULL performance.json delivery path with NO fakes for the
// core pipeline — a real performance transaction is serialized, routed through the real capture provider →
// real aggregator → real memory CaptureStore (JSON serialize), read back through the real CaptureExporter
// (JSON deserialize), and assembled by the real bundle assembler. Asserts the §8.8 wire contract end to
// end, catching any drift between serializeTransaction and the assembler's `{ transactions: [...] }` wrap.

const clock: Clock = { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 };
const enabledOptions: OptionsContainer = { get: (_k, fallback) => fallback, has: () => false };
const env: EnvironmentEnvelope = {
  platform: { type: 'node', version: '20' },
  sdk: { version: '1.0.0', type: 'javascript' },
};
const context = (): BundleAssemblyContext => ({
  appToken: 'tok',
  environment: env,
  attributes: {},
  clock,
  fileName: () => 'f.bundle.zip',
});

describe('performance → capture ring → bundle (cross-package integration)', () => {
  it('delivers a finished transaction into performance.json as { transactions: [<real wire>] }', async () => {
    // Real core capture pipeline: memory store ← aggregator ← provider.
    const captureStore = createMemoryCaptureStore();
    const aggregator = createCaptureAggregator(captureStore);
    const provider = createPerformanceCaptureProvider();
    provider.init({ operations: {} as OperationDispatcher, captureAggregator: aggregator });
    provider.start(enabledOptions);

    // Real controller routes finished sampled transactions to the provider (the umbrella's onFinished).
    const api = createPerformanceController({
      clock,
      store: createTransactionStore(),
      appVersion: '9.9',
      onFinished: (wire) => provider.record(wire),
    });
    api.startTransaction({ name: 'Checkout', operation: 'ui.load' }).finish('OK');

    // Read it back through the real exporter (JSON round-trip) and assemble a real bundle.
    const drained = await createCaptureExporter(captureStore).drain();
    const bundle = assembleBundle(
      createReportingRequest({ source: { type: 'crash' }, id: 'r1' }),
      drained,
      context(),
    );

    const files = unzipSync(bundle.body);
    const perf = JSON.parse(strFromU8(files['performance.json'] as Uint8Array));
    expect(Object.keys(perf)).toEqual(['transactions']); // object-wrapped, NOT a bare array
    expect(perf.transactions).toHaveLength(1);
    expect(perf.transactions[0]).toMatchObject({
      name: 'Checkout',
      operation: 'ui.load',
      status: 'OK',
      appVersion: '9.9',
      isSnapshot: false,
    });
    expect(perf.transactions[0].traceId).toHaveLength(32); // 16-byte hex trace id (W3C)
    expect(Array.isArray(perf.transactions[0].spans)).toBe(true);
  });

  it('an EXTERNAL transaction (recordExternal — app.start / consumed OTel) also lands in performance.json', async () => {
    // Exercise the recordExternal path end-to-end through the REAL extension + a coordinator-faithful
    // client (addCaptureProvider inits + starts the provider against the real aggregator) — closing the
    // regression surface of the external-transaction fix all the way through to the assembled bundle.
    const captureStore = createMemoryCaptureStore();
    const aggregator = createCaptureAggregator(captureStore);
    const client = {
      getService: (token: unknown) => (token === ClockToken ? clock : undefined),
      registerExt: () => {},
      addCaptureProvider: (p: CaptureProvider) => {
        p.init({ operations: {} as OperationDispatcher, captureAggregator: aggregator });
        p.start(enabledOptions);
      },
    } as unknown as BugseeClient;
    const extension = createPerformanceExtension();
    extension.setup(client);

    const external: TransactionWire = {
      traceId: '0123456789abcdef0123456789abcdef',
      name: 'app.start',
      operation: 'startup',
      status: 'OK',
      startTimestampMs: 1_699_999_999_000,
      isSnapshot: false,
      spans: [],
    };
    extension.recordExternal(external);

    const drained = await createCaptureExporter(captureStore).drain();
    const bundle = assembleBundle(
      createReportingRequest({ source: { type: 'crash' }, id: 'r1' }),
      drained,
      context(),
    );
    const files = unzipSync(bundle.body);
    const perf = JSON.parse(strFromU8(files['performance.json'] as Uint8Array));
    expect(perf).toEqual({ transactions: [external] }); // wrapped, the exact external wire round-tripped
  });

  it('an UNSAMPLED transaction reaches neither the ring nor performance.json', async () => {
    const captureStore = createMemoryCaptureStore();
    const aggregator = createCaptureAggregator(captureStore);
    const provider = createPerformanceCaptureProvider();
    provider.init({ operations: {} as OperationDispatcher, captureAggregator: aggregator });
    provider.start(enabledOptions);
    const api = createPerformanceController({
      clock,
      store: createTransactionStore(),
      sampler: () => false,
      onFinished: (wire) => provider.record(wire),
    });
    api.startTransaction({ name: 'dropped', operation: 'op' }).finish('OK');

    const drained = await createCaptureExporter(captureStore).drain();
    const bundle = assembleBundle(
      createReportingRequest({ source: { type: 'crash' }, id: 'r1' }),
      drained,
      context(),
    );
    // No performance entries captured → no performance.json file in the bundle at all.
    expect('performance.json' in unzipSync(bundle.body)).toBe(false);
  });
});
