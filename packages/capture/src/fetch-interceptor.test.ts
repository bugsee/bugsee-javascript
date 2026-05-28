import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createFetchInterceptor, type FetchTarget } from './fetch-interceptor';

type FetchFn = (input: unknown, init?: unknown) => Promise<unknown>;
type Captured = { stage: NetworkStage; event: NetworkEvent };
type NetIc = Interceptor<Record<NetworkStage, NetworkEvent>>;

// A standalone fetch target (never touches the global): holds `current`, which the interceptor wraps
// on activate. `call` invokes whatever is currently installed (the wrapper once active).
function harness(impl: FetchFn) {
  let current: FetchFn = impl;
  const target: FetchTarget = {
    get: () => current,
    set: (fn) => {
      current = fn;
    },
  };
  return { target, call: (input: unknown, init?: unknown) => current(input, init), original: impl };
}

const okResponse = () => ({
  status: 200,
  statusText: 'OK',
  redirected: false,
  headers: {
    forEach: (cb: (v: string, k: string) => void) => cb('application/json', 'content-type'),
  },
});

// Subscribing (onAny) activates the interceptor (patches the target) and collects emitted events.
function collect(ic: NetIc): Captured[] {
  const events: Captured[] = [];
  ic.onAny((stage, event) => events.push({ stage, event }));
  return events;
}

describe('createFetchInterceptor — capture', () => {
  it('emits before then complete on a successful fetch (raw, unsanitized metadata)', async () => {
    const resp = okResponse();
    const { target, call } = harness(async () => resp);
    const ic = createFetchInterceptor({ now: () => 1000, newId: () => 'r1', target });
    const events = collect(ic);
    const result = await call('https://api/x', {
      method: 'post',
      headers: { authorization: 'secret' },
    });
    expect(result).toBe(resp); // response passed through unchanged
    expect(events.map((e) => e.stage)).toEqual(['before', 'complete']);
    expect(events[0]?.event).toMatchObject({
      id: 'r1',
      sequence: 'r1',
      mechanism: 'fetch',
      url: 'https://api/x',
      method: 'POST',
      type: 'before',
    });
    expect(events[0]?.event.custom?.headers).toEqual({ authorization: 'secret' }); // raw — not sanitized
    expect(events[1]?.event).toMatchObject({
      id: 'r1',
      type: 'complete',
      status: 200,
      statusText: 'OK',
      redirect: false,
    });
    expect(events[1]?.event.custom?.headers).toEqual({ 'content-type': 'application/json' });
    expect(events[1]?.event.custom?.timings?.duration).toBe(0); // fixed clock
  });

  it('emits before then error on a rejected fetch (and rethrows the error)', async () => {
    const { target, call } = harness(async () => {
      throw new Error('network down');
    });
    const ic = createFetchInterceptor({ now: () => 1, newId: () => 'r1', target });
    const events = collect(ic);
    await expect(call('https://api/x')).rejects.toThrow('network down');
    expect(events.map((e) => e.stage)).toEqual(['before', 'error']);
    expect(events[1]?.event).toMatchObject({ type: 'error', customError: 'network down' });
    expect(events[1]?.event.custom?.error).toBe('network down');
  });

  it('shares one id+sequence across a request and increments per request (default counter)', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ now: () => 0, target });
    const events = collect(ic);
    await call('a');
    await call('b');
    expect(events.map((e) => e.event.id)).toEqual(['f1', 'f1', 'f2', 'f2']);
    expect(events[0]?.event.sequence).toBe('f1');
  });
});

describe('createFetchInterceptor — self-isolation', () => {
  it('skips the SDK own requests (X-Bugsee-Internal) but still calls through', async () => {
    const resp = okResponse();
    let called = 0;
    const { target, call } = harness(async () => {
      called += 1;
      return resp;
    });
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    const result = await call('https://api/x', { headers: { 'X-Bugsee-Internal': '1' } });
    expect(result).toBe(resp);
    expect(called).toBe(1);
    expect(events).toEqual([]);
  });

  it('honors a custom isInternal predicate', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target, isInternal: (url) => url.includes('/skip') });
    const events = collect(ic);
    await call('https://api/skip');
    await call('https://api/keep');
    expect(events.map((e) => e.event.url)).toEqual(['https://api/keep', 'https://api/keep']);
  });
});

describe('createFetchInterceptor — request shape extraction', () => {
  it('extracts url + method + array headers from a Request-like input', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call({ url: 'https://r/path', method: 'put', headers: [['x-test', '1']] });
    expect(events[0]?.event.url).toBe('https://r/path');
    expect(events[0]?.event.method).toBe('PUT');
    expect(events[0]?.event.custom?.headers).toEqual({ 'x-test': '1' });
  });

  it('reads the url from a URL-like input (href) and defaults the method to GET', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call({ href: 'https://u/' });
    expect(events[0]?.event.url).toBe('https://u/');
    expect(events[0]?.event.method).toBe('GET');
  });

  it('stringifies a non-string, non-Request input as the url', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call(123 as unknown);
    expect(events[0]?.event.url).toBe('123');
  });
});

describe('createFetchInterceptor — default global target', () => {
  it('wraps globalThis.fetch when no target is given', async () => {
    const slot = globalThis as unknown as { fetch?: FetchFn };
    const real = slot.fetch;
    const resp = okResponse();
    slot.fetch = async () => resp;
    try {
      const ic = createFetchInterceptor({ now: () => 0, newId: () => 'g' });
      const events = collect(ic); // activates → wraps globalThis.fetch
      const result = await (slot.fetch as FetchFn)('https://g/');
      expect(result).toBe(resp);
      expect(events.map((e) => e.stage)).toEqual(['before', 'complete']);
      expect(events[0]?.event.url).toBe('https://g/');
    } finally {
      slot.fetch = real;
    }
  });
});

describe('createFetchInterceptor — activation', () => {
  it('wraps the target fetch on activate and restores it on the last unsubscribe', () => {
    const impl: FetchFn = async () => okResponse();
    const { target } = harness(impl);
    const ic = createFetchInterceptor({ target });
    const off = ic.onAny(() => {});
    expect(target.get()).not.toBe(impl); // wrapped while active
    off();
    expect(target.get()).toBe(impl); // restored when idle
  });

  it('is a safe no-op when the target has no fetch to wrap', () => {
    const target: FetchTarget = {
      get: () => undefined,
      set: () => {
        throw new Error('must not install a wrapper when there is no fetch');
      },
    };
    const ic = createFetchInterceptor({ target });
    expect(() => ic.onAny(() => {})).not.toThrow();
  });
});
