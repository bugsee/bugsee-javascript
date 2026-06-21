import type {
  CaptureAggregator,
  CaptureDataEntry,
  CaptureProviderInit,
  OperationDispatcher,
  OptionsContainer,
} from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createPerformanceCaptureProvider } from './capture-provider';
import type { TransactionWire } from './span';

function fakeInit() {
  const entries: CaptureDataEntry[] = [];
  const aggregator: CaptureAggregator = {
    addEntry: (e) => void entries.push(e),
    addEntries: (es) => void entries.push(...es),
    clear: () => {
      entries.length = 0;
    },
  };
  const init = {
    operations: {} as OperationDispatcher,
    captureAggregator: aggregator,
  } satisfies CaptureProviderInit;
  return { init, entries };
}

const opts: OptionsContainer = { get: (_k, fallback) => fallback, has: () => false };

const wire = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: 't',
  name: 'n',
  operation: 'o',
  status: 'OK',
  sampled: true,
  startTimestampMs: 5,
  isSnapshot: false,
  spans: [],
  ...over,
});

describe('createPerformanceCaptureProvider', () => {
  it('is the `performance` provider gated by the monitoring option', () => {
    const p = createPerformanceCaptureProvider();
    expect(p.name).toBe('performance');
    expect(p.controllingOption).toBe('com.bugsee.option.performance.monitoring');
  });

  it('captures a recorded transaction as a `performance` entry once started', () => {
    const { init, entries } = fakeInit();
    const p = createPerformanceCaptureProvider();
    p.init(init);
    p.start(opts);
    p.record(wire({ startTimestampMs: 42, name: 'checkout' }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('performance');
    expect(entries[0]?.timestamp).toBe(42); // the transaction's start
    expect(entries[0]?.data).toMatchObject({ name: 'checkout' });
  });

  it('does NOT capture before start or after stop (the start/stop gate)', () => {
    const { init, entries } = fakeInit();
    const p = createPerformanceCaptureProvider();
    p.init(init);
    p.record(wire()); // before start → dropped
    p.start(opts);
    p.stop();
    p.record(wire()); // after stop → dropped
    expect(entries).toHaveLength(0);
  });
});
