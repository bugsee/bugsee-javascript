import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSendBeaconInterceptor,
  type SendBeaconInterceptorOptions,
  type SendBeaconTarget,
} from './send-beacon-interceptor';

type BeaconFn = (url: unknown, data?: unknown) => boolean;

// This package carries no DOM lib types, so the payload globals the tests build are reached through a
// cast — the same technique the sibling suites use for TextEncoder / ReadableStream.
const web = globalThis as unknown as {
  URLSearchParams: new (init?: Record<string, string>) => object;
  Blob: new (parts: unknown[], options?: { type: string }) => object;
  FormData: new () => object;
  URL: new (href: string) => object;
};

// A fake navigator-like host per test: the interceptor swaps `nav.sendBeacon`, so calling
// `nav.sendBeacon(...)` exercises the wrapper exactly as an application would (`this` = the host).
function setup(opts: Partial<SendBeaconInterceptorOptions> = {}, inner?: BeaconFn) {
  const calls: Array<{ self: unknown; url: unknown; data: unknown }> = [];
  const impl = inner ?? ((): boolean => true);
  const nav = {
    sendBeacon: function (this: unknown, url: unknown, data?: unknown): boolean {
      calls.push({ self: this, url, data });
      return impl.call(this, url, data);
    } as BeaconFn,
  };
  const original = nav.sendBeacon;
  const target: SendBeaconTarget = {
    get: () => nav.sendBeacon,
    set: (fn) => {
      nav.sendBeacon = fn;
    },
  };
  const ic: Interceptor<Record<NetworkStage, NetworkEvent>> = createSendBeaconInterceptor({
    now: () => 100,
    newId: () => 'b1',
    target,
    ...opts,
  });
  const events: Array<[NetworkStage, NetworkEvent]> = [];
  ic.onAny((stage, event) => events.push([stage, event])); // activate → wraps nav.sendBeacon
  const send = (url: unknown, data?: unknown): boolean => nav.sendBeacon(url, data);
  return { nav, original, target, ic, events, calls, send };
}

describe('createSendBeaconInterceptor — capture', () => {
  it('emits before → complete for a string beacon (POST, implied text/plain, body captured)', () => {
    const { events, send } = setup();
    expect(send('https://api/collect', 'payload')).toBe(true);
    expect(events.map(([stage]) => stage)).toEqual(['before', 'complete']);
    expect(events[0]?.[1]).toEqual({
      timestamp: 100,
      id: 'b1',
      sequence: 'b1',
      mechanism: 'sendBeacon',
      url: 'https://api/collect',
      method: 'POST', // sendBeacon is always a POST
      type: 'before',
      custom: {
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: 'payload',
      },
    });
    expect(events[1]?.[1]).toEqual({
      timestamp: 100,
      id: 'b1',
      sequence: 'b1',
      mechanism: 'sendBeacon',
      url: 'https://api/collect',
      method: 'POST',
      type: 'complete',
      custom: { timings: { duration: 0 } },
    });
  });

  it('reports no status or statusText on complete — a beacon has no response to report one from', () => {
    const { events, send } = setup();
    send('https://api/collect', 'payload');
    const complete = events[1]?.[1];
    expect(complete?.type).toBe('complete');
    expect(complete?.status).toBeUndefined();
    expect(complete?.statusText).toBeUndefined();
    expect(complete?.customError).toBeUndefined();
  });

  it('measures the queueing duration on complete', () => {
    let t = 10;
    const { events, send } = setup({
      now: () => {
        t += 5;
        return t;
      },
    });
    send('https://api/collect', 'x');
    expect(events[0]?.[1].timestamp).toBe(15); // startedAt
    expect(events[1]?.[1].timestamp).toBe(20);
    expect(events[1]?.[1].custom?.timings).toEqual({ duration: 5 });
  });

  it('returns the original result verbatim and passes url + data + receiver through untouched', () => {
    const queued = setup({}, () => true);
    const payload = 'a=1';
    expect(queued.send('https://api/a', payload)).toBe(true);
    expect(queued.calls).toEqual([{ self: queued.nav, url: 'https://api/a', data: payload }]);

    const refused = setup({}, () => false);
    expect(refused.send('https://api/b', payload)).toBe(false); // verbatim, not coerced/inverted
    expect(refused.calls[0]?.data).toBe(payload);
  });

  it('marks a refused beacon (false) on complete with an error message and no invented status', () => {
    const { events, send } = setup({}, () => false);
    expect(send('https://api/collect', 'payload')).toBe(false);
    const complete = events[1]?.[1];
    expect(complete?.type).toBe('complete');
    expect(complete?.status).toBeUndefined(); // a refusal is NOT an HTTP failure — no status invented
    expect(complete?.statusText).toBeUndefined();
    expect(complete?.customError).toMatch(/refused/i);
    expect(complete?.custom?.error).toBe(complete?.customError);
  });

  it('serializes a URLSearchParams body with the form-urlencoded content type', () => {
    const { events, send } = setup();
    send('https://api/collect', new web.URLSearchParams({ a: '1', b: '2' }));
    expect(events[0]?.[1].custom).toEqual({
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'a=1&b=2',
    });
  });

  it('takes the content type from a Blob and reports cant_read_data for its unreadable data', () => {
    const { events, send } = setup();
    send('https://api/collect', new web.Blob(['{"a":1}'], { type: 'application/json' }));
    expect(events[0]?.[1].custom).toEqual({
      headers: { 'content-type': 'application/json' },
      no_body_reason: 'cant_read_data', // a Blob is only readable asynchronously
    });
    expect(events[0]?.[1].custom?.body).toBeUndefined();
  });

  it('omits the content type for a Blob that declares none', () => {
    const { events, send } = setup();
    send('https://api/collect', new web.Blob(['xx']));
    expect(events[0]?.[1].custom).toEqual({ headers: {}, no_body_reason: 'cant_read_data' });
  });

  it('reports cant_read_data with no content type for binary and FormData payloads', () => {
    const { events, send } = setup();
    send('https://api/collect', new Uint8Array([1, 2, 3]));
    send('https://api/collect', new web.FormData());
    expect(events[0]?.[1].custom).toEqual({ headers: {}, no_body_reason: 'cant_read_data' });
    expect(events[2]?.[1].custom).toEqual({ headers: {}, no_body_reason: 'cant_read_data' });
  });

  it('emits neither a body nor a reason when the beacon carries no data', () => {
    const { events, send } = setup();
    send('https://api/collect');
    expect(events[0]?.[1].custom).toEqual({ headers: {} });
    send('https://api/collect', null);
    expect(events[2]?.[1].custom).toEqual({ headers: {} });
  });

  it('coerces a URL object to a string url', () => {
    const { events, send } = setup();
    send(new web.URL('https://api/collect?a=1'), 'x');
    expect(events[0]?.[1].url).toBe('https://api/collect?a=1');
    expect(typeof events[0]?.[1].url).toBe('string');
  });

  it('shares one id/sequence per beacon and increments per beacon (default counter)', () => {
    const { events, send } = setup({ newId: undefined });
    send('https://api/a', 'x');
    send('https://api/b', 'y');
    expect(events.map(([, e]) => e.id)).toEqual(['b1', 'b1', 'b2', 'b2']);
    expect(events.map(([, e]) => e.sequence)).toEqual(['b1', 'b1', 'b2', 'b2']);
  });

  it('uses the default clock (Date.now) when none is injected', () => {
    const { events, send } = setup({ now: undefined });
    send('https://api/a', 'x');
    expect(events[0]?.[1].timestamp).toBeGreaterThan(0);
  });

  it('does not capture SDK-internal traffic but still sends it and returns verbatim', () => {
    const { events, calls, send } = setup(
      { isInternal: (url) => url.includes('bugsee') },
      () => false,
    );
    expect(send('https://collector.bugsee.com/upload', 'x')).toBe(false);
    expect(events).toEqual([]); // no before, and no complete either
    expect(calls).toHaveLength(1); // …but the beacon itself was still sent
  });

  it('captures a beacon that the default isInternal predicate does not recognize as internal', () => {
    const { events, send } = setup({ isInternal: undefined });
    send('https://api/collect', 'x');
    expect(events.map(([stage]) => stage)).toEqual(['before', 'complete']);
  });
});

describe('createSendBeaconInterceptor — never alters the application', () => {
  it('emits an error stage and rethrows when the underlying sendBeacon throws', () => {
    const boom = new TypeError('bad url');
    const { events, send } = setup({}, () => {
      throw boom;
    });
    expect(() => send('https://api/collect', 'x')).toThrow(boom); // propagated untouched
    expect(events.map(([stage]) => stage)).toEqual(['before', 'error']);
    expect(events[1]?.[1]).toMatchObject({
      id: 'b1',
      mechanism: 'sendBeacon',
      type: 'error',
      customError: 'bad url',
      custom: { error: 'bad url' },
    });
    expect(events[1]?.[1].status).toBeUndefined();
  });

  it('stringifies a non-Error thrown by the underlying sendBeacon', () => {
    const { events, send } = setup({}, () => {
      throw 'nope';
    });
    expect(() => send('https://api/collect', 'x')).toThrow('nope');
    expect(events[1]?.[1].customError).toBe('nope');
  });

  it('still sends and returns verbatim when the before-stage capture throws', () => {
    const { events, calls, send } = setup(
      {
        newId: () => {
          throw new Error('capture exploded');
        },
      },
      () => false,
    );
    expect(send('https://api/collect', 'x')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(events).toEqual([]); // capture failed → nothing recorded, and nothing thrown at the app
  });

  it('emits no error event for a beacon it never captured, and still rethrows', () => {
    const boom = new Error('send failed');
    const { events, send } = setup({ isInternal: () => true }, () => {
      throw boom;
    });
    expect(() => send('https://api/collect', 'x')).toThrow(boom);
    expect(events).toEqual([]); // no dangling `error` without its `before`
  });

  it('still returns verbatim when the complete-stage capture throws', () => {
    let calls = 0;
    const { events, send } = setup({
      now: () => {
        calls += 1;
        if (calls > 1) {
          throw new Error('clock exploded');
        }
        return 100;
      },
    });
    expect(send('https://api/collect', 'x')).toBe(true);
    expect(events.map(([stage]) => stage)).toEqual(['before']); // complete lost, app unaffected
  });

  it('still rethrows the application error when the error-stage capture also throws', () => {
    const boom = new Error('send failed');
    let calls = 0;
    const { send } = setup(
      {
        now: () => {
          calls += 1;
          if (calls > 1) {
            throw new Error('clock exploded');
          }
          return 100;
        },
      },
      () => {
        throw boom;
      },
    );
    expect(() => send('https://api/collect', 'x')).toThrow(boom); // the app's error, not the clock's
  });
});

describe('createSendBeaconInterceptor — activation', () => {
  it('is named "sendbeacon"', () => {
    const { ic } = setup();
    expect(ic.name).toBe('sendbeacon');
  });

  it('wraps sendBeacon on activate and restores the original on the last unsubscribe', () => {
    const nav = { sendBeacon: ((): boolean => true) as BeaconFn };
    const original = nav.sendBeacon;
    const target: SendBeaconTarget = {
      get: () => nav.sendBeacon,
      set: (fn) => {
        nav.sendBeacon = fn;
      },
    };
    const ic = createSendBeaconInterceptor({ target });
    expect(nav.sendBeacon).toBe(original); // idle → not patched
    const off = ic.onAny(() => {});
    expect(nav.sendBeacon).not.toBe(original); // active → patched
    off();
    expect(nav.sendBeacon).toBe(original); // the ORIGINAL function is put back
  });

  it('self-skips when sendBeacon is absent (no wrap, no throw on deactivate)', () => {
    let assigned = 0;
    const target: SendBeaconTarget = {
      get: () => undefined,
      set: () => {
        assigned += 1;
      },
    };
    const ic = createSendBeaconInterceptor({ target });
    const off = ic.onAny(() => {});
    off();
    expect(assigned).toBe(0); // nothing patched, nothing restored
  });

  it('self-skips when the target holds a non-function (a partial polyfill)', () => {
    let assigned = 0;
    const target: SendBeaconTarget = {
      get: () => 'not a function' as unknown as BeaconFn,
      set: () => {
        assigned += 1;
      },
    };
    const ic = createSendBeaconInterceptor({ target });
    ic.onAny(() => {});
    expect(assigned).toBe(0);
  });
});

describe('createSendBeaconInterceptor — the default (global navigator) target', () => {
  const NAV = 'navigator';
  const describeNav = Object.getOwnPropertyDescriptor(globalThis, NAV);
  afterEach(() => {
    if (describeNav === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, NAV, describeNav);
    }
  });
  const installNavigator = (value: unknown): void => {
    Object.defineProperty(globalThis, NAV, { value, configurable: true, writable: true });
  };

  it('wraps globalThis.navigator.sendBeacon and restores it', () => {
    const original = ((): boolean => true) as BeaconFn;
    const nav = { sendBeacon: original };
    installNavigator(nav);
    const ic = createSendBeaconInterceptor(); // no target → the global default
    const off = ic.onAny(() => {});
    expect(nav.sendBeacon).not.toBe(original);
    expect(nav.sendBeacon('https://api/x', 'y')).toBe(true); // the wrapper delegates
    off();
    expect(nav.sendBeacon).toBe(original);
  });

  it('self-skips when navigator exists without sendBeacon (node / edge)', () => {
    installNavigator({ userAgent: 'node' });
    const ic = createSendBeaconInterceptor();
    const events: NetworkStage[] = [];
    expect(() => ic.onAny((stage) => events.push(stage))).not.toThrow();
    expect(
      (globalThis as { navigator?: { sendBeacon?: unknown } }).navigator?.sendBeacon,
    ).toBeUndefined();
  });

  it('self-skips when there is no navigator at all (workers without one)', () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    const ic = createSendBeaconInterceptor();
    expect(() => ic.onAny(() => {})).not.toThrow();
  });
});
