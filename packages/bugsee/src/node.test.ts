import type { Clock, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { Bugsee, NodeRuntime } from '@bugsee/node';
import type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BugseeNodeLaunchOptions, launch } from './node';

// --- node fakes (no real process / network / perf_hooks) ----------------------------------------

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

const probe = {
  nodeVersion: () => '20.1.2',
  osType: () => 'Linux',
  osRelease: () => '6.0',
  machine: () => 'x86_64',
  cpuCount: () => 8,
  totalMemory: () => 16_000,
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};

const fixedClock: Clock = { wallNow: () => 5000, monotonicNow: () => 0 };
const jsonBody = (obj: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(obj)));

function recordingTransport() {
  const perfPosts: { body: string }[] = [];
  const fn = vi.fn<HttpTransport>(async (url: string, opts: HttpRequestOptions = {}) => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'tok' }) };
    }
    if (url.endsWith('/v2/performance/transactions')) {
      perfPosts.push({ body: opts.body as string });
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, perfPosts };
}

function fakeScheduler() {
  const intervals: { ms: number; cb: () => void }[] = [];
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

const launched: Bugsee[] = [];
const track = (c: Bugsee): Bugsee => (launched.push(c), c);
afterEach(async () => {
  await Promise.all(launched.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const base = (over: Partial<BugseeNodeLaunchOptions> = {}): BugseeNodeLaunchOptions => ({
  process: fakeProcess(),
  systemProbe: probe,
  systemMetricsSampler: () => [{ name: 'process_memory_rss', value: 42 }],
  captureNetwork: false,
  clock: fixedClock,
  ...over,
});

const transactionsOf = (perfPosts: { body: string }[]): Array<{ name: string }> =>
  perfPosts.flatMap((p) => JSON.parse(p.body).transactions as Array<{ name: string }>);

describe('bugsee node umbrella launch', () => {
  it('wires perf WITHOUT a pageload transaction and records an app.start startup transaction', async () => {
    const { scheduler, fire } = fakeScheduler();
    const { fn: transport, perfPosts } = recordingTransport();
    const client = track(
      launch(
        'tok',
        base({
          carrier: {},
          scheduler,
          transport,
          performanceFlushIntervalMs: 7777,
          appStartTimeMs: 1000,
        }),
      ),
    );
    expect(() => client.ext('performance')).not.toThrow(); // the extension is registered
    expect(client.ext('performance').getActiveSpan()).toBeUndefined(); // NO browser pageload transaction
    await fire(7777); // flush the uploader
    const startup = transactionsOf(perfPosts).find((t) => t.name === 'app.start');
    expect(startup).toMatchObject({
      name: 'app.start',
      operation: 'app.start',
      startTimestampMs: 1000, // injected process start
      endTimestampMs: 5000, // launch time (fixed clock)
    });
  });

  it('consume works on Node: a SpanProcessor span uploads as a native transaction', async () => {
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
          appStartTimeMs: 1000,
          otelConsume: true,
          onOtelSpanProcessor: (p) => {
            sp = p;
          },
        }),
      ),
    );
    expect(sp).toBeDefined();
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
    const names = transactionsOf(perfPosts).map((t) => t.name);
    expect(names).toContain('GET /api'); // the consumed span rode the Node upload
    expect(names).toContain('app.start'); // the startup transaction too
  });

  it('defaults the startup start time to the real process uptime when appStartTimeMs is omitted', async () => {
    const { scheduler, fire } = fakeScheduler();
    const { fn: transport, perfPosts } = recordingTransport();
    // No appStartTimeMs → uses Date.now() - process.uptime()*1000.
    track(
      launch('tok', base({ carrier: {}, scheduler, transport, performanceFlushIntervalMs: 7777 })),
    );
    await fire(7777);
    expect(transactionsOf(perfPosts).some((t) => t.name === 'app.start')).toBe(true);
  });

  it('a repeat launch returns the same client (singleton) and does not re-wire', () => {
    const carrier = {};
    const first = track(launch('tok', base({ carrier, appStartTimeMs: 1000 })));
    const second = launch('tok', base({ carrier, appStartTimeMs: 1000 }));
    expect(second).toBe(first);
  });
});
