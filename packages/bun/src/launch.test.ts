import process from 'node:process';
import {
  type Clock,
  createCaptureExporter,
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  type Scheduler,
} from '@bugsee/core';
import { createNodeSystemTraceProducers, type NodeRuntime, type SystemProbe } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bunSystemProbe } from './environment';
import { launch, launchCore } from './launch';

// Pass-through spy: pins the wiring (Bun measures event-loop delay, so it must NOT opt out) without
// changing behaviour.
vi.mock('@bugsee/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/node')>();
  return {
    ...actual,
    createNodeSystemTraceProducers: vi.fn(actual.createNodeSystemTraceProducers),
  };
});

// --- fakes: no real process / network / timers --------------------------------------------------

function fakeProcess(): NodeRuntime {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const proc: NodeRuntime = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return proc;
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return proc;
    },
    exit: vi.fn(),
  };
  return proc;
}

const jsonBody = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));

// A transport that satisfies the full upload path (session → issue → signed PUT) and records calls.
function uploadTransport() {
  return vi.fn<HttpTransport>(async (url: string, _o: HttpRequestOptions = {}) => {
    if (url.endsWith('/v2/sessions')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ access_token: 'a' }),
      } satisfies HttpResponse;
    }
    if (url.endsWith('/v2/issues')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
      } satisfies HttpResponse;
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
}

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };
const fakeScheduler: Scheduler = { setInterval: () => 'h', clearInterval: () => {} };
const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });

const base = (over: Partial<Parameters<typeof launch>[1]> = {}): Parameters<typeof launch>[1] => ({
  process: fakeProcess(),
  transport: uploadTransport(),
  clock: fixedClock,
  scheduler: fakeScheduler,
  captureNetwork: false,
  captureSystemTraces: false,
  detectHangs: false, // no real watchdog worker in unit tests
  captureStore: memStore(),
  carrier: {}, // fresh per launch → the per-process singleton guard never collides across tests
  ...over,
});

// Every test starts from a clean factory spy, so a call recorded by an earlier launch can never satisfy
// (or break) a later test's assertion on the call count / argument.
beforeEach(() => {
  vi.mocked(createNodeSystemTraceProducers).mockClear();
});

const clients: Array<{ stop: (t?: number) => Promise<boolean> }> = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const track = <T extends { stop: (t?: number) => Promise<boolean> }>(c: T): T => {
  clients.push(c);
  return c;
};

describe('@bugsee/bun launch', () => {
  it('injects the node trace producers (not a legacy sampler) and they feed traces.system', async () => {
    vi.mocked(createNodeSystemTraceProducers).mockClear();
    const store = memStore();
    track(launchCore('tok', base({ captureStore: store, captureSystemTraces: true })).client);
    const produced = vi.mocked(createNodeSystemTraceProducers).mock.results[0]?.value as unknown[];
    expect(Array.isArray(produced)).toBe(true);
    expect(produced.length).toBeGreaterThan(0);
    for (const p of produced) {
      expect(typeof (p as { start: unknown }).start).toBe('function');
      expect(typeof (p as { stop: unknown }).stop).toBe('function');
    }
    const traces = (await createCaptureExporter(store).drain()).get('traces.system') ?? [];
    const names = traces.map((e) => (e.data as { name: string }).name);
    expect(names).toContain('process_memory_rss');
    expect(names).toContain('ram_system_total');
    expect(names).toContain('cpu_usage_process');
  });

  it('opts out of the V8 heap and available-memory traces (Bun: JSC heap, not comparable availableMemory)', () => {
    track(launchCore('tok', base()).client);
    expect(createNodeSystemTraceProducers).toHaveBeenCalledWith(
      expect.objectContaining({ measuresV8Heap: false, measuresAvailableMemory: false }),
    );
  });

  it('does not opt out of event-loop delay (Bun measures it)', () => {
    track(launchCore('tok', base()).client);
    expect(createNodeSystemTraceProducers).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(createNodeSystemTraceProducers).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg).not.toHaveProperty('measuresEventLoopDelay'); // the node default (true) applies
    expect(arg?.scheduler).toBe(fakeScheduler); // only the launch seams are forwarded
  });
  it('reports the Bun RUNTIME identity in the environment envelope', () => {
    const { client, internals } = launchCore('tok', base());
    track(client);
    expect(internals).toBeDefined();
    const env = internals?.getEnvironment();
    expect(env?.runtime.type).toBe('bun');
    expect(env?.runtime.version).toBe(process.versions.bun ?? process.versions.node);
  });

  it('defaults the system probe to the Bun probe but lets the caller override it', () => {
    const nodeProbe: SystemProbe = {
      ...bunSystemProbe,
      platformType: () => 'node',
      runtimeVersion: () => '20.0.0',
    };
    const { client, internals } = launchCore('tok', base({ systemProbe: nodeProbe }));
    track(client);
    // The caller-supplied probe wins over the Bun default (it spreads after it).
    expect(internals?.getEnvironment().runtime.type).toBe('node');
    expect(internals?.getEnvironment().runtime.version).toBe('20.0.0');
  });

  it('uploads a report carrying the Bun environment on the wire (end-to-end via the node composition)', async () => {
    const transport = uploadTransport();
    const client = track(launch('tok', base({ transport })));
    await client.logException(new Error('boom'));
    // The session create carries the environment …
    expect(transport.mock.calls[0]?.[0]).toMatch(/\/v2\/sessions$/);
    const session = JSON.parse(
      String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body),
    ) as { environment: { runtime: { type: string } } };
    expect(session.environment.runtime.type).toBe('bun');
    // … and the actual report BUNDLE (the signed PUT zip) embeds the Bun environment in request.json.
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    expect(put).toBeDefined();
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    const requestJson = JSON.parse(strFromU8(files['request.json'] as Uint8Array)) as {
      environment: { runtime: { type: string; version: string } };
    };
    expect(requestJson.environment.runtime.type).toBe('bun');
    expect(requestJson.environment.runtime.version).toBe(
      process.versions.bun ?? process.versions.node,
    );
  });

  it('launch() returns the working public client launchCore() builds', () => {
    const client = track(launch('tok', base()));
    expect(typeof client.logException).toBe('function');
    expect(typeof client.stop).toBe('function');
  });

  it('wires the Bun.serve native wrap (patch + restore) and a wrapped request resolves the carrier client', async () => {
    type Served = { fetch?: (req: unknown) => unknown };
    type G = { Bun?: { serve: (o: Served) => unknown } };
    const served: Served[] = [];
    const realServe = vi.fn((o: Served) => {
      served.push(o);
      return { stop() {} };
    });
    (globalThis as G).Bun = { serve: realServe };
    const client = launch('tok', base({ instrumentIncomingRequests: true })); // untracked — stopped below
    try {
      expect((globalThis as G).Bun?.serve).not.toBe(realServe); // patched
      // a Bun.serve({fetch}) call gets its handler wrapped; running it resolves the carrier client
      (globalThis as G).Bun?.serve({ fetch: async () => ({ status: 200 }) });
      const wrappedFetch = served[0]?.fetch as (req: unknown) => Promise<{ status: number }>;
      const res = await wrappedFetch({ method: 'GET', url: '/x', headers: { get: () => null } });
      expect(res).toEqual({ status: 200 }); // wrap ran getClient -> the launched carrier client -> handler
      // a throwing handler re-throws through the FULL launch composition (error path, real carrier client)
      (globalThis as G).Bun?.serve({
        fetch: async () => {
          throw new Error('handler-boom');
        },
      });
      const throwingFetch = served[1]?.fetch as (req: unknown) => Promise<unknown>;
      await expect(
        throwingFetch({ method: 'GET', url: '/boom', headers: { get: () => null } }),
      ).rejects.toThrow('handler-boom');
      await client.stop();
      expect((globalThis as G).Bun?.serve).toBe(realServe); // restored on stop
    } finally {
      await client.stop(); // idempotent — guarantees teardown of the node:http + native patches
      delete (globalThis as G).Bun;
    }
  });

  it('forwards traceResponse → a wrapped Bun.serve response carries the return headers', async () => {
    type Served = { fetch?: (req: unknown) => unknown };
    type G = { Bun?: { serve: (o: Served) => unknown } };
    const served: Served[] = [];
    const realServe = vi.fn((o: Served) => {
      served.push(o);
      return { stop() {} };
    });
    (globalThis as G).Bun = { serve: realServe };
    const client = launch(
      'tok',
      base({ traceResponse: { traceresponse: true, serverTiming: true } }),
    );
    // A minimal performance ext on the carrier client so the http.server txn (hence the headers) exists.
    // getAttributes is a REQUIRED, non-throwing member of Span (server-instrument.ts's finishWith reads it
    // for the F-4 manual-rename check) — omitting it makes finishWith's getAttributes() call throw, which
    // is swallowed by finishWith's own try/catch, so setName/setAttribute/finish never run. See the
    // matching comment in express/src/middleware.test.ts's fakeTransaction.
    const txn = {
      getTraceId: () => 'trace-1',
      getSpanId: () => 'span-1',
      isSampled: () => true,
      isFinished: () => false,
      setName: vi.fn(),
      setAttribute: vi.fn(),
      getAttributes: vi.fn(() => ({})),
      finish: vi.fn(),
    };
    (client as unknown as { registerExt: (n: string, api: unknown) => void }).registerExt(
      'performance',
      { startTransaction: () => txn },
    );
    try {
      const set: Record<string, string> = {};
      (globalThis as G).Bun?.serve({
        fetch: async () => ({
          status: 200,
          headers: {
            set: (n: string, v: string) => {
              set[n] = v;
            },
          },
        }),
      });
      const wrappedFetch = served[0]?.fetch as (req: unknown) => Promise<unknown>;
      await wrappedFetch({ method: 'GET', url: '/x', headers: { get: () => null } });
      expect(set).toEqual({
        traceresponse: '00-trace-1-span-1-01',
        'Server-Timing': 'traceparent;desc="00-trace-1-span-1-01"',
      });
      // Proves finishWith actually ran end to end (not just the pre-finish header write): a
      // non-conforming double with no getAttributes() degrades finishWith silently (TypeError swallowed
      // by its own try/catch), so finish()/setName() never run.
      expect(txn.setName).toHaveBeenCalledWith('GET /x');
      expect(txn.finish).toHaveBeenCalledWith('OK');
    } finally {
      await client.stop();
      delete (globalThis as G).Bun;
    }
  });

  it('patches Bun.serve BY DEFAULT (no flag)', async () => {
    type G = { Bun?: { serve: unknown } };
    const realServe = vi.fn(() => ({ stop() {} }));
    (globalThis as G).Bun = { serve: realServe };
    const client = launch('tok', base());
    try {
      expect((globalThis as G).Bun?.serve).not.toBe(realServe); // patched without any flag (default-on)
    } finally {
      await client.stop();
      expect((globalThis as G).Bun?.serve).toBe(realServe); // restored on stop
      delete (globalThis as G).Bun;
    }
  });

  it('does NOT patch Bun.serve when instrumentIncomingRequests is false (escape hatch)', async () => {
    type G = { Bun?: { serve: unknown } };
    const realServe = vi.fn(() => ({ stop() {} }));
    (globalThis as G).Bun = { serve: realServe };
    const client = launch('tok', base({ instrumentIncomingRequests: false }));
    try {
      expect((globalThis as G).Bun?.serve).toBe(realServe); // untouched (opted out)
    } finally {
      await client.stop();
      delete (globalThis as G).Bun;
    }
  });
});

describe('@bugsee/bun — the launch scheduler / onError reach the trace tracker', () => {
  const recordingScheduler = () => {
    const calls: Array<{ cb: () => void; ms: number }> = [];
    const scheduler: Scheduler = {
      setInterval: (cb, ms) => {
        calls.push({ cb, ms });
        return `h${calls.length}`;
      },
      clearInterval: () => {},
    };
    return { calls, scheduler };
  };

  it('forwards the launch scheduler and onError into the producer factory', () => {
    vi.mocked(createNodeSystemTraceProducers).mockClear();
    const { scheduler } = recordingScheduler();
    const onError = vi.fn();
    track(launchCore('tok', base({ scheduler, onError })).client);
    expect(createNodeSystemTraceProducers).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(createNodeSystemTraceProducers).mock.calls[0]?.[0];
    expect(arg?.scheduler).toBe(scheduler);
    expect(arg?.onError).toBe(onError);
  });

  it('sampling runs on the injected scheduler: a fake tick produces a stats emit (no real timer)', async () => {
    const { calls, scheduler } = recordingScheduler();
    const store = memStore();
    track(
      launchCore('tok', base({ scheduler, captureStore: store, captureSystemTraces: true })).client,
    );
    const rss = async () =>
      ((await createCaptureExporter(store).drain()).get('traces.system') ?? []).filter(
        (e) => (e.data as { name: string }).name === 'process_memory_rss',
      ).length;
    expect(await rss()).toBe(1); // the start baseline
    for (const c of calls.filter((x) => x.ms === 1000)) c.cb();
    expect(await rss()).toBe(2);
  });

  it('a throwing reader during a poll reaches options.onError', () => {
    const { calls, scheduler } = recordingScheduler();
    const onError = vi.fn();
    track(launchCore('tok', base({ scheduler, onError, captureSystemTraces: true })).client);
    const spy = vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('memoryUsage boom');
    });
    try {
      for (const c of calls.filter((x) => x.ms === 1000)) c.cb();
    } finally {
      spy.mockRestore();
    }
    expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toContain('memoryUsage boom');
  });
});

describe('@bugsee/bun — captureSystemTraces:false attaches no trace sampling', () => {
  it('no sampling timer, no trace entries; enabling adds exactly the provider tick + the tracker timer', async () => {
    const launchWith = (captureSystemTraces: boolean) => {
      const calls: number[] = [];
      const store = memStore();
      const scheduler: Scheduler = {
        setInterval: (_cb, ms) => {
          calls.push(ms);
          return `h${calls.length}`;
        },
        clearInterval: () => {},
      };
      track(
        launchCore('tok', base({ scheduler, captureStore: store, captureSystemTraces })).client,
      );
      return { store, oneSecond: calls.filter((ms) => ms === 1000).length };
    };
    const off = launchWith(false);
    const on = launchWith(true);
    expect(on.oneSecond - off.oneSecond).toBe(2);
    expect((await createCaptureExporter(off.store).drain()).get('traces.system')).toBeUndefined();
  });
});
