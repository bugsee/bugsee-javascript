import type { BrowserProbe, Bugsee } from '@bugsee/browser';
import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
import { serializeTransaction, type Transaction } from '@bugsee/performance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BugseeLaunchOptionsWithPerformance, launch } from './launch';

// --- fakes ---------------------------------------------------------------------------------------

function fakeWindow() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    win: {
      addEventListener(type: string, l: (event: Event) => void) {
        (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(l);
      },
      removeEventListener(type: string, l: (event: Event) => void) {
        listeners.get(type)?.delete(l);
      },
    },
  };
}

const probe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 (Test) Browser/9.0',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

const jsonBody = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

// A transport that satisfies the session handshake and records every /v2/performance/transactions POST.
function recordingTransport() {
  const perfPosts: { url: string; body: string; auth: string | undefined }[] = [];
  const fn = vi.fn<HttpTransport>(async (url: string, opts: HttpRequestOptions = {}) => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'access-tok' }) };
    }
    if (url.endsWith('/v2/performance/transactions')) {
      perfPosts.push({ url, body: opts.body as string, auth: opts.headers?.authorization });
      return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, perfPosts };
}

// A scheduler that records each interval (distinct id + ms + callback) and which ids were cleared, and
// can fire a captured interval callback (the uploader's flush tick) and let its async flush settle.
function fakeScheduler() {
  const intervals: { id: number; ms: number; cb: () => void }[] = [];
  const cleared: number[] = [];
  let n = 0;
  const scheduler = {
    setInterval: (cb: () => void, ms: number) => {
      const id = ++n;
      intervals.push({ id, ms, cb });
      return id;
    },
    clearInterval: (h: unknown) => {
      cleared.push(h as number);
    },
  };
  const fire = async (ms: number) => {
    intervals.find((i) => i.ms === ms)?.cb();
    // The flush chain awaits ensureSession (session POST) then the perf POST then onError — let the whole
    // microtask chain settle via a macrotask boundary.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { scheduler, intervals, cleared, fire };
}

// --- harness -------------------------------------------------------------------------------------

const launched: Bugsee[] = [];
const track = (client: Bugsee): Bugsee => {
  launched.push(client);
  return client;
};

beforeEach(() => {
  // The umbrella always wires http spans, which subscribes to the network interceptor; stub the network
  // globals to undefined so the cross-runtime leaves self-skip and no real fetch/XHR is patched.
  for (const g of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport']) {
    vi.stubGlobal(g, undefined);
  }
});

afterEach(async () => {
  await Promise.all(launched.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const base = (
  over: Partial<BugseeLaunchOptionsWithPerformance> = {},
): BugseeLaunchOptionsWithPerformance => ({
  window: fakeWindow().win,
  transport: recordingTransport().fn,
  systemProbe: probe,
  systemMetricsSampler: () => [{ name: 'browser_memory_used_heap', value: 42 }],
  captureNetwork: false,
  ...over,
});

// --- tests ---------------------------------------------------------------------------------------

describe('bugsee umbrella launch', () => {
  it('wires performance on by default: registers ext(performance) + starts an active pageload transaction', () => {
    const client = track(launch('tok', base({ carrier: {} })));
    expect(() => client.ext('performance')).not.toThrow(); // the extension is registered
    expect(client.ext('performance').getActiveSpan()).toBeDefined(); // the pageload transaction is active
  });

  it('does NOT wire performance when performanceMonitoring is false', () => {
    const client = track(launch('tok', base({ carrier: {}, performanceMonitoring: false })));
    expect(() => client.ext('performance')).toThrow(/not registered/); // extension never set up
  });

  it('threads performanceSampleRate into the head sampler (0 → the pageload transaction is unsampled)', () => {
    const client = track(launch('tok', base({ carrier: {}, performanceSampleRate: 0 })));
    expect((client.ext('performance').getActiveSpan() as Transaction).isSampled()).toBe(false);
  });

  it('names the pageload transaction from options.pageName', () => {
    const client = track(launch('tok', base({ carrier: {}, pageName: '/checkout' })));
    expect((client.ext('performance').getActiveSpan() as Transaction).getName()).toBe('/checkout');
  });

  it('defaults the pageload name to location.pathname when present', () => {
    vi.stubGlobal('location', { pathname: '/dashboard' });
    const client = track(launch('tok', base({ carrier: {} })));
    expect((client.ext('performance').getActiveSpan() as Transaction).getName()).toBe('/dashboard');
  });

  it('defaults the pageload name to "pageload" when no location is available', () => {
    const client = track(launch('tok', base({ carrier: {} })));
    expect((client.ext('performance').getActiveSpan() as Transaction).getName()).toBe('pageload');
  });

  it('wires the send: a finished pageload transaction POSTs to /v2/performance/transactions with the session Bearer', async () => {
    const carrier = {};
    const { scheduler, fire } = fakeScheduler();
    const { fn: transport, perfPosts } = recordingTransport();
    const client = track(
      launch('tok', base({ carrier, scheduler, transport, performanceFlushIntervalMs: 7777 })),
    );
    (client.ext('performance').getActiveSpan() as Transaction).finish(); // → buffered into the perf store
    await fire(7777); // run the uploader's flush tick at the injected interval
    expect(perfPosts).toHaveLength(1);
    expect(perfPosts[0]?.url.endsWith('/v2/performance/transactions')).toBe(true);
    expect(perfPosts[0]?.auth).toBe('Bearer access-tok');
    expect(JSON.parse(perfPosts[0]?.body ?? '{}').transactions).toHaveLength(1);
  });

  it('starts the uploader at performanceFlushIntervalMs', () => {
    const { scheduler, intervals } = fakeScheduler();
    track(launch('tok', base({ carrier: {}, scheduler, performanceFlushIntervalMs: 7777 })));
    expect(intervals.some((i) => i.ms === 7777)).toBe(true);
  });

  it('stop() tears performance down: the uploader interval is cleared', async () => {
    const { scheduler, intervals, cleared } = fakeScheduler();
    const client = launch(
      'tok',
      base({ carrier: {}, scheduler, performanceFlushIntervalMs: 7777 }),
    );
    const perfInterval = intervals.find((i) => i.ms === 7777);
    expect(perfInterval).toBeDefined();
    await client.stop();
    expect(cleared).toContain(perfInterval?.id); // wired.stop() → uploader.stop() → clearInterval(handle)
  });

  it('threads appVersion/appBuild from the launch onto the performance transaction wire', () => {
    const client = track(launch('tok', base({ carrier: {}, appVersion: '1.2.3', appBuild: '99' })));
    const wire = serializeTransaction(client.ext('performance').getActiveSpan() as Transaction);
    expect(wire.appVersion).toBe('1.2.3');
    expect(wire.appBuild).toBe('99');
  });

  it('routes a performance send failure to the launch onError', async () => {
    const carrier = {};
    const { scheduler, fire } = fakeScheduler();
    const onError = vi.fn();
    const transport = vi.fn<HttpTransport>(async (url: string) => {
      if (url.endsWith('/v2/sessions')) {
        return { status: 200, headers: {}, body: jsonBody({ access_token: 't' }) };
      }
      if (url.endsWith('/v2/performance/transactions')) {
        return { status: 500, headers: {}, body: new Uint8Array() }; // fail the perf upload
      }
      return { status: 200, headers: {}, body: new Uint8Array() };
    });
    const client = track(
      launch(
        'tok',
        base({ carrier, scheduler, transport, onError, performanceFlushIntervalMs: 7777 }),
      ),
    );
    (client.ext('performance').getActiveSpan() as Transaction).finish();
    await fire(7777);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('performance upload failed') }),
    );
  });

  it('a repeat launch returns the same client and does not double-wire (no "already registered" throw)', () => {
    const carrier = {};
    const onError = vi.fn();
    const first = track(launch('tok', base({ carrier })));
    // A second launch on the same carrier must NOT run wirePerformance again (registerExt would throw).
    const second = launch('tok', base({ carrier, onError }));
    expect(second).toBe(first); // the existing singleton client
    expect(onError).toHaveBeenCalledTimes(1); // the repeat-launch warning fired
    expect(() => second.ext('performance')).not.toThrow(); // still wired exactly once
  });

  // The fetch leaf wraps globalThis.fetch once the http-span collector subscribes (perf on by default).
  const okResp = { status: 200, statusText: 'OK', redirected: false, headers: { forEach() {} } };
  const globalFetch = () =>
    (globalThis as { fetch: (i: unknown, init?: unknown) => Promise<unknown> }).fetch;

  it('propagateTrace injects W3C traceparent + the bugsee= session tracestate on a same-origin fetch', async () => {
    let received: { init: unknown } | undefined;
    vi.stubGlobal('fetch', async (_i: unknown, init: unknown) => {
      received = { init };
      return okResp;
    });
    const client = track(
      launch(
        'tok',
        base({ carrier: {}, propagateTrace: true, tracePropagationOrigin: 'https://app.test' }),
      ),
    );
    const active = client.ext('performance').getActiveSpan() as Transaction;
    await globalFetch()('https://app.test/api', { method: 'GET' });
    const headers = (received?.init as { headers?: Record<string, string> }).headers;
    expect(headers?.traceparent).toBe(`00-${active.getTraceId()}-${active.getSpanId()}-01`);
    // X3b: the FE now also propagates its session-correlation id (so it floats to the backend).
    expect(headers?.tracestate).toMatch(/(^|,)bugsee=r1:s[0-9a-f]+/);
  });

  it('does NOT propagate cross-origin without an allowlist (no topology leak), but does with one', async () => {
    let received: { init: unknown } | undefined;
    vi.stubGlobal('fetch', async (_i: unknown, init: unknown) => {
      received = { init };
      return okResp;
    });
    track(
      launch(
        'tok',
        base({
          carrier: {},
          propagateTrace: true,
          tracePropagationOrigin: 'https://app.test',
          tracePropagationTargets: ['api.partner.test'],
        }),
      ),
    );
    await globalFetch()('https://third-party.test/x', { method: 'GET' });
    expect(
      (received?.init as { headers?: Record<string, string> }).headers?.traceparent,
    ).toBeUndefined();
    await globalFetch()('https://api.partner.test/x', { method: 'GET' });
    expect(
      (received?.init as { headers?: Record<string, string> }).headers?.traceparent,
    ).toBeDefined();
  });

  it('defaults same-origin detection to location.origin when no tracePropagationOrigin is given', async () => {
    vi.stubGlobal('location', { origin: 'https://default.test', pathname: '/' });
    let received: { init: unknown } | undefined;
    vi.stubGlobal('fetch', async (_i: unknown, init: unknown) => {
      received = { init };
      return okResp;
    });
    // propagateTrace on, NO explicit origin → the decorator falls back to globalThis.location.origin.
    track(launch('tok', base({ carrier: {}, propagateTrace: true })));
    await globalFetch()('https://default.test/api', { method: 'GET' });
    expect(
      (received?.init as { headers?: Record<string, string> }).headers?.traceparent,
    ).toBeDefined(); // same-origin (location.origin) → propagated without an explicit origin
  });

  it('does NOT propagate when propagateTrace is off (browser default)', async () => {
    let received: { init: unknown } | undefined;
    vi.stubGlobal('fetch', async (_i: unknown, init: unknown) => {
      received = { init };
      return okResp;
    });
    // Set the origin so the request below WOULD be propagated if the feature were on — proving OFF.
    track(launch('tok', base({ carrier: {}, tracePropagationOrigin: 'https://app.test' }))); // default off
    const init = { method: 'GET' };
    await globalFetch()('https://app.test/api', init); // same-origin → would get traceparent if on
    expect(received?.init).toBe(init); // unchanged (same ref) — no decorator registered
  });

  it('produce-tee: exports finished transactions to BOTH Bugsee and the OTLP endpoint (headers/resource)', async () => {
    const { scheduler, fire } = fakeScheduler();
    const calls: { url: string; body: string; headers: Record<string, string> | undefined }[] = [];
    const transport = vi.fn<HttpTransport>(async (url: string, opts: HttpRequestOptions = {}) => {
      if (url.endsWith('/v2/sessions')) {
        return { status: 200, headers: {}, body: jsonBody({ access_token: 'tok' }) };
      }
      calls.push({ url, body: opts.body as string, headers: opts.headers });
      return { status: 200, headers: {}, body: new Uint8Array() };
    });
    const client = track(
      launch(
        'tok',
        base({
          carrier: {},
          scheduler,
          transport,
          performanceFlushIntervalMs: 7777,
          otelExportUrl: 'https://collector.test/v1/traces',
          otelExportHeaders: { 'x-honeycomb-team': 'k' },
          otelExportResource: { 'service.name': 'web' },
        }),
      ),
    );
    (client.ext('performance').getActiveSpan() as Transaction).finish();
    await fire(7777);
    expect(calls.find((c) => c.url.endsWith('/v2/performance/transactions'))).toBeDefined(); // Bugsee still gets it
    const otlp = calls.find((c) => c.url.endsWith('/v1/traces'));
    expect(otlp).toBeDefined();
    expect(otlp?.headers?.['x-honeycomb-team']).toBe('k');
    const body = JSON.parse(otlp?.body ?? '{}');
    expect(body.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'web' },
    });
    expect(body.resourceSpans[0].scopeSpans[0].spans.length).toBeGreaterThan(0);
    // Profile v1 §5: the instrumentation scope name is com.bugsee.<sdk>/<provider> — webjs on the browser.
    expect(body.resourceSpans[0].scopeSpans[0].scope.name).toBe('com.bugsee.webjs/performance');
  });

  it('produce-tee: an OTLP failure surfaces to onError, but Bugsee still receives the batch', async () => {
    const { scheduler, fire } = fakeScheduler();
    const onError = vi.fn();
    let bugseePosted = false;
    const transport = vi.fn<HttpTransport>(async (url: string) => {
      if (url.endsWith('/v2/sessions')) {
        return { status: 200, headers: {}, body: jsonBody({ access_token: 'tok' }) };
      }
      if (url.endsWith('/v1/traces')) {
        return { status: 500, headers: {}, body: new Uint8Array() }; // OTLP export fails
      }
      bugseePosted = true; // /v2/performance/transactions
      return { status: 200, headers: {}, body: new Uint8Array() };
    });
    const client = track(
      launch(
        'tok',
        base({
          carrier: {},
          scheduler,
          transport,
          onError,
          performanceFlushIntervalMs: 7777,
          otelExportUrl: 'https://collector.test/v1/traces',
        }),
      ),
    );
    (client.ext('performance').getActiveSpan() as Transaction).finish();
    await fire(7777);
    expect(bugseePosted).toBe(true); // allSettled → Bugsee got it despite the OTLP failure
    expect(onError).toHaveBeenCalled(); // the OTLP failure surfaced
  });

  it('consume: hands over a SpanProcessor whose consumed spans ride the Bugsee upload', async () => {
    const { scheduler, fire } = fakeScheduler();
    const { fn: transport, perfPosts } = recordingTransport();
    let sp: BugseeSpanProcessor | undefined;
    track(
      launch(
        'tok',
        base({
          carrier: {},
          scheduler,
          transport,
          performanceFlushIntervalMs: 7777,
          otelConsume: true,
          onOtelSpanProcessor: (p) => {
            sp = p;
          },
        }),
      ),
    );
    expect(sp).toBeDefined();
    // A finished OTel root span (no parent) → assembled into a transaction → recorded into the pipeline.
    sp?.onEnd({
      spanContext: () => ({
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: 'aaaaaaaaaaaaaaaa',
      }),
      name: 'GET /api',
      startTime: [1, 0],
      endTime: [2, 0],
      status: { code: 1 },
    });
    await fire(7777);
    expect(perfPosts).toHaveLength(1);
    expect(JSON.parse(perfPosts[0]?.body ?? '{}').transactions[0].name).toBe('GET /api');
  });

  it('otelConsume without onOtelSpanProcessor wires no SpanProcessor (no throw)', () => {
    expect(() => track(launch('tok', base({ carrier: {}, otelConsume: true })))).not.toThrow();
  });
});
