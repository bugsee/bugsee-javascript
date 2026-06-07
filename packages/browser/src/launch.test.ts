import 'fake-indexeddb/auto'; // polyfills IDBKeyRange et al.; per-test `vi.stubGlobal('indexedDB', …)` still isolates
import {
  type AsyncBlobStore,
  createIdbBlobStore,
  createIdbChunkBackend,
  createIdbKeyedStore,
  createPersistentBundleStore,
} from '@bugsee/browser-utils';
import {
  type BundleStore,
  BundleStoreToken,
  CaptureStoreToken,
  contributeServiceManifest,
  createCaptureExporter,
  createMemoryCaptureStore,
  createReportingRequest,
  defineService,
  getCarrier,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  ReportMarkerStoreToken,
  type StoredEntry,
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
import { strFromU8, unzipSync } from '@bugsee/util';
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

  it('captures a document interaction (click) as an events.user entry', async () => {
    const store = memStore();
    const doc = fakeWindow();
    launchTracked('tok', baseOptions({ captureStore: store, document: doc.win }));
    doc.emit('click', {
      target: {
        tagName: 'BUTTON',
        getAttribute: () => null,
        closest: () => null,
        textContent: 'Buy',
      },
      clientX: 3,
      clientY: 4,
      button: 0,
    });
    const events = await drain(store, 'events.user');
    const click = events?.find((e) => (e.data as { name: string }).name === 'click');
    expect((click?.data as { params: unknown }).params).toEqual({
      target: { tag: 'button', text: 'Buy', selector: 'button' },
      x: 3,
      y: 4,
      button: 0,
    });
  });

  it('does not capture interactions when captureInteractions is disabled', async () => {
    const store = memStore();
    const doc = fakeWindow();
    launchTracked(
      'tok',
      baseOptions({ captureStore: store, captureInteractions: false, document: doc.win }),
    );
    doc.emit('click', {
      target: { tagName: 'BUTTON', getAttribute: () => null, closest: () => null },
      clientX: 0,
      clientY: 0,
      button: 0,
    });
    expect(await drain(store, 'events.user')).toBeUndefined();
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
    expect(reg.get('browser-input')).toBeDefined();
    // console + browser-input + the 5 cross-runtime network leaves (fetch/xhr/websocket/sse/
    // webtransport) = 7. No node-http.
    expect(reg.size).toBe(7);
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

  it('persist:true wraps the capture store in an IndexedDB-backed persistent store', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    // No captureStore override → launch builds the persistent capture store (db 'bugsee-capture').
    const client = launchTracked('tok', baseOptions({ persist: true }));
    expect(client.isLaunched()).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // let async hydration settle
  });

  it('threads onError into the persistent capture store', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = launchTracked('tok', baseOptions({ persist: true, onError: vi.fn() }));
    expect(client.isLaunched()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('persist:true actually persists a captured part to the bugsee-capture database', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const tickCbs: Array<() => void> = [];
    const scheduler = {
      setInterval: (cb: () => void) => {
        tickCbs.push(cb);
        return 'h';
      },
      clearInterval: () => {},
    };
    launchTracked('tok', baseOptions({ persist: true, scheduler })); // no captureStore override
    console.log('persist-me');
    await new Promise((r) => setTimeout(r, 0)); // let the log reach the store (persisted as captured)
    for (const cb of tickCbs) cb(); // a tick closes the part (rewrites its durable meta)
    await vi.waitFor(async () => {
      // The durable chunk store writes data + meta records to the 'capture' store as entries are captured.
      const records = await createIdbBlobStore({
        databaseName: 'bugsee-capture',
        storeName: 'capture',
      }).loadAll();
      expect(records.length).toBeGreaterThan(0); // a plain memory store would persist nothing here
    });
  });
});

// --- capture recovery (BR2): a prior run's detected incident is rebuilt + delivered next launch -------

// A transport that satisfies the upload path AND records every signed-PUT body (the delivered bundle).
function recordingTransport() {
  const puts: Uint8Array[] = [];
  const fn = vi.fn<HttpTransport>(async (url: string, options: HttpRequestOptions = {}) => {
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
    if (url === 'https://s3.test/put') {
      puts.push(options.body as Uint8Array);
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, puts };
}

const recoveryClock = { wallNow: () => 1000, monotonicNow: () => 0 }; // launch generation 1000
// No-op scheduler: the live store never ticks, so the live generation is created once (openPart) and
// never re-created after a sweep — making "the live generation survives recovery" deterministic.
const noopScheduler = { setInterval: () => 'h', clearInterval: () => {} };
const logRecord = (data: unknown): StoredEntry => ({
  type: 'log',
  timestamp: 1,
  serialized: JSON.stringify({ timestamp: 1, data }),
});
// The generations present in the bugsee-capture meta keyspace (`m/<gen13>/<chunk12>`).
const captureGenerations = async (): Promise<Set<number>> => {
  const metas = await createIdbKeyedStore({
    databaseName: 'bugsee-capture',
    storeName: 'capture',
  }).readPrefix('m/');
  return new Set(metas.map(([key]) => Number(key.slice(2, key.indexOf('/', 2)))));
};
const persistedMarkers = (): Promise<Array<[string, Uint8Array]>> =>
  createIdbBlobStore({ databaseName: 'bugsee-markers', storeName: 'markers' }).loadAll();

// Seed a prior generation's closed chunk + (optionally) a pending marker into the (stubbed) IndexedDB.
async function seedPrior(gen: number, data: unknown, withMarker: boolean): Promise<void> {
  const backend = createIdbChunkBackend(
    createIdbKeyedStore({ databaseName: 'bugsee-capture', storeName: 'capture' }),
    { generation: gen, cleanOtherGenerations: false },
  );
  backend.openPart({ generation: gen, number: 0 }, gen);
  backend.appendEntry({ generation: gen, number: 0 }, logRecord(data));
  backend.closePart({ generation: gen, number: 0 }, gen + 100, 0);
  await backend.listGenerations(); // drain the async write queue
  if (withMarker) {
    const marker = {
      generation: gen,
      request: createReportingRequest({ source: { type: 'crash' }, id: 'inc-1' }),
      attributes: {},
      userIdentifier: null,
    };
    await createIdbBlobStore({ databaseName: 'bugsee-markers', storeName: 'markers' }).put(
      'inc-1',
      new TextEncoder().encode(JSON.stringify(marker)),
    );
  }
}

describe('launch — capture recovery', () => {
  it('rebuilds + uploads a prior incident, sweeps its generation + marker, keeps the live generation', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await seedPrior(500, { m: 'pre-crash' }, true); // prior gen 500 (≠ launch gen 1000)
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({ transport, persist: true, clock: recoveryClock, scheduler: noopScheduler }),
    );

    // The recovered bundle is uploaded (the only thing that triggers a signed PUT here).
    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
    const files = unzipSync(puts[0] as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([{ m: 'pre-crash' }]);
    expect(strFromU8(files.apptoken as Uint8Array)).toBe('tok');

    // The incident marker is cleared, gen 500 swept, and the live gen 1000 survives.
    await vi.waitFor(async () => expect(await persistedMarkers()).toEqual([]));
    await vi.waitFor(async () => {
      const gens = await captureGenerations();
      expect(gens.has(500)).toBe(false); // recovered + swept
      expect(gens.has(1000)).toBe(true); // the live generation is never swept
    });
  });

  it('sweeps a no-incident prior generation without uploading anything', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await seedPrior(500, { m: 'orphan' }, false); // chunks, but NO marker
    const { fn: transport, puts } = recordingTransport();

    launchTracked('tok', baseOptions({ transport, persist: true, clock: recoveryClock }));

    await vi.waitFor(async () => expect((await captureGenerations()).has(500)).toBe(false));
    expect(puts).toEqual([]); // no incident → no report
  });

  it('writes a recovery marker for a live incident through the launch wiring', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = launchTracked('tok', baseOptions({ persist: true, clock: recoveryClock }));
    const putSpy = vi.spyOn(client.getService(ReportMarkerStoreToken), 'put');

    await client.logException(new Error('live boom'));

    expect(putSpy).toHaveBeenCalledTimes(1);
    const marker = putSpy.mock.calls[0]?.[0];
    expect(marker?.generation).toBe(1000); // this launch's capture generation
    expect(marker?.request.report.summary).toBe('live boom');
  });

  it('defers capture recovery until the durable bundle-queue recover() has run (no double-upload race)', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await seedPrior(500, { m: 'x' }, true); // a marker to recover
    const { fn: transport, puts } = recordingTransport();
    // A bundle store whose hydration (and thus durable.recover()) stays PENDING until released.
    let releaseBundle: () => void = () => {};
    const bundleStore: BundleStore & { whenReady: Promise<void> } = {
      whenReady: new Promise<void>((resolve) => {
        releaseBundle = resolve;
      }),
      put: () => {},
      list: () => [],
      read: () => undefined,
      remove: () => {},
    };
    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        bundleStore,
      }),
    );

    await new Promise((r) => setTimeout(r, 20)); // the marker mirror hydrates within this window
    expect(puts).toEqual([]); // capture recovery is gated on the (pending) bundle-queue recover()
    releaseBundle(); // bundle store hydrates → durable.recover() runs → capture recovery may proceed
    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1)); // now the rebuilt bundle uploads
  });

  it('registers the marker store as a service in persist (recovery) mode', () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = launchTracked('tok', baseOptions({ persist: true }));
    expect(typeof client.getService(ReportMarkerStoreToken).put).toBe('function');
  });

  it('builds no marker store without persist', () => {
    const client = launchTracked('tok', baseOptions({})); // in-memory store
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
  });

  it('builds no marker store when a captureStore overrides the IndexedDB backend', () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = launchTracked('tok', baseOptions({ persist: true, captureStore: memStore() }));
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
  });

  it('does not recover when recover:false (no marker store, no upload)', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await seedPrior(500, { m: 'x' }, true);
    const { fn: transport, puts } = recordingTransport();
    const client = launchTracked(
      'tok',
      baseOptions({ transport, persist: true, recover: false, clock: recoveryClock }),
    );
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(puts).toEqual([]);
  });
});
