import type { Clock } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createPerformanceController } from './controller';
import { serializeTransaction, type TransactionWire } from './span';
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

  it('continues an inbound trace — the transaction adopts the given trace id', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const inbound = '0123456789abcdef0123456789abcdef';
    const txn = api.startTransaction({
      name: 'GET /x',
      operation: 'http.server',
      continuation: { traceId: inbound },
    });
    expect(txn.getTraceId()).toBe(inbound);
  });

  it('continuation makes the root a CHILD of the inbound span and ADOPTS the upstream sampling (§12)', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      sampler: () => true, // local sampler says sample…
    });
    const txn = api.startTransaction({
      name: 'GET /x',
      operation: 'http.server',
      continuation: {
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        parentSpanId: 'bbbbbbbbbbbbbbbb',
        sampled: false,
      },
    });
    expect(txn.getTraceId()).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(serializeTransaction(txn).parentSpanId).toBe('bbbbbbbbbbbbbbbb'); // root is a child
    expect(txn.isSampled()).toBe(false); // …but the upstream UNSAMPLED decision wins
  });

  it('a traceId-only continuation (no sampled) falls back to the LOCAL sampler — not a hardcoded true', () => {
    const store = createTransactionStore();
    // The local sampler says DROP; the continuation supplies a trace id but no sampling decision, so the
    // local sampler must decide (controller.ts `continuation?.sampled ?? sampler()`).
    const api = createPerformanceController({ clock: fixedClock, store, sampler: () => false });
    const txn = api.startTransaction({
      name: 'GET /x',
      operation: 'http.server',
      continuation: { traceId: '0123456789abcdef0123456789abcdef' }, // traceId only, no `sampled`
    });
    expect(txn.getTraceId()).toBe('0123456789abcdef0123456789abcdef'); // trace id still adopted
    expect(txn.isSampled()).toBe(false); // the LOCAL sampler decided, not a hardcoded true
  });

  it('starts a fresh random trace id when there is no continuation', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const txn = api.startTransaction({ name: 'x', operation: 'op' });
    expect(txn.getTraceId()).toMatch(/^[0-9a-f]{32}$/);
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
    const finished: string[] = [];
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      sampler: () => false,
      onFinished: (wire) => finished.push(wire.name),
    });
    const txn = api.startTransaction({ name: 'T', operation: 'op' });
    expect(txn.isSampled()).toBe(false);
    txn.finish();
    expect(store.size()).toBe(0); // unsampled → not buffered
    expect(finished).toEqual([]); // …and not routed to the capture ring either
    expect(api.getActiveSpan()).toBeUndefined(); // still cleared as active
  });

  it('routes each SAMPLED finished transaction to onFinished (the capture ring), with the same wire', () => {
    const store = createTransactionStore();
    const finished: TransactionWire[] = [];
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      onFinished: (wire) => finished.push(wire),
    });
    api.startTransaction({ name: 'A', operation: 'op' }).finish('OK');
    api.startTransaction({ name: 'B', operation: 'op' }).finish('OK');
    // onFinished sees one wire per sampled finish, in order, identical to what the store buffered.
    expect(finished.map((w) => w.name)).toEqual(['A', 'B']);
    expect(store.drain()).toEqual(finished);
  });

  it('defaults to sampling everything when no sampler is injected', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    api.startTransaction({ name: 'T', operation: 'op' }).finish();
    expect(store.size()).toBe(1);
  });
});
