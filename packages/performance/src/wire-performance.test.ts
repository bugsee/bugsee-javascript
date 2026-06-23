import { type BugseeClient, type Clock, ClockToken, type Scheduler } from '@bugsee/core';
import type { NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceApi } from './controller';
import type { NetworkSource } from './http-spans';
import type { InteractionDetailLike, InteractionSource } from './interactions';
import type { NavigationDetailLike, NavigationSource } from './navigations';
import { serializeTransaction, type Transaction, type TransactionWire } from './span';
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

function fakeNavSource() {
  const listeners = new Set<(d: NavigationDetailLike) => void>();
  const source = {
    on: (_n: string, fn: (d: NavigationDetailLike) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAny: () => () => {},
  } as unknown as NavigationSource;
  const emit = (d: NavigationDetailLike) => {
    for (const l of listeners) l(d);
  };
  return { source, emit };
}

function fakeInteractionSource() {
  const listeners = new Set<(d: InteractionDetailLike) => void>();
  const source = {
    on: (_n: string, fn: (d: InteractionDetailLike) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAny: () => () => {},
  } as unknown as InteractionSource;
  const emit = (d: InteractionDetailLike) => {
    for (const l of listeners) l(d);
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
    addCaptureProvider: () => {}, // the perf provider is unused by these uploader/http-span tests
  } as unknown as BugseeClient;
  return { client, perf: () => registry.get('performance') as PerformanceApi | undefined };
}

function fakeScheduler() {
  const scheduled: { ms: number }[] = [];
  const cleared: unknown[] = [];
  let cb: (() => void) | undefined;
  const scheduler: Scheduler = {
    setInterval: (fn, ms) => {
      scheduled.push({ ms });
      cb = fn as () => void;
      return 'h';
    },
    clearInterval: (h) => cleared.push(h),
  };
  // Fire the captured interval callback (the uploader's flush tick) and let its async flush settle.
  const fire = async () => {
    cb?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { scheduler, scheduled, cleared, fire };
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

  it('skips the pageload transaction when pageload is false (Node — no pageload lifecycle)', () => {
    const { client, perf } = fakeClient();
    const wired = wirePerformance(base({ client, pageload: false }));
    expect(wired).toBeDefined();
    expect(perf()).toBeDefined(); // the extension is still registered (store/controller/uploader)
    expect(perf()?.getActiveSpan()).toBeUndefined(); // but NO pageload transaction was started
  });

  it('recordTransaction buffers an external (already-finished) transaction into the uploader', async () => {
    const { client } = fakeClient();
    const { scheduler, fire } = fakeScheduler();
    const send = vi.fn(async () => {});
    const wired = wirePerformance(base({ client, scheduler, send, flushIntervalMs: 5000 }));
    const wire = {
      traceId: 't',
      name: 'consumed',
      operation: 'consumed',
      status: 'OK',
      sampled: true,
      startTimestampMs: 1,
      isSnapshot: false,
      spans: [],
    } as TransactionWire;
    wired?.recordTransaction(wire);
    await fire(); // run the uploader's flush tick
    expect(send).toHaveBeenCalledWith([wire]); // it rode the uploader to `send`, unsampled
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

  it('wires http spans onto the active transaction + reads the backend span from traceresponse (F3)', () => {
    const { client, perf } = fakeClient();
    const { source, emit } = fakeNetworkSource();
    wirePerformance(base({ client, networkSource: source }));
    emit('before', netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'https://x/a' }));
    emit(
      'complete',
      netEvent({
        id: 'r1',
        timestamp: 50,
        status: 200,
        custom: {
          headers: { traceresponse: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
        },
      } as Partial<NetworkEvent>),
    );
    const wire = serializeTransaction(perf()?.getActiveSpan() as Transaction);
    const httpSpan = wire.spans.find((s) => s.operation === 'http.client');
    expect(httpSpan).toBeDefined();
    // F3: the FE client span records WHICH backend http.server span handled it (read off the return header).
    expect(httpSpan?.attributes?.['bugsee.server_span_id']).toBe('b7ad6b7169203331');
  });

  it('opens a `navigation` transaction from the navigation source, stamped + idle-managed (F1c)', () => {
    vi.useFakeTimers();
    try {
      const { client, perf } = fakeClient();
      const nav = fakeNavSource();
      const net = fakeNetworkSource();
      // pageload:false so the active span IS the navigation transaction (no overlapping pageload).
      const wired = wirePerformance(
        base({ client, navigationSource: nav.source, networkSource: net.source, pageload: false }),
      );
      nav.emit({ to: '/users/42', navigationType: 'push', source: 'url' });
      const active = perf()?.getActiveSpan() as Transaction;
      expect(active.getOperation()).toBe('navigation');
      expect(active.getName()).toBe('/users/42');
      expect(active.getAttributes()['nav.source']).toBe('url');
      expect(active.getAttributes()['nav.type']).toBe('push');
      // The networkSource is forwarded into collectNavigations: in-flight activity keeps the navigation alive
      // PAST its idle timeout (defaults 1000ms). Advance near the timeout, fire a request, advance past the
      // ORIGINAL deadline — the nav must still be active (the keepAlive reset it).
      vi.advanceTimersByTime(900);
      net.emit('before', netEvent({ id: 'r1', timestamp: 0, method: 'GET', url: 'https://x/a' }));
      vi.advanceTimersByTime(200); // 1100ms total > the 1000ms idle, but reset at 900 → not yet idle
      expect(perf()?.getActiveSpan()).toBe(active); // still active — undefined here if networkSource weren't forwarded
      wired?.stop(); // tears down the navigation wiring (offNav) without error
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a `ui.interaction` transaction from the interaction source, idle-managed (F4)', () => {
    vi.useFakeTimers();
    try {
      const { client, perf } = fakeClient();
      const interactions = fakeInteractionSource();
      const net = fakeNetworkSource();
      // pageload:false so the active span IS the interaction transaction (no overlapping pageload).
      const wired = wirePerformance(
        base({
          client,
          interactionSource: interactions.source,
          networkSource: net.source,
          pageload: false,
        }),
      );
      interactions.emit({
        interactionType: 'click',
        target: 'button#go',
        duration: 90,
        interactionId: 3,
      });
      const active = perf()?.getActiveSpan() as Transaction;
      expect(active.getOperation()).toBe('ui.interaction');
      expect(active.getName()).toBe('click button#go');
      expect(active.getAttributes()['ui.interaction_type']).toBe('click');
      // The networkSource is forwarded: in-flight activity keeps the interaction alive past its idle timeout.
      vi.advanceTimersByTime(900);
      net.emit('before', netEvent({ id: 'r1', timestamp: 0, method: 'GET', url: 'https://x/a' }));
      vi.advanceTimersByTime(200); // 1100ms total > 1000ms idle, but reset at 900 → not yet idle
      expect(perf()?.getActiveSpan()).toBe(active); // still active — undefined here if not forwarded
      wired?.stop(); // tears down the interaction wiring (offInteractions) without error
    } finally {
      vi.useRealTimers();
    }
  });

  it('two-phase naming (F5/D5): a navigation starts raw-URL, then setRouteName refines the active txn', () => {
    vi.useFakeTimers();
    try {
      const { client, perf } = fakeClient();
      const nav = fakeNavSource();
      const wired = wirePerformance(
        base({ client, navigationSource: nav.source, pageload: false }),
      );
      nav.emit({ to: '/users/42', navigationType: 'push', source: 'url' }); // phase 1: raw URL
      expect((perf()?.getActiveSpan() as Transaction).getName()).toBe('/users/42');
      perf()?.setRouteName('/users/:id'); // phase 2: a router adapter resolves the route
      const active = perf()?.getActiveSpan() as Transaction;
      expect(active.getName()).toBe('/users/:id'); // the in-flight navigation was refined in place
      expect(active.getAttributes()['bugsee.name_source']).toBe('route');
      expect(active.getAttributes()['nav.source']).toBe('url'); // detection provenance is untouched
      wired?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues a server-injected trace on the pageload from pageloadContinuation (F2/D4)', () => {
    const { client, perf } = fakeClient();
    wirePerformance(
      base({
        client,
        pageloadContinuation: {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          parentSpanId: 'b7ad6b7169203331',
          sampled: true,
        },
      }),
    );
    const active = perf()?.getActiveSpan() as Transaction;
    expect(active.getTraceId()).toBe('0af7651916cd43dd8448eb211c80319c'); // adopted the server trace id
    expect(serializeTransaction(active).parentSpanId).toBe('b7ad6b7169203331'); // pageload is a child of the server span
  });

  it('threads appVersion/appBuild onto the pageload transaction wire', () => {
    const { client, perf } = fakeClient();
    wirePerformance(base({ client, appVersion: '1.2.3', appBuild: '456' }));
    const wire = serializeTransaction(perf()?.getActiveSpan() as Transaction);
    expect(wire.appVersion).toBe('1.2.3');
    expect(wire.appBuild).toBe('456');
  });

  it('forwards onError to the uploader so a send rejection is routed to the caller', async () => {
    const { client, perf } = fakeClient();
    const { scheduler, fire } = fakeScheduler();
    const onError = vi.fn();
    const boom = new Error('boom');
    const send = vi.fn(async () => {
      throw boom;
    });
    wirePerformance(base({ client, scheduler, send, onError }));
    (perf()?.getActiveSpan() as Transaction).finish(); // buffer the sampled pageload transaction
    await fire(); // drive the uploader's flush tick → send rejects
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
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
