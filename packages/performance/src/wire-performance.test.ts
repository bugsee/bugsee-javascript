import { type BugseeClient, type Clock, ClockToken, type Scheduler } from '@bugsee/core';
import type { NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceApi } from './controller';
import type { NetworkSource } from './http-spans';
import { serializeTransaction, type Transaction } from './span';
import type { WebVitalsEnv } from './web-vitals/env';
import { type WirePerformanceOptions, wirePerformance } from './wire-performance';

const netEvent = (over: Partial<NetworkEvent>): NetworkEvent =>
  ({
    timestamp: 0,
    id: '',
    sequence: '',
    mechanism: 'fetch',
    url: '',
    method: 'GET',
    type: 'before',
    ...over,
  }) as NetworkEvent;

function fakeNetworkSource() {
  const listeners = new Map<string, Set<(e: NetworkEvent) => void>>();
  const source = {
    on: (name: string, fn: (e: NetworkEvent) => void) => {
      (listeners.get(name) ?? listeners.set(name, new Set()).get(name))?.add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    onAny: () => () => {},
  } as unknown as NetworkSource;
  const emit = (name: string, e: NetworkEvent) => {
    for (const l of listeners.get(name) ?? []) l(e);
  };
  return { source, emit };
}

const clock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

function fakeClient() {
  const registry = new Map<string, unknown>();
  const client = {
    getService: (token: unknown) => (token === ClockToken ? clock : undefined),
    registerExt: (name: string, api: unknown) => registry.set(name, api),
    ext: (name: string) => registry.get(name),
  } as unknown as BugseeClient;
  return { client, perf: () => registry.get('performance') as PerformanceApi | undefined };
}

function fakeScheduler() {
  const scheduled: { ms: number }[] = [];
  const cleared: unknown[] = [];
  const scheduler: Scheduler = {
    setInterval: (_cb, ms) => {
      scheduled.push({ ms });
      return 'h';
    },
    clearInterval: (h) => cleared.push(h),
  };
  return { scheduler, scheduled, cleared };
}

const base = (over: Partial<WirePerformanceOptions> = {}): WirePerformanceOptions => ({
  client: fakeClient().client,
  pageName: '/checkout',
  send: vi.fn(async () => {}),
  scheduler: fakeScheduler().scheduler,
  monitoring: true,
  sampleRate: 1,
  flushIntervalMs: 30_000,
  env: {} as WebVitalsEnv, // no observers/DOM → vitals no-op, but the pageload transaction still starts
  ...over,
});

describe('wirePerformance', () => {
  it('does nothing when monitoring is off', () => {
    const { client, perf } = fakeClient();
    const { scheduler, scheduled } = fakeScheduler();
    expect(wirePerformance(base({ client, scheduler, monitoring: false }))).toBeUndefined();
    expect(perf()).toBeUndefined(); // ext not registered
    expect(scheduled).toHaveLength(0); // uploader not started
  });

  it('registers ext(performance), starts a pageload transaction, and starts the uploader', () => {
    const { client, perf } = fakeClient();
    const { scheduler, scheduled } = fakeScheduler();
    const wired = wirePerformance(base({ client, scheduler, flushIntervalMs: 5000 }));
    expect(wired).toBeDefined();
    expect(perf()).toBeDefined();
    expect(perf()?.getActiveSpan()).toBeDefined(); // pageload transaction is active
    expect(scheduled).toEqual([{ ms: 5000 }]); // uploader started at the interval
  });

  it('builds the head sampler from sampleRate (0 → the pageload transaction is unsampled)', () => {
    const { client, perf } = fakeClient();
    wirePerformance(base({ client, sampleRate: 0 }));
    expect((perf()?.getActiveSpan() as Transaction).isSampled()).toBe(false);
  });

  it('wires http spans onto the active pageload transaction when a network source is provided', () => {
    const { client, perf } = fakeClient();
    const { source, emit } = fakeNetworkSource();
    wirePerformance(base({ client, networkSource: source }));
    emit('before', netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'https://x/a' }));
    emit('complete', netEvent({ id: 'r1', timestamp: 50, status: 200 }));
    const wire = serializeTransaction(perf()?.getActiveSpan() as Transaction);
    expect(wire.spans.some((s) => s.operation === 'http.client')).toBe(true);
  });

  it('defaults to the real web-vitals env when none is injected', () => {
    const { client, perf } = fakeClient();
    const options = base({ client });
    options.env = undefined;
    expect(() => wirePerformance(options)).not.toThrow();
    expect(perf()?.getActiveSpan()).toBeDefined(); // pageload transaction still started
  });

  it('stop() tears down the uploader interval and unsubscribes http spans', () => {
    const { scheduler, cleared } = fakeScheduler();
    const unsubscribed: string[] = [];
    const networkSource = {
      on: (name: string) => () => unsubscribed.push(name),
      onAny: () => () => {},
    } as unknown as NetworkSource;
    const wired = wirePerformance(base({ scheduler, networkSource }));
    wired?.stop();
    expect(cleared).toHaveLength(1); // uploader interval cleared
    expect(unsubscribed).toContain('before'); // http listeners removed
  });
});
