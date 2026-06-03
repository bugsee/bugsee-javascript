import {
  type AsyncBlobStore,
  createIdbBlobStore,
  createPersistentBundleStore,
} from '@bugsee/browser-utils';
import {
  type BundleStore,
  BundleStoreToken,
  CaptureStoreToken,
  contributeServiceManifest,
  createCaptureExporter,
  createMemoryCaptureStore,
  defineService,
  getCarrier,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  serializeBundle,
  serviceToken,
  TransportToken,
} from '@bugsee/core';
import {
  BugseeOption,
  type EnvironmentEnvelope,
  type FileType,
  optionKeyToWire,
  type RequestJson,
  Severity,
} from '@bugsee/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserProbe, BrowserProbeToken } from './environment';
import { type BugseeLaunchOptions, launch } from './launch';

// A test-only contributed service token (an "extension").
const DemoExtToken = serviceToken<{ storeIsRegistered: boolean }>('demoExt');

// --- fakes ---------------------------------------------------------------------------------------

function fakeWindow() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const win = {
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    win,
    emit: (type: string, event: unknown) => {
      for (const l of [...(listeners.get(type) ?? [])]) {
        l(event as Event);
      }
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
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
// A transport that satisfies the full upload path (session → issue → signed PUT) and records calls.
function uploadTransport() {
  return vi.fn<HttpTransport>(async (url: string, _options: HttpRequestOptions = {}) => {
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
}

// --- harness -------------------------------------------------------------------------------------

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const launchTracked = (token: string, options: BugseeLaunchOptions) => {
  const client = launch(token, options);
  clients.push(client);
  return client;
};

// Common injected seams: deterministic, no real network/perf; network capture off so the real
// fetch/XMLHttpRequest globals are never patched in unit tests.
const baseOptions = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  window: fakeWindow().win,
  transport: uploadTransport(),
  systemProbe: probe,
  systemMetricsSampler: () => [{ name: 'browser_memory_used_heap', value: 42 }],
  captureNetwork: false,
  ...over,
});

const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });

const drain = async (store: ReturnType<typeof createMemoryCaptureStore>, type: FileType) =>
  (await createCaptureExporter(store).drain()).get(type);

function bundleMemStore() {
  const map = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const store: BundleStore = {
    put: (id, bytes) => {
      puts.push(id);
      map.set(id, bytes);
    },
    list: () => [...map.keys()],
    read: (id) => map.get(id),
    remove: (id) => {
      map.delete(id);
    },
  };
  return { store, map, puts };
}

const pendingBundle = (summary: string): Uint8Array => {
  const request: RequestJson = {
    type: 'crash',
    summary,
    severity: Severity.Blocker,
    source: { mechanism: 'uncaught' },
    created_on: '2026-06-02T00:00:00Z',
    environment: {
      platform: { type: 'web', version: '1' },
      sdk: { version: '0', type: 'javascript' },
    },
  };
  return serializeBundle({
    request,
    body: new Uint8Array([0x50, 0x4b, 1]),
    fileName: 'recovered.zip',
  });
};

describe('launch', () => {
  it('returns a launched client', () => {
    const client = launchTracked('tok', baseOptions({ captureStore: memStore() }));
    expect(client.isLaunched()).toBe(true);
  });

  it('registers the fetch transport as a resolvable service that internal-tags requests', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    const svc = client.getService(TransportToken);
    expect(typeof svc).toBe('function');
    await svc('https://x.test/v2/sessions', { headers: { 'x-custom': 'keep' } });
    const lastCall = transport.mock.calls.at(-1);
    const headers = (lastCall?.[1] as HttpRequestOptions).headers;
    expect(headers?.['x-bugsee-internal']).toBe('1');
    expect(headers?.['x-custom']).toBe('keep'); // caller headers are MERGED, not replaced
  });

  it('uses the default fetch transport when none is injected', () => {
    const client = launchTracked(
      'tok',
      baseOptions({ transport: undefined, captureStore: memStore() }),
    );
    expect(typeof client.getService(TransportToken)).toBe('function');
  });

  it('wires an injected clock + scheduler and the default store/sampler when overrides are omitted', () => {
    const fixedClock = { wallNow: () => 1000, monotonicNow: () => 0 };
    const calls: Array<{ cb: () => void; ms: number }> = [];
    const scheduler = {
      setInterval: (cb: () => void, ms: number) => {
        calls.push({ cb, ms });
        return 'h';
      },
      clearInterval: () => {},
    };
    const client = launchTracked(
      'tok',
      baseOptions({
        captureStore: undefined, // → default in-memory store (+ its clock spread)
        systemMetricsSampler: undefined, // → default performance.memory sampler
        clock: fixedClock,
        scheduler,
      }),
    );
    expect(client.isLaunched()).toBe(true);
    expect(calls.length).toBeGreaterThan(0); // scheduler drove the capture-store tick / traces sampling
  });

  it('falls back to the global window, realBrowserProbe, and the default store when nothing is injected', () => {
    const w = fakeWindow();
    vi.stubGlobal('window', w.win);
    vi.stubGlobal('navigator', { userAgent: 'Real-UA' });
    vi.stubGlobal('screen', { width: 100, height: 200 });
    const client = launchTracked(
      'tok',
      baseOptions({
        window: undefined, // → global window
        systemProbe: undefined, // → realBrowserProbe
        captureStore: undefined, // → default in-memory store (no clock spread)
        systemMetricsSampler: undefined, // → default performance.memory sampler
      }),
    );
    expect(client.isLaunched()).toBe(true);
    expect(w.count('error')).toBe(1); // detection wired to the resolved global window
  });

  it('registers the systemProbe and captureStore as resolvable services', () => {
    const store = memStore();
    const client = launchTracked('tok', baseOptions({ systemProbe: probe, captureStore: store }));
    expect(client.getService(BrowserProbeToken)).toBe(probe);
    expect(client.getService(CaptureStoreToken)).toBe(store);
  });

  it('registers an injected bundleStore as the resolvable service (by identity)', () => {
    const { store } = bundleMemStore();
    const client = launchTracked(
      'tok',
      baseOptions({ bundleStore: store, captureStore: memStore() }),
    );
    expect(client.getService(BundleStoreToken)).toBe(store);
  });

  it('does not register bundleStore in in-memory mode', () => {
    const client = launchTracked('tok', baseOptions({ captureStore: memStore() }));
    expect(() => client.getService(BundleStoreToken)).toThrow();
  });

  it('runs a carrier-contributed service manifest against the launched container', () => {
    contributeServiceManifest((internal) => {
      internal.addService(
        defineService(DemoExtToken, () => ({
          storeIsRegistered: internal.getService(CaptureStoreToken) !== undefined,
        })),
      );
    });
    const client = launchTracked('tok', baseOptions({ captureStore: memStore() }));
    expect(client.getService(DemoExtToken)).toEqual({ storeIsRegistered: true });
  });

  it('captures console output as log entries (captureLogs default on)', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store }));
    console.log('hello-from-browser-launch');
    const logs = await drain(store, 'log');
    expect(logs?.some((e) => JSON.stringify(e.data).includes('hello-from-browser-launch'))).toBe(
      true,
    );
  });

  it('applies a log filter set on the returned client', async () => {
    const store = memStore();
    const client = launchTracked('tok', baseOptions({ captureStore: store }));
    client.setLogEventFilter((e) => ({ ...e, message: e.message.replace('secret', '***') }));
    console.log('my secret data');
    const logs = await drain(store, 'log');
    expect(logs?.some((e) => JSON.stringify(e.data).includes('***'))).toBe(true);
    expect(logs?.some((e) => JSON.stringify(e.data).includes('secret'))).toBe(false);
  });

  it('does not capture console output when captureLogs is disabled', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store, captureLogs: false }));
    console.log('not-captured-by-browser-launch');
    expect(await drain(store, 'log')).toBeUndefined();
  });

  it('records the process_started system event on launch', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store }));
    const events = await drain(store, 'events.system');
    expect(events?.map((e) => (e.data as { name: string }).name)).toContain('process_started');
  });

  it('takes an initial system-traces sample from the injected sampler', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store }));
    const traces = await drain(store, 'traces.system');
    expect(traces?.map((e) => (e.data as { name: string }).name)).toContain(
      'browser_memory_used_heap',
    );
  });

  it('does not capture system traces when disabled', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store, captureSystemTraces: false }));
    expect(await drain(store, 'traces.system')).toBeUndefined();
  });

  it('wires the network capture provider (captureNetwork on): a fetch yields a network entry', async () => {
    const slot = globalThis as unknown as {
      fetch?: (i: unknown, init?: unknown) => Promise<unknown>;
    };
    const real = slot.fetch;
    slot.fetch = async () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: { forEach: () => {} },
      clone: () => ({ body: null }),
    });
    const store = memStore();
    try {
      launchTracked('tok', baseOptions({ captureNetwork: true, captureStore: store }));
      await (slot.fetch as (i: unknown) => Promise<unknown>)('https://x.test/');
      await new Promise((r) => setTimeout(r, 0));
      const net = await drain(store, 'network');
      expect(net?.length ?? 0).toBeGreaterThan(0); // provider wired → the fetch was captured
    } finally {
      slot.fetch = real;
    }
  });

  it('passes onError to the client (a throwing log filter routes its error to onError)', async () => {
    const store = memStore();
    const onError = vi.fn();
    const client = launchTracked('tok', baseOptions({ captureStore: store, onError }));
    client.setLogEventFilter(() => {
      throw new Error('filter boom');
    });
    console.log('triggers the throwing filter');
    await drain(store, 'log');
    expect(onError).toHaveBeenCalled(); // the client received launch's onError sink
  });

  it('registers window error + unhandledrejection detection providers on the window', () => {
    const w = fakeWindow();
    launchTracked('tok', baseOptions({ window: w.win, captureStore: memStore() }));
    expect(w.count('error')).toBe(1);
    expect(w.count('unhandledrejection')).toBe(1);
  });

  it('registers no detection listeners when detectCrashes is false', () => {
    const w = fakeWindow();
    launchTracked(
      'tok',
      baseOptions({ window: w.win, captureStore: memStore(), detectCrashes: false }),
    );
    expect(w.count('error')).toBe(0);
    expect(w.count('unhandledrejection')).toBe(0);
  });

  it('removes the detection listeners on stop', async () => {
    const w = fakeWindow();
    const client = launch('tok', baseOptions({ window: w.win, captureStore: memStore() }));
    expect(w.count('error')).toBe(1);
    await client.stop();
    expect(w.count('error')).toBe(0);
    expect(w.count('unhandledrejection')).toBe(0);
  });

  it('tags every SDK request with X-Bugsee-Internal and targets the default endpoint', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    await client.logException(new Error('x'));
    expect(transport.mock.calls[0]?.[0]).toBe('https://api.bugsee.com/v2/sessions');
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    expect((put?.[1] as HttpRequestOptions).headers?.['x-bugsee-internal']).toBe('1');
  });

  it('honours a custom endpoint', async () => {
    const transport = uploadTransport();
    const client = launchTracked(
      'tok',
      baseOptions({ transport, captureStore: memStore(), endpoint: 'https://eu.bugsee.test' }),
    );
    await client.logException(new Error('x'));
    expect(transport.mock.calls[0]?.[0]).toBe('https://eu.bugsee.test/v2/sessions');
  });

  it('builds a web environment envelope with sdk version, gates, and app defaults', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    await client.logException(new Error('x'));
    const env = (
      JSON.parse(String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body)) as {
        environment: EnvironmentEnvelope;
      }
    ).environment;
    expect(env.platform.type).toBe('web');
    expect(env.platform.version).toBe('Mozilla/5.0 (Test) Browser/9.0');
    expect(env.sdk.options).toMatchObject({
      [optionKeyToWire(BugseeOption.CaptureLogs)]: true,
      [optionKeyToWire(BugseeOption.CaptureNetwork)]: false,
    });
    expect(env.app?.package_id).toBe('unknown');
  });

  it('reports maxDataSize (default 10 MB) in the wire-form sdk.options, and honors an override', async () => {
    const sdkOptions = async (over: Partial<BugseeLaunchOptions>) => {
      const transport = uploadTransport();
      const client = launchTracked(
        'tok',
        baseOptions({ transport, captureStore: memStore(), carrier: {}, ...over }),
      );
      await client.logException(new Error('x'));
      return (
        JSON.parse(String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body)) as {
          environment: EnvironmentEnvelope;
        }
      ).environment.sdk.options as Record<string, unknown>;
    };
    expect((await sdkOptions({}))[optionKeyToWire(BugseeOption.MaxDataSize)]).toBe(10);
    expect((await sdkOptions({ maxDataSize: 7 }))[optionKeyToWire(BugseeOption.MaxDataSize)]).toBe(
      7,
    );
  });

  it('passes app identity through to the environment', async () => {
    const transport = uploadTransport();
    const client = launchTracked(
      'tok',
      baseOptions({
        transport,
        captureStore: memStore(),
        appId: 'com.acme.web',
        appVersion: '2.0',
        appBuild: '9',
      }),
    );
    await client.logException(new Error('x'));
    const env = (
      JSON.parse(String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body)) as {
        environment: EnvironmentEnvelope;
      }
    ).environment;
    expect(env.app).toMatchObject({ package_id: 'com.acme.web', version: '2.0', build: '9' });
  });

  it('registers the process-global interceptor singletons on the carrier (one patch each)', () => {
    const carrier = {};
    launchTracked('tok', baseOptions({ captureStore: memStore(), carrier }));
    const reg = getCarrier(carrier).interceptors;
    expect(reg.get('console')).toBeDefined();
    expect(reg.get('fetch')).toBeDefined();
    // console + the 5 cross-runtime network leaves (fetch/xhr/websocket/sse/webtransport) = 6. No node-http.
    expect(reg.size).toBe(6);
  });

  it('is a per-process singleton: a second launch() warns, is ignored, and returns the first', () => {
    const carrier = {};
    const onError = vi.fn();
    const first = launchTracked('tok', baseOptions({ captureStore: memStore(), carrier, onError }));
    const second = launchTracked(
      'tok',
      baseOptions({ captureStore: memStore(), carrier, onError }),
    );
    expect(second).toBe(first);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('recovers (re-uploads) a bundle a prior run left in the durable store', async () => {
    const { store, map } = bundleMemStore();
    const id = 'leftover-1';
    map.set(id, pendingBundle('a prior crash'));
    const transport = uploadTransport();
    // onError passed alongside a bundleStore so the durable pipeline's onError wiring is exercised.
    launchTracked(
      'tok',
      baseOptions({ transport, bundleStore: store, captureStore: memStore(), onError: vi.fn() }),
    );
    await vi.waitFor(() => expect(map.has(id)).toBe(false)); // recovered → uploaded → removed
    expect(transport.mock.calls.some(([url]) => url === 'https://s3.test/put')).toBe(true);
  });

  it('does not recover when recover is false (the leftover bundle stays)', async () => {
    const { store, map } = bundleMemStore();
    const id = 'leftover-2';
    map.set(id, pendingBundle('a prior crash'));
    launchTracked(
      'tok',
      baseOptions({ bundleStore: store, captureStore: memStore(), recover: false }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(map.has(id)).toBe(true); // never recovered
  });

  it('persists then removes a bundle through the durable queue on a successful upload', async () => {
    const { store, puts, map } = bundleMemStore();
    const transport = uploadTransport();
    const client = launchTracked(
      'tok',
      baseOptions({ transport, bundleStore: store, captureStore: memStore() }),
    );
    await client.logException(new Error('boom'));
    await vi.waitFor(() => expect(puts.length).toBeGreaterThan(0)); // persisted before upload
    await vi.waitFor(() => expect(map.size).toBe(0)); // removed after a successful upload
  });

  it('defers recovery until an async (persistent) bundle store has hydrated', async () => {
    // A persistent store with controllable hydration: recover() must wait for whenReady so list() sees
    // the leftover (a synchronous store recovers immediately and would miss a not-yet-hydrated one).
    let resolveLoad: (entries: Array<[string, Uint8Array]>) => void = () => {};
    const blob: AsyncBlobStore = {
      loadAll: () => new Promise((resolve) => (resolveLoad = resolve)),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const store = createPersistentBundleStore(blob);
    const transport = uploadTransport();
    launchTracked('tok', baseOptions({ transport, bundleStore: store, captureStore: memStore() }));
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.mock.calls.some(([url]) => url === 'https://s3.test/put')).toBe(false);
    resolveLoad([['left', pendingBundle('prior reload')]]); // hydration surfaces a leftover
    await vi.waitFor(() =>
      expect(transport.mock.calls.some(([url]) => url === 'https://s3.test/put')).toBe(true),
    );
  });

  it('persist:true builds an IndexedDB bundle store and recovers a leftover across a reload', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await createIdbBlobStore().put('left-1', pendingBundle('prior crash')); // a prior run's leftover
    const transport = uploadTransport();
    launchTracked('tok', baseOptions({ transport, persist: true, captureStore: memStore() }));
    await vi.waitFor(() =>
      expect(transport.mock.calls.some(([url]) => url === 'https://s3.test/put')).toBe(true),
    );
  });
});
