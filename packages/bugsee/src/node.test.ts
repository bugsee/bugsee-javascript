import type { Clock, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import {
  type Bugsee,
  type LaunchResult,
  type NodeRuntime,
  RequestContextStoreToken,
  type SystemProbe,
} from '@bugsee/node';
import type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
import type { ActiveSpanStore } from '@bugsee/performance';
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

  freeMemory: () => 1_000,
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
const track = (c: Bugsee): Bugsee => {
  launched.push(c);
  return c;
};
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
  capturedDataStore: 'memory', // hermetic: stay off the shared default disk root (disk is the default now, D3)
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

  it('does NOT wire umbrella propagation on Node (the launch owns it; no ambient perf-sourced leak)', async () => {
    // The fetch leaf wraps globalThis.fetch once the network source subscribes; stub BEFORE launch so the
    // wrap wraps the stub. okResp is the minimal Response shape the leaf reads.
    const okResp = { status: 200, statusText: 'OK', redirected: false, headers: { forEach() {} } };
    let received: { init: unknown } | undefined;
    vi.stubGlobal('fetch', async (_i: unknown, init: unknown) => {
      received = { init };
      return okResp;
    });
    const client = track(
      launch(
        'tok',
        base({
          carrier: {},
          captureNetwork: true,
          propagateTrace: true,
          tracePropagationTargets: ['target.test'],
          appStartTimeMs: 1000,
        }),
      ),
    );
    // An ACTIVE (unfinished) perf transaction occupies the single-slot getActiveSpan. If the umbrella had
    // wrongly wired the perf-sourced decorator on Node, THIS ambient trace would leak onto the outgoing
    // request — wrong under server concurrency. Node propagation must be per-request-context-sourced (the
    // @bugsee/node launch's own decorator), which finds no active context here → injects nothing.
    client.ext('performance').startTransaction({ name: 'ambient', operation: 'custom' });
    await (globalThis as { fetch: (i: unknown, init?: unknown) => Promise<unknown> }).fetch(
      'https://target.test/api',
      { method: 'GET' },
    );
    expect(
      (received?.init as { headers?: Record<string, string> }).headers?.traceparent,
    ).toBeUndefined();
  });

  it('produce-tee on Node sets the §5 scope name com.bugsee.nodejs/performance', async () => {
    const { scheduler, fire } = fakeScheduler();
    const otlpBodies: string[] = [];
    const transport = vi.fn<HttpTransport>(async (url: string, opts: HttpRequestOptions = {}) => {
      if (url.endsWith('/v2/sessions')) {
        return { status: 200, headers: {}, body: jsonBody({ access_token: 'tok' }) };
      }
      if (url.endsWith('/v1/traces')) {
        otlpBodies.push(opts.body as string);
      }
      return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
    });
    track(
      launch(
        'tok',
        base({
          carrier: {},
          scheduler,
          transport,
          performanceFlushIntervalMs: 7777,
          appStartTimeMs: 1000,
          otelExportUrl: 'https://collector.test/v1/traces',
        }),
      ),
    );
    await fire(7777); // flush → the app.start transaction tees to /v1/traces
    const body = JSON.parse(otlpBodies[0] ?? '{}');
    expect(body.resourceSpans[0].scopeSpans[0].scope.name).toBe('com.bugsee.nodejs/performance');
  });

  it('a repeat launch returns the same client (singleton) and does not re-wire', () => {
    const carrier = {};
    const first = track(launch('tok', base({ carrier, appStartTimeMs: 1000 })));
    const second = launch('tok', base({ carrier, appStartTimeMs: 1000 }));
    expect(second).toBe(first);
  });

  it('the node LaunchInternals key the umbrella reads is present, at the right type (R-16)', () => {
    // The umbrella reads `internals.activeSpanStore` optionally (the browser omits it), so a rename
    // or drop on the node side would vanish to the single slot with NO type error (no
    // excess-property checking on variables). This fails compilation — not just a test — the day the
    // key stops existing on what launchCore hands back. The behavioural full-stack test above covers
    // today; this covers every future edit. Presence AND type: optionality-drift alone is harmless
    // (the umbrella tolerates absence), but a mistyped field would corrupt the handoff silently.
    type StoreField = NonNullable<LaunchResult['internals']>['activeSpanStore'];
    type Present = 'activeSpanStore' extends keyof NonNullable<LaunchResult['internals']>
      ? true
      : false;
    type SameType = StoreField extends ActiveSpanStore
      ? ActiveSpanStore extends StoreField
        ? true
        : false
      : false;
    const present: Present = true;
    const sameType: SameType = true;
    expect([present, sameType]).toEqual([true, true]);
  });

  it('the wired active slot is request-scoped: concurrent requests stay isolated (D2 part 2)', async () => {
    // Full stack through every threading link: node launchCore internals → wireUmbrella →
    // wirePerformance → extension → controller → the request-context store. If ANY link dropped
    // the store, the controller would fall back to the process-wide single slot and request A's
    // read below would see request B's transaction (or nothing, after B finished and cleared it).
    const client = track(launch('tok', base({ carrier: {}, appStartTimeMs: 1000 })));
    const perf = client.ext('performance');
    const contexts = client.getService(RequestContextStoreToken);
    const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const names: string[] = [];
    const request = async (id: string, route: string, delayMs: number): Promise<void> => {
      await contexts.run({ contextId: id }, async () => {
        const own = perf.startTransaction({ name: `GET ${id}`, operation: 'http.server' });
        await tick(delayMs); // yield so the sibling request starts before reading back
        expect(perf.getActiveSpan()).toBe(own); // still ours, not the sibling's
        perf.setRouteName(route); // must rename OURS, not the sibling's
        names.push(own.getName());
        own.finish('OK');
      });
    };
    await Promise.all([request('A', '/a/:id', 20), request('B', '/b/:id', 5)]);
    expect(names.sort()).toEqual(['/a/:id', '/b/:id']); // no rename crossed requests
  });
});
