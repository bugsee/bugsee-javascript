import type { Clock } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createPerformanceController } from './controller';
import { createNoopTransaction, createPerformanceFacade } from './facade';
import { createTransactionStore } from './transaction-store';

const clock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };
const realApi = () => createPerformanceController({ clock, store: createTransactionStore() });

describe('createNoopTransaction', () => {
  it('is a harmless, never-sampled transaction that reports what it was asked to', () => {
    const t = createNoopTransaction('Login', 'ui.load', 'desc');
    expect(t.getName()).toBe('Login');
    expect(t.getOperation()).toBe('ui.load');
    expect(t.getDescription()).toBe('desc');
    expect(t.isSampled()).toBe(false);
    expect(t.getStatus()).toBe('UNKNOWN');
    expect(t.getSpanId()).toBe('');
    expect(t.getTraceId()).toBe('');
    expect(t.getAttributes()).toEqual({});
    expect(t.isFinished()).toBe(false);
  });

  it('accepts every mutation without effect and chains the fluent setters', () => {
    const t = createNoopTransaction('n', 'op');
    expect(t.setName('x')).toBe(t);
    expect(t.setDescription('d')).toBe(t);
    expect(t.setAttribute('k', 1)).toBe(t);
    expect(t.setStatus('ERROR')).toBe(t);
    expect(t.getName()).toBe('n');
    expect(t.getDescription()).toBeUndefined();
    expect(t.getAttributes()).toEqual({});
    expect(t.getStatus()).toBe('UNKNOWN');
    t.recordChildSpan('child', { startTimestampMs: 1, endTimestampMs: 2 });
    const child = t.startChildSpan('db', 'q');
    expect(child.getOperation()).toBe('db');
    expect(child.getDescription()).toBe('q');
    expect(child.isFinished()).toBe(false);
    expect(child.setName('y')).toBe(child);
    expect(child.setDescription('y')).toBe(child);
    expect(child.setAttribute('a', 1)).toBe(child);
    expect(child.setStatus('OK')).toBe(child);
    expect(child.getSpanId()).toBe('');
    child.finish();
    t.finish('OK');
    expect(t.isFinished()).toBe(true);
    expect(child.isFinished()).toBe(true);
  });
});

describe('createPerformanceFacade (performance disabled / not wired)', () => {
  const facade = createPerformanceFacade(() => undefined);

  it('startTransaction returns a no-op transaction carrying name and operation', () => {
    const t = facade.startTransaction('Checkout', 'ui.load', { a: 1 });
    expect(t.getName()).toBe('Checkout');
    expect(t.getOperation()).toBe('ui.load');
    expect(t.isSampled()).toBe(false);
  });

  it('startSpan returns a no-op span and getActiveSpan is undefined', () => {
    const s = facade.startSpan('db.query', 'select');
    expect(s.getOperation()).toBe('db.query');
    expect(s.getDescription()).toBe('select');
    expect(facade.getActiveSpan()).toBeUndefined();
  });
});

describe('createPerformanceFacade (performance wired)', () => {
  it('startTransaction starts a real transaction and applies the initial attributes', () => {
    const api = realApi();
    const facade = createPerformanceFacade(() => api);
    const t = facade.startTransaction('Checkout', 'ui.load', { cart: 3, vip: true });
    expect(t.getName()).toBe('Checkout');
    expect(t.getOperation()).toBe('ui.load');
    expect(t.isSampled()).toBe(true);
    expect(t.getSpanId()).not.toBe('');
    expect(t.getAttributes()).toMatchObject({ cart: 3, vip: true });
    expect(facade.getActiveSpan()).toBe(t);
  });

  it('startTransaction without attributes sets none', () => {
    const facade = createPerformanceFacade(() => realApi());
    expect(Object.keys(facade.startTransaction('n', 'op').getAttributes())).not.toContain('cart');
  });

  it('startSpan nests under the active span, sharing its trace', () => {
    const api = realApi();
    const facade = createPerformanceFacade(() => api);
    const t = facade.startTransaction('n', 'op');
    const s = facade.startSpan('db.query', 'select 1');
    expect(s.getTraceId()).toBe(t.getTraceId());
    expect(s.getSpanId()).not.toBe(t.getSpanId());
    expect(s.getOperation()).toBe('db.query');
    expect(s.getDescription()).toBe('select 1');
  });

  it('startSpan with no active span opens a root transaction rather than dropping the work', () => {
    const api = realApi();
    const facade = createPerformanceFacade(() => api);
    const s = facade.startSpan('job', 'nightly');
    expect(s.getOperation()).toBe('job');
    expect(s.getDescription()).toBe('nightly');
    expect((s as unknown as { getName(): string }).getName()).toBe('nightly');
    expect(facade.getActiveSpan()).toBe(s);
  });

  it('startSpan with no active span and no description names the transaction after the operation', () => {
    const api = realApi();
    const facade = createPerformanceFacade(() => api);
    const s = facade.startSpan('job');
    expect((s as unknown as { getName(): string }).getName()).toBe('job');
    expect(s.getDescription()).toBeUndefined();
  });

  it('resolves the API lazily on every call', () => {
    let api: ReturnType<typeof realApi> | undefined;
    const facade = createPerformanceFacade(() => api);
    expect(facade.startTransaction('a', 'op').isSampled()).toBe(false);
    api = realApi();
    expect(facade.startTransaction('a', 'op').isSampled()).toBe(true);
  });
});
