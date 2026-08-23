import type { Clock, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { NodeRuntime, SystemProbe } from '@bugsee/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the zero-config OTel provider self-registration so real launches here never stand up a real global
// TracerProvider (which would pollute cross-test global state). Its own logic is tested in
// otel-provider.test.ts; here we only assert registerServer WIRES it. attach stays a no-op spy.
const { attachBugseeOtelProvider } = vi.hoisted(() => ({
  attachBugseeOtelProvider: vi.fn<
    (processor: unknown, options?: { setupOtelProvider?: boolean }) => Promise<'registered'>
  >(async () => 'registered' as const),
}));
vi.mock('./otel-provider', () => ({ attachBugseeOtelProvider }));

import {
  type Bugsee,
  type BugseeSpanProcessor,
  type NextjsServerOptions,
  registerServer,
} from './server';

// --- harness (mirrors the umbrella node.test: fake process/probe/clock/scheduler + recording transport) ---

const jsonBody = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

function fakeProcess(): NodeRuntime {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const proc: NodeRuntime = {
    on(event, listener) {
      (listeners.get(event) ?? listeners.set(event, []).get(event))?.push(listener);
      return proc;
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return proc;
    },
    exit: () => {},
  };
  return proc;
}

const probe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => '20.1.2',
  osType: () => 'Linux',
  osPlatform: () => 'darwin',
  osRelease: () => '6.0',
  osArch: () => 'arm64',
  machine: () => 'x86_64',
  cpuCount: () => 8,
  totalMemory: () => 16_000,
  freeMemory: () => 4_000,
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};

const fixedClock: Clock = { wallNow: () => 5000, monotonicNow: () => 0 };

/** Records every request; satisfies the session→issue→S3 handshake and the perf-transactions POST. */
function recordingTransport() {
  const calls: Array<{ url: string; options: HttpRequestOptions }> = [];
  const fn = vi.fn<HttpTransport>(async (url: string, options: HttpRequestOptions = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'access' }) };
    }
    if (url.endsWith('/v2/issues')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
      };
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, calls };
}

/** A controllable interval scheduler — `fire(ms)` runs the registered interval once (flush the uploader). */
function fakeScheduler() {
  const intervals: Array<{ ms: number; cb: () => void }> = [];
  const scheduler = {
    setInterval: (cb: () => void, ms: number) => {
      intervals.push({ ms, cb });
      return 'h';
    },
    clearInterval: () => {},
  };
  const fire = async (ms: number) => {
    intervals.find((i) => i.ms === ms)?.cb();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { scheduler, fire };
}

/** The transactions the perf uploader POSTed (from /v2/performance/transactions bodies). */
const perfTransactions = (calls: Array<{ url: string; options: HttpRequestOptions }>) =>
  calls
    .filter((c) => c.url.endsWith('/v2/performance/transactions'))
    .flatMap((c) => JSON.parse(String(c.options.body)).transactions as Array<{ name: string }>);

const started: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  attachBugseeOtelProvider.mockClear();
});

/** Launch through registerServer with the hermetic node fakes. A fresh `carrier: {}` per call isolates
 *  each test from the process-global singleton (isolation does not rely on the afterEach `stop()`). */
function register(appToken: string, extra: Partial<NextjsServerOptions> = {}): Bugsee {
  const client = registerServer(appToken, {
    process: fakeProcess(),
    systemProbe: probe,
    systemMetricsSampler: () => [{ name: 'process_memory_rss', value: 42 }],
    captureNetwork: false,
    capturedDataStore: 'memory',
    clock: fixedClock,
    recover: false,
    carrier: {},
    ...extra,
  });
  started.push(client);
  return client;
}

// --- N1a: the server composition contract ------------------------------------------------------

describe('registerServer', () => {
  it('returns a started Bugsee client with the report surface', () => {
    const { fn } = recordingTransport();
    const client = register('tok', { transport: fn });
    expect(typeof client.logException).toBe('function');
    expect(typeof client.flush).toBe('function');
    expect(typeof client.stop).toBe('function');
    expect(() => client.ext('performance')).not.toThrow(); // performance on by default (batteries-included)
  });

  it('forwards the appToken to the wire (x-app-token header + session app_token)', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('my-app-token', { transport: fn });
    await client.logException(new Error('boom'));
    await client.flush();

    const session = calls.find((c) => c.url.endsWith('/v2/sessions'));
    expect(session).toBeDefined();
    expect(session?.options.headers?.['x-app-token']).toBe('my-app-token');
    const raw = session?.options.body;
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
    expect(JSON.parse(text).app_token).toBe('my-app-token');
  });

  it('forwards launch options (endpoint) to the node composition', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('tok', { transport: fn, endpoint: 'https://custom.test' });
    await client.logException(new Error('boom'));
    await client.flush();

    const apiCalls = calls.filter((c) => c.url.includes('/v2/'));
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const c of apiCalls) {
      expect(c.url.startsWith('https://custom.test/')).toBe(true);
    }
  });

  it('uploads an issue for a reported exception (the composition actually captures)', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('tok', { transport: fn });
    await client.logException(new Error('boom'));
    await client.flush();
    expect(calls.some((c) => c.url.endsWith('/v2/issues'))).toBe(true);
  });

  it('is a per-process singleton — a repeat call returns the existing client (dev HMR)', () => {
    const { fn } = recordingTransport();
    const carrier = {};
    const onError = vi.fn();
    const first = register('tok', { transport: fn, carrier, onError });
    const second = registerServer('tok', {
      process: fakeProcess(),
      systemProbe: probe,
      captureNetwork: false,
      capturedDataStore: 'memory',
      clock: fixedClock,
      recover: false,
      transport: fn,
      carrier,
      onError,
    });

    expect(second).toBe(first); // same instance — no second client built
    const warned = onError.mock.calls.some(
      ([e]) => e instanceof Error && /more than once/.test(e.message),
    );
    expect(warned).toBe(true);
  });

  // --- N1b-1: the OTel consume bridge (default-attach, exposed for coexistence) -----------------

  it('records + uploads the app.start startup transaction (performance on by default)', async () => {
    const { scheduler, fire } = fakeScheduler();
    const { fn, calls } = recordingTransport();
    register('tok', {
      transport: fn,
      scheduler,
      performanceFlushIntervalMs: 7777,
      appStartTimeMs: 1000,
    });
    await fire(7777); // flush the perf uploader
    expect(perfTransactions(calls).map((t) => t.name)).toContain('app.start');
  });

  it('exposes the Bugsee OTel SpanProcessor via onSpanProcessor exactly once (consume default-attached)', () => {
    const { fn } = recordingTransport();
    const onSpanProcessor = vi.fn<(p: BugseeSpanProcessor) => void>();
    register('tok', { transport: fn, onSpanProcessor });
    expect(onSpanProcessor).toHaveBeenCalledTimes(1); // one processor, handed over once
    const sp = onSpanProcessor.mock.calls[0]?.[0];
    for (const method of ['onStart', 'onEnd', 'forceFlush', 'shutdown'] as const) {
      expect(typeof sp?.[method]).toBe('function');
    }
  });

  it('honours an explicit otelConsume: false (no consume, processor never handed over)', () => {
    const { fn } = recordingTransport();
    const onSpanProcessor = vi.fn<(p: BugseeSpanProcessor) => void>();
    register('tok', { transport: fn, otelConsume: false, onSpanProcessor });
    // The default-attach default must remain OVERRIDABLE — the spread order must not clobber the caller.
    expect(onSpanProcessor).not.toHaveBeenCalled();
  });

  it('consumes an OTel span into a native transaction that uploads', async () => {
    const { scheduler, fire } = fakeScheduler();
    const { fn, calls } = recordingTransport();
    let sp: BugseeSpanProcessor | undefined;
    register('tok', {
      transport: fn,
      scheduler,
      performanceFlushIntervalMs: 7777,
      appStartTimeMs: 1000,
      onSpanProcessor: (p) => {
        sp = p;
      },
    });
    // Simulate Next.js ending a server root span (what @vercel/otel would emit).
    sp?.onEnd({
      spanContext: () => ({
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: 'aaaaaaaaaaaaaaaa',
      }),
      name: 'GET /api/users',
      startTime: [1, 0],
      endTime: [2, 0],
      status: { code: 1 },
    });
    await fire(7777);
    expect(perfTransactions(calls).map((t) => t.name)).toContain('GET /api/users');
  });

  it('launches without an onSpanProcessor callback (consume still enabled, no throw)', async () => {
    const { scheduler, fire } = fakeScheduler();
    const { fn, calls } = recordingTransport();
    register('tok', {
      transport: fn,
      scheduler,
      performanceFlushIntervalMs: 7777,
      appStartTimeMs: 1000,
    });
    await fire(7777);
    // No onSpanProcessor: the composition still wires perf + consume (app.start proves perf is live).
    expect(perfTransactions(calls).map((t) => t.name)).toContain('app.start');
  });

  // --- N1b-2: zero-config OTel provider self-registration is wired ------------------------------

  it('fires the zero-config OTel provider self-registration with the wired processor', () => {
    const { fn } = recordingTransport();
    register('tok', { transport: fn });
    expect(attachBugseeOtelProvider).toHaveBeenCalledTimes(1);
    const processor = attachBugseeOtelProvider.mock.calls[0]?.[0] as BugseeSpanProcessor;
    expect(typeof processor.onEnd).toBe('function'); // the REAL wired consume-bridge processor
  });

  it('forwards setupOtelProvider (opt-out) + onError to the self-registration', () => {
    const { fn } = recordingTransport();
    const onError = () => {};
    register('tok', { transport: fn, setupOtelProvider: false, onError });
    expect(attachBugseeOtelProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ setupOtelProvider: false, onError }),
    );
  });

  it('does not self-register when consume is off (no processor to hand over)', () => {
    const { fn } = recordingTransport();
    register('tok', { transport: fn, otelConsume: false });
    expect(attachBugseeOtelProvider).not.toHaveBeenCalled();
  });
});
