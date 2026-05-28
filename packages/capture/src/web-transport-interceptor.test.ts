import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  createWebTransportInterceptor,
  type WebTransportInterceptorOptions,
  type WebTransportTarget,
} from './web-transport-interceptor';

type WTCtor = new (url: string, options?: unknown) => unknown;

// A fresh fake WebTransport class per call, with ready/closed promises the test resolves or rejects.
function makeWT() {
  return class FakeWT {
    url: string;
    readonly ready: Promise<void>;
    readonly closed: Promise<void>;
    resolveReady!: () => void;
    rejectReady!: (reason?: unknown) => void;
    resolveClosed!: () => void;
    rejectClosed!: (reason?: unknown) => void;
    constructor(url: string, _options?: unknown) {
      this.url = url;
      this.ready = new Promise<void>((res, rej) => {
        this.resolveReady = res;
        this.rejectReady = rej;
      });
      this.closed = new Promise<void>((res, rej) => {
        this.resolveClosed = res;
        this.rejectClosed = rej;
      });
    }
  };
}
type FakeWTInstance = InstanceType<ReturnType<typeof makeWT>>;

function setup(opts: Partial<WebTransportInterceptorOptions> = {}) {
  let current: WTCtor = makeWT() as unknown as WTCtor;
  const target: WebTransportTarget = {
    get: () => current as never,
    set: (ctor) => {
      current = ctor as unknown as WTCtor;
    },
  };
  const ic: Interceptor<Record<NetworkStage, NetworkEvent>> = createWebTransportInterceptor({
    now: () => 100,
    newId: () => 't1',
    target,
    ...opts,
  });
  const events: Array<[NetworkStage, NetworkEvent]> = [];
  ic.onAny((stage, event) => events.push([stage, event]));
  const open = (url: string) => new current(url) as unknown as FakeWTInstance;
  return { events, open };
}

describe('createWebTransportInterceptor — capture', () => {
  it('emits before on construct and open when ready resolves', async () => {
    const { events, open } = setup();
    const wt = open('https://wt/');
    expect(events.map(([s]) => s)).toEqual(['before']);
    expect(events[0]?.[1]).toMatchObject({
      id: 't1',
      mechanism: 'webtransport',
      url: 'https://wt/',
      method: 'CONNECT',
      type: 'before',
    });
    wt.resolveReady();
    await wt.ready;
    expect(events.map(([s]) => s)).toEqual(['before', 'open']);
  });

  it('emits error when ready rejects', async () => {
    const { events, open } = setup();
    const wt = open('https://wt/');
    wt.rejectReady(new Error('fail'));
    await wt.ready.catch(() => {});
    expect(events.map(([s]) => s)).toEqual(['before', 'error']);
    expect(events[1]?.[1]).toMatchObject({ type: 'error', customError: 'webtransport failed' });
  });

  it('emits close when closed resolves', async () => {
    const { events, open } = setup();
    const wt = open('https://wt/');
    wt.resolveClosed();
    await wt.closed;
    expect(events.map(([s]) => s)).toEqual(['before', 'close']);
    expect(events[1]?.[1]).toMatchObject({ type: 'close' });
    expect(events[1]?.[1].reason).toBeUndefined();
  });

  it('emits close with a reason when closed rejects', async () => {
    const { events, open } = setup();
    const wt = open('https://wt/');
    wt.rejectClosed(new Error('boom'));
    await wt.closed.catch(() => {});
    expect(events.map(([s]) => s)).toEqual(['before', 'close']);
    expect(events[1]?.[1]).toMatchObject({ type: 'close', reason: 'error' });
  });

  it('shares one id per session and increments per session (default counter)', async () => {
    const { events, open } = setup({ newId: undefined });
    const a = open('https://a/');
    a.resolveReady();
    await a.ready;
    a.resolveClosed();
    await a.closed;
    const b = open('https://b/');
    b.resolveReady();
    await b.ready;
    expect(events.map(([, e]) => e.id)).toEqual(['t1', 't1', 't1', 't2', 't2']);
  });

  it('uses the default clock (Date.now) when none is injected', () => {
    const { events, open } = setup({ now: undefined });
    open('https://wt/');
    expect(events[0]?.[1].timestamp).toBeGreaterThan(0);
  });
});

describe('createWebTransportInterceptor — activation', () => {
  it('is a safe no-op when the target has no WebTransport', () => {
    const ic = createWebTransportInterceptor({ target: { get: () => undefined, set: () => {} } });
    const off = ic.onAny(() => {});
    expect(() => off()).not.toThrow();
  });

  it('wraps and restores the global WebTransport when no target is given', () => {
    const slot = globalThis as unknown as { WebTransport?: unknown };
    const real = slot.WebTransport;
    const FakeWT = makeWT();
    slot.WebTransport = FakeWT;
    try {
      const ic = createWebTransportInterceptor();
      const off = ic.onAny(() => {});
      expect(slot.WebTransport).not.toBe(FakeWT);
      off();
      expect(slot.WebTransport).toBe(FakeWT);
    } finally {
      slot.WebTransport = real;
    }
  });
});
