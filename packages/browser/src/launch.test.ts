import 'fake-indexeddb/auto'; // polyfills IDBKeyRange et al.; per-test `vi.stubGlobal('indexedDB', …)` still isolates
import {
  type AsyncBlobStore,
  captureDatabaseName,
  coexistenceDatabaseName,
  createIdbBlobStore,
  createIdbChunkBackend,
  createIdbKeyedStore,
  createPersistentBundleStore,
  createPrefixedKeyedStore,
  createWebLockLiveness,
  instanceLockName,
  type LockManagerLike,
  markerDatabaseName,
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
import { type BugseeLaunchOptions, launch, launchCore } from './launch';

// Mock the lazy-loaded @bugsee/replay so replay tests don't spin up real rrweb; assert it's wired only when on.
const { registerReplay } = vi.hoisted(() => ({ registerReplay: vi.fn() }));
vi.mock('@bugsee/replay', () => ({ registerReplay }));
// Mock the lazy-loaded @bugsee/replay-canvas resolver (opt-in canvas add-on); assert it loads only when on.
const { createCanvasRecordConfig } = vi.hoisted(() => ({
  createCanvasRecordConfig: vi.fn(() => ({
    recordCanvas: true,
    sampling: { canvas: 2 },
    dataURLOptions: { type: 'image/webp', quality: 0.6 },
  })),
}));
vi.mock('@bugsee/replay-canvas', () => ({ createCanvasRecordConfig }));

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

// A minimal DOM element for the viewtree snapshot (tagName + the surfaces describeTarget/readRect use).
const viewEl = (tag: string, extra: Record<string, unknown> = {}) => ({
  tagName: tag.toUpperCase(),
  id: '',
  getAttribute: () => null,
  closest: () => null,
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  children: [] as unknown[],
  ...extra,
});

// A document fake combining the input-capture listener surface with a viewtree-snapshottable body.
const fakeDocument = (body: unknown) => ({ ...fakeWindow().win, body }) as unknown as Document;

const probe: BrowserProbe = {
  // A real Chrome-on-macOS agent: the environment builder now derives the OS and the browser from
  // this, so a synthetic string would make every environment assertion below meaningless.
  userAgent: () =>
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
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
  registerReplay.mockClear(); // vi.fn call history isn't cleared by restoreAllMocks
  createCanvasRecordConfig.mockClear();
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
  systemMetricsSampler: () => [{ name: 'ram_js_heap_used', value: 42 }],
  captureNetwork: false,
  ...over,
});

const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });

// An in-memory Web Locks fake (jsdom/node has no navigator.locks). Two sets, faithful to real `ifAvailable`
// semantics: `heldForever` = a LIVE instance's holdSelf lock; `inUse` = momentarily held during a
// recoverIfDead callback. A name in neither is "dead" (acquirable); `null` is yielded for a held/busy lock.
function fakeWebLocks(): LockManagerLike {
  const heldForever = new Set<string>();
  const inUse = new Set<string>();
  return {
    request(name, options, callback) {
      if (options.ifAvailable) {
        if (heldForever.has(name) || inUse.has(name)) return Promise.resolve(callback(null));
        inUse.add(name);
        return Promise.resolve(callback({ name })).finally(() => inUse.delete(name));
      }
      heldForever.add(name);
      void callback({ name });
      return new Promise<never>(() => {});
    },
  };
}

// The summary on the FIRST /v2/issues request body (request.json) — i.e. which bundle was delivered.
const issueSummary = (transport: ReturnType<typeof uploadTransport>): string | undefined => {
  const call = transport.mock.calls.find(([url]) => url.endsWith('/v2/issues'));
  if (call === undefined) return undefined;
  return (JSON.parse(String((call[1] as HttpRequestOptions).body)) as { summary?: string }).summary;
};

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

const pendingBundle = (summary: string, reportId?: string): Uint8Array => {
  const request: RequestJson = {
    type: 'crash',
    summary,
    severity: Severity.Blocker,
    source: { type: 'crash', mechanism: 'uncaught' },
    created_on: '2026-06-02T00:00:00Z',
    environment: {
      platform: { type: 'web', version: '1' },
      runtime: { type: 'web', version: '' },
      sdk: { version: '0', type: 'javascript' },
    },
  };
  return serializeBundle({
    request,
    body: new Uint8Array([0x50, 0x4b, 1]),
    fileName: 'recovered.zip',
    // The incident this blob IS — what the durable frame records so recovery can reconcile it against a
    // still-pending report marker instead of guessing from set sizes.
    ...(reportId !== undefined ? { reportId } : {}),
  });
};

// An IDBFactory that fails EVERY `.open(brokenDbName, …)` (via onerror) while delegating every other
// database name to `real` untouched — simulates one discovery source's IndexedDB read failing.
function brokenDbFactory(real: IDBFactory, brokenDbName: string): IDBFactory {
  return {
    open: ((name: string, version?: number) => {
      if (name !== brokenDbName) {
        return real.open(name, version);
      }
      const request: Partial<IDBOpenDBRequest> & { error: DOMException | null } = { error: null };
      queueMicrotask(() => {
        request.error = new DOMException('forced failure', 'UnknownError');
        request.onerror?.call(request as IDBOpenDBRequest, new Event('error'));
      });
      return request as IDBOpenDBRequest;
    }) as IDBFactory['open'],
  } as unknown as IDBFactory;
}

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

  // The console interceptor is built with the BROWSER's dialect-dispatching `parseStack`, not core's
  // V8-only default. `Error.captureStackTrace` exists on Firefox and Safari too, so a stack IS produced
  // there — just in the `fn@loc` dialect, which the V8 parser yields ZERO frames for, silently dropping
  // exactly the thing `console.trace()` is called for. Only a non-V8 stack can tell the two parsers apart.
  it('parses a console.trace stack in the Firefox/Safari dialect (the injected stackParser)', async () => {
    // `Error.captureStackTrace` is a V8 extension the DOM lib does not declare — cast to reach it (it is
    // the same object, so vi.restoreAllMocks() puts the real one back).
    const errorCtor = Error as unknown as { captureStackTrace: (target: object) => void };
    vi.spyOn(errorCtor, 'captureStackTrace').mockImplementation((target: object) => {
      (target as { stack?: string }).stack =
        'handler@https://app.test/x.js:4:2\n@https://app.test/y.js:9:1';
    });
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store }));

    console.trace('traced-in-firefox');

    const logs = await drain(store, 'log');
    const message = String((logs?.[0]?.data as { message?: string }).message);
    expect(message).toContain('traced-in-firefox');
    expect(message).toContain('at handler (https://app.test/x.js:4:2)'); // frames recovered, not dropped
    expect(message).toContain('at <anonymous> (https://app.test/y.js:9:1)');
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

  // Re-pointed from "captures a document interaction (click) as an events.user entry". What that test
  // was really protecting: launch() actually WIRES the DOM input source into the client, so a real
  // document interaction lands in the bundle. That still matters — but the stream it lands in was the
  // defect: `events.user` is the app's own `client.event()` stream and SDK capture must stay out of it.
  it('captures a document interaction (pointer press) as an `input` entry', async () => {
    const store = memStore();
    const doc = fakeWindow();
    launchTracked(
      'tok',
      baseOptions({ captureStore: store, document: doc.win as unknown as Document }),
    );
    doc.emit('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      target: {
        tagName: 'BUTTON',
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
        textContent: 'Buy',
      },
      clientX: 3,
      clientY: 4,
      button: 0,
      pressure: 0.5,
    });
    const events = await drain(store, 'input');
    expect(events).toHaveLength(1);
    const data = events?.[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({
      type: 'begin',
      x: 3,
      y: 4,
      tool: 2, // mouse
      button: 0,
      view_tag: 'button',
      target: { text: 'Buy', selector: 'button' },
    });
    expect(typeof data.timestamp).toBe('number');
  });

  // THE SEPARATION, end to end through launch(): after this change `events.user.json` may contain
  // client.event() output and NOTHING else. A regression here is the whole bug coming back.
  it('keeps events.user for client.event() ONLY — captured interactions never land there', async () => {
    const store = memStore();
    const doc = fakeWindow();
    const client = launchTracked(
      'tok',
      baseOptions({ captureStore: store, document: doc.win as unknown as Document }),
    );
    const el = {
      tagName: 'BUTTON',
      getAttribute: () => null,
      closest: () => null,
      matches: () => false,
    };
    doc.emit('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      target: el,
      clientX: 1,
      clientY: 2,
      button: 0,
      pressure: 1,
    });
    doc.emit('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      target: el,
      clientX: 1,
      clientY: 2,
      button: 0,
      pressure: 0,
    });
    doc.emit('keydown', { target: el, key: 'Enter' });
    client.event('checkout_started', { total: 42 });

    const userEvents = await drain(store, 'events.user');
    expect(userEvents?.map((e) => e.data)).toMatchObject([
      { name: 'checkout_started', params: { total: 42 } },
    ]);
    // Nothing SDK-captured leaked in: no interaction vocabulary anywhere in the user stream.
    const asJson = JSON.stringify(userEvents?.map((e) => e.data));
    for (const marker of ['begin', 'end', 'change', 'view_tag', 'tool', 'Enter']) {
      expect(asJson).not.toContain(marker);
    }
    // ...and the interactions are all present on the input stream instead.
    const input = await drain(store, 'input');
    expect(input?.map((e) => (e.data as { type: string }).type)).toStrictEqual([
      'begin',
      'end',
      'keydown', // the keydown
    ]);
  });

  // THE SECOND SEPARATION: `change`/`submit`/`focus` are STATE-CHANGE signals, not device input. They
  // are not (and cannot be) members of Android's InputEventStage, every consumer discarded them off the
  // input stream, and Android routes its own recognised-interaction breadcrumbs through the gesture
  // dispatcher → BreadcrumbInputGesture. They now land on `breadcrumbs`, in that producer's shape.
  it('routes change / submit / focus to ui.* breadcrumbs, never to the input stream', async () => {
    const store = memStore();
    const doc = fakeWindow();
    launchTracked(
      'tok',
      baseOptions({ captureStore: store, document: doc.win as unknown as Document }),
    );
    const field = {
      tagName: 'INPUT',
      id: 'qty',
      type: 'number',
      getAttribute: (n: string) => (n === 'class' ? 'field' : null),
      closest: () => null,
      matches: () => false,
    };
    const form = {
      tagName: 'FORM',
      id: 'checkout',
      getAttribute: () => null,
      closest: () => null,
      matches: () => false,
    };
    doc.emit('focusin', { target: field });
    doc.emit('change', { target: field });
    doc.emit('submit', { target: form });

    const crumbs = await drain(store, 'breadcrumbs');
    expect(crumbs?.map((e) => e.data)).toStrictEqual([
      {
        type: 'user',
        category: 'ui.focus',
        level: 'info',
        timestamp: expect.any(Number),
        data: { 'view.id': 'qty', 'view.class': 'field', 'view.tag': 'input' },
      },
      {
        type: 'user',
        category: 'ui.change',
        level: 'info',
        timestamp: expect.any(Number),
        data: { 'view.id': 'qty', 'view.class': 'field', 'view.tag': 'input' },
      },
      {
        type: 'user',
        category: 'ui.submit',
        level: 'info',
        timestamp: expect.any(Number),
        data: { 'view.id': 'checkout', 'view.tag': 'form' },
      },
    ]);
    // Not on the input stream, and not on the application's own user streams.
    expect(await drain(store, 'input')).toBeUndefined();
    expect(await drain(store, 'events.user')).toBeUndefined();
  });

  it('runs the app breadcrumb filter over a ui.* breadcrumb (it goes through addBreadcrumb)', async () => {
    const store = memStore();
    const doc = fakeWindow();
    const client = launchTracked(
      'tok',
      baseOptions({ captureStore: store, document: doc.win as unknown as Document }),
    );
    client.setBreadcrumbFilter((c) => (c.category === 'ui.focus' ? null : c));
    const field = {
      tagName: 'INPUT',
      id: 'qty',
      getAttribute: () => null,
      closest: () => null,
      matches: () => false,
    };
    doc.emit('focusin', { target: field }); // dropped by the filter
    doc.emit('change', { target: field });
    const crumbs = await drain(store, 'breadcrumbs');
    expect(crumbs?.map((e) => (e.data as { category: string }).category)).toStrictEqual([
      'ui.change',
    ]);
  });

  it('withholds a ui.* breadcrumb for a sensitive field (the secure-field exclusion)', async () => {
    const store = memStore();
    const doc = fakeWindow();
    launchTracked(
      'tok',
      baseOptions({ captureStore: store, document: doc.win as unknown as Document }),
    );
    doc.emit('focusin', {
      target: {
        tagName: 'INPUT',
        id: 'login-pw',
        type: 'password',
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
      },
    });
    expect(await drain(store, 'breadcrumbs')).toBeUndefined();
  });

  it('does not capture interactions when captureInteractions is disabled', async () => {
    const store = memStore();
    const doc = fakeWindow();
    launchTracked(
      'tok',
      baseOptions({
        captureStore: store,
        captureInteractions: false,
        document: doc.win as unknown as Document,
      }),
    );
    doc.emit('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      target: {
        tagName: 'BUTTON',
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
      },
      clientX: 0,
      clientY: 0,
      button: 0,
      pressure: 0.5,
    });
    // The gate means "the SDK does not watch what I click and type" — which must hold whatever stream
    // the observation lands on, so it covers the ui.* breadcrumb trail too.
    doc.emit('change', {
      target: {
        tagName: 'INPUT',
        id: 'qty',
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
      },
    });
    expect(await drain(store, 'input')).toBeUndefined();
    expect(await drain(store, 'events.user')).toBeUndefined();
    expect(await drain(store, 'breadcrumbs')).toBeUndefined();
  });

  it('captures a DOM viewtree into the report bundle at report time', async () => {
    const transport = uploadTransport();
    const doc = fakeDocument(viewEl('body', { children: [viewEl('main')] }));
    const client = launchTracked(
      'tok',
      baseOptions({ transport, captureStore: memStore(), document: doc }),
    );
    await client.logException(new Error('boom'));
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    const viewtree = JSON.parse(strFromU8(files['viewtree.json'] as Uint8Array));
    expect(viewtree).toEqual([
      {
        tag: 'body',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        children: [{ tag: 'main', rect: { x: 0, y: 0, width: 0, height: 0 } }],
      },
    ]);
  });

  it('omits the viewtree when captureViewHierarchy is disabled', async () => {
    const transport = uploadTransport();
    const doc = fakeDocument(viewEl('body'));
    const client = launchTracked(
      'tok',
      baseOptions({
        transport,
        captureStore: memStore(),
        captureViewHierarchy: false,
        document: doc,
      }),
    );
    await client.logException(new Error('boom'));
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    expect(files['viewtree.json']).toBeUndefined();
  });

  it('takes an initial system-traces sample from the injected sampler', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store }));
    const traces = await drain(store, 'traces.system');
    expect(traces?.map((e) => (e.data as { name: string }).name)).toContain('ram_js_heap_used');
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
    // The OS, derived in-browser — `platform` is no longer the sandbox tag with a UA string for a
    // version, and the runtime/browser identity has its own blocks (F-X20).
    expect(env.platform.type).toBe('macos');
    expect(env.platform.version).toBe('10.15.7');
    expect(env.browser).toEqual({ type: 'Chrome', version: '119.0.0.0' });
    expect(env.runtime).toEqual({ type: 'web', version: '119.0.0.0' });
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
    expect(reg.get('browser-ui-breadcrumbs')).toBeDefined();
    // The frame `browser-input`'s coordinates are measured in — shared on the carrier for the same
    // reason the input source is: one set of window listeners per process, not one per launch.
    expect(reg.get('browser-viewport')).toBeDefined();
    // console + browser-input + browser-ui-breadcrumbs + browser-viewport + the 6 cross-runtime network
    // leaves (fetch/xhr/sendBeacon/websocket/sse/webtransport) = 10. No node-http.
    expect(reg.get('sendbeacon')).toBeDefined();
    expect(reg.size).toBe(10);
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

  it('persist:true builds an IndexedDB bundle store and recovers a prior run (dead sibling) leftover', async () => {
    const idb = new IDBFactory();
    // A prior run = a DEAD sibling instance: its bundle sits under its own instance prefix in the
    // per-token coexistence database `bugsee-<hash>`. The reloaded tab (a new instance) recovers it.
    const shared = createIdbBlobStore({
      databaseName: coexistenceDatabaseName('tok'),
      indexedDB: idb,
    });
    await shared.put('priorinst/left-1', pendingBundle('prior crash'));
    const transport = uploadTransport();
    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        captureStore: memStore(),
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );
    await vi.waitFor(() =>
      expect(transport.mock.calls.some(([url]) => url === 'https://s3.test/put')).toBe(true),
    );
    await vi.waitFor(async () =>
      expect((await shared.loadAll()).some(([k]) => k === 'priorinst/left-1')).toBe(false),
    ); // re-uploaded → removed from the dead sibling's prefix
    expect(issueSummary(transport)).toBe('prior crash'); // the SEEDED dead-sibling bundle was delivered
  });

  it('SKIPS a LIVE sibling (lock held) while recovering a DEAD one — end to end', async () => {
    const idb = new IDBFactory();
    const locks = fakeWebLocks();
    createWebLockLiveness(locks).holdSelf(instanceLockName('tok', 'livesib')); // a still-open tab
    const shared = createIdbBlobStore({
      databaseName: coexistenceDatabaseName('tok'),
      indexedDB: idb,
    });
    await shared.put('deadsib/b1', pendingBundle('dead tab crash'));
    await shared.put('livesib/b2', pendingBundle('live tab, in flight'));

    const transport = uploadTransport();
    launchTracked(
      'tok',
      baseOptions({ transport, persist: true, captureStore: memStore(), indexedDB: idb, locks }),
    );

    await vi.waitFor(async () =>
      expect((await shared.loadAll()).some(([k]) => k === 'deadsib/b1')).toBe(false),
    ); // dead sibling recovered
    expect(issueSummary(transport)).toBe('dead tab crash'); // ONLY the dead one delivered
    expect((await shared.loadAll()).some(([k]) => k === 'livesib/b2')).toBe(true); // live sibling untouched
  });

  it('persist:true wraps the capture store in an IndexedDB-backed persistent store', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    // No captureStore override → launch builds the persistent capture store (db 'bugsee-capture-<hash>').
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

  it('persist:true persists a captured part under a per-instance prefix in the per-token capture db', async () => {
    const idb = new IDBFactory();
    vi.stubGlobal('indexedDB', idb);
    const tickCbs: Array<() => void> = [];
    const scheduler = {
      setInterval: (cb: () => void) => {
        tickCbs.push(cb);
        return 'h';
      },
      clearInterval: () => {},
    };
    launchTracked('tok', baseOptions({ persist: true, scheduler, indexedDB: idb })); // no captureStore override
    console.log('persist-me');
    await new Promise((r) => setTimeout(r, 0)); // let the log reach the store (persisted as captured)
    for (const cb of tickCbs) cb(); // a tick closes the part (rewrites its durable meta)
    await vi.waitFor(async () => {
      // The durable chunk store writes data + meta to db `bugsee-capture-<hash>`, each key instance-prefixed.
      const keys = await createIdbKeyedStore({
        databaseName: captureDatabaseName('tok'),
        storeName: 'capture',
        indexedDB: idb,
      }).keys('');
      expect(keys.length).toBeGreaterThan(0); // a plain memory store would persist nothing here
      expect(keys.every((k) => /^[0-9a-f]{32}\//.test(k))).toBe(true); // every key under an <instanceId>/ prefix
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

const captureStoreFor = (idb: IDBFactory) =>
  createIdbKeyedStore({
    databaseName: captureDatabaseName('tok'),
    storeName: 'capture',
    indexedDB: idb,
  });
const markerStoreFor = (idb: IDBFactory) =>
  createIdbBlobStore({
    databaseName: markerDatabaseName('tok'),
    storeName: 'markers',
    indexedDB: idb,
  });

// The capture generations present under ONE sibling instance's prefix (`<id>/m/<gen13>/<chunk12>`).
const siblingGenerations = async (idb: IDBFactory, instanceId: string): Promise<Set<number>> => {
  const metas = await captureStoreFor(idb).readPrefix(`${instanceId}/m/`);
  return new Set(
    metas.map(([key]) => {
      const inner = key.slice(instanceId.length + 1); // `m/<gen>/<chunk>`
      return Number(inner.slice(2, inner.indexOf('/', 2)));
    }),
  );
};
// The marker keys persisted under ONE sibling instance's prefix.
const siblingMarkers = (idb: IDBFactory, instanceId: string): Promise<string[]> =>
  markerStoreFor(idb)
    .loadAll()
    .then((es) => es.map(([k]) => k).filter((k) => k.startsWith(`${instanceId}/`)));

// Seed a SIBLING instance's prior crash (a closed capture chunk + optionally a pending marker) under its
// own `"<instanceId>/"` prefix in the per-token capture/marker databases — exactly how that instance's own
// launch would have written it. A dead sibling has no held lock; a live one holds it (seed that separately).
async function seedSibling(
  idb: IDBFactory,
  instanceId: string,
  gen: number,
  data: unknown,
  withMarker: boolean,
): Promise<void> {
  const backend = createIdbChunkBackend(
    createPrefixedKeyedStore(captureStoreFor(idb), instanceId),
    {
      generation: gen,
      cleanOtherGenerations: false,
    },
  );
  backend.openPart({ generation: gen, number: 0 }, gen);
  backend.appendEntry({ generation: gen, number: 0 }, logRecord(data));
  backend.closePart({ generation: gen, number: 0 }, gen + 100, 0);
  await backend.listGenerations(); // drain the async write queue
  if (withMarker) {
    const marker = {
      generation: gen,
      request: createReportingRequest({ source: { type: 'crash' }, id: `inc-${instanceId}` }),
      attributes: {},
      userIdentifier: null,
    };
    await markerStoreFor(idb).put(
      `${instanceId}/inc-${instanceId}`,
      new TextEncoder().encode(JSON.stringify(marker)),
    );
  }
}

describe('launch — capture recovery (multi-instance)', () => {
  it('recovers a DEAD sibling incident (rebuild+upload, sweep) and NEVER touches a LIVE sibling', async () => {
    const idb = new IDBFactory();
    const locks = fakeWebLocks();
    createWebLockLiveness(locks).holdSelf(instanceLockName('tok', 'livesib')); // a still-open tab
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true); // a crashed tab's pending incident
    await seedSibling(idb, 'livesib', 700, { m: 'live-buffer' }, true); // a LIVE tab's incident + capture
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks,
        onError: vi.fn(), // exercise the onError-threaded dead-sibling recovery path
      }),
    );

    // The DEAD sibling's incident is rebuilt from its preserved capture chunks and uploaded.
    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
    const files = unzipSync(puts[0] as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([{ m: 'pre-crash' }]);
    expect(strFromU8(files.apptoken as Uint8Array)).toBe('tok');

    // The dead sibling's marker + capture generation are swept...
    await vi.waitFor(async () => expect(await siblingMarkers(idb, 'deadsib')).toEqual([]));
    await vi.waitFor(async () =>
      expect((await siblingGenerations(idb, 'deadsib')).has(500)).toBe(false),
    );
    // ...and the LIVE sibling's marker + capture are completely untouched (the SEV1 fix).
    expect(await siblingMarkers(idb, 'livesib')).toEqual(['livesib/inc-livesib']);
    expect((await siblingGenerations(idb, 'livesib')).has(700)).toBe(true);
    expect(puts).toHaveLength(1); // only the dead sibling was delivered, not the live one
  });

  // SEV1 (recovery double-upload, confirmed on 4 samples — events_count +2 per incident, never +1): the
  // process can die AFTER a crash bundle reaches the durable bundle queue but BEFORE the upload settles —
  // client.ts's submitReport clears the report marker only once that upload settles — leaving a dead
  // sibling with BOTH a pending bundle AND its incident's still-present marker for the SAME crash. Both
  // used to be recovered independently. Exactly one upload must reach the pipeline.
  it('uploads an incident exactly ONCE when its bundle reached the durable queue before the crash', async () => {
    const idb = new IDBFactory();
    const bundleShared = createIdbBlobStore({
      databaseName: coexistenceDatabaseName('tok'),
      indexedDB: idb,
    });
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true); // marker + chunks for inc-deadsib
    // The SAME incident's bundle also reached the durable queue before the process died.
    await bundleShared.put(
      'deadsib/already-staged',
      pendingBundle('pre-crash (staged bundle)', 'inc-deadsib'),
    );
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 20)); // give a (erroneous) second delivery a chance to land
    expect(puts).toHaveLength(1); // NOT twice
    // …and the ONE delivery is the already-assembled bundle, not a rebuild: the staged artifact wins, so
    // nothing that was never uploaded is ever discarded.
    expect(puts[0]).toEqual(new Uint8Array([0x50, 0x4b, 1]));
    await vi.waitFor(async () => expect(await siblingMarkers(idb, 'deadsib')).toEqual([]));
    await vi.waitFor(async () =>
      expect((await bundleShared.loadAll()).some(([k]) => k === 'deadsib/already-staged')).toBe(
        false,
      ),
    ); // the delivered durable copy is dropped only AFTER its upload confirmed
  });

  // The case the previous fix's set-emptiness key silently DELETED: the staged bundle belongs to a
  // DIFFERENT incident than the pending marker (its own marker was cleared on a non-ok upload settle, or
  // it was re-staged by an earlier recovery). Both incidents must be delivered — nothing may be dropped.
  it('delivers BOTH a marker-only incident and a staged bundle that belongs to another incident', async () => {
    const idb = new IDBFactory();
    const bundleShared = createIdbBlobStore({
      databaseName: coexistenceDatabaseName('tok'),
      indexedDB: idb,
    });
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true); // marker + chunks for inc-deadsib
    await bundleShared.put('deadsib/other', pendingBundle('a DIFFERENT incident', 'inc-other'));
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(puts).toHaveLength(2)); // both, never one
    // one upload is the staged blob verbatim; the other is the rebuilt marker bundle (a real zip)
    expect(puts.some((p) => p.length === 3)).toBe(true);
    const rebuilt = puts.find((p) => p.length > 3) as Uint8Array;
    expect(JSON.parse(strFromU8(unzipSync(rebuilt)['logs.json'] as Uint8Array))).toEqual([
      { m: 'pre-crash' },
    ]);
    await vi.waitFor(async () => expect(await siblingMarkers(idb, 'deadsib')).toEqual([]));
    await vi.waitFor(async () => expect(await bundleShared.loadAll()).toEqual([]));
  });

  // The `skipReportIds` pass-through into core's `recoverReports` — the marker leg must not rebuild an
  // incident the bundle-queue leg already owns — is NOT pinned here, and a test that claimed to was
  // removed rather than repaired.
  //
  // It asserted that only one /v2/sessions call was made, reasoning that a second leg would enqueue a
  // second bundle in the same turn. It cannot: `ensureSession` shares one in-flight promise, so both
  // legs await the SAME call, and when that call is the failing one neither reaches /v2/issues. Deleting
  // the guard changed nothing observable in this fixture — not the session count, not the staged-blob
  // keys, not the marker state — with a failing session OR a succeeding one, so no assertion over it
  // could have worked. Before round 6 the test failed on the mutation only incidentally, through the
  // blob deletion that a 403's PERMANENT verdict caused; making control-plane failures retryable removed
  // that side effect and left the test unable to fail.
  //
  // The guard is covered where it is actually observable — an INJECTED bundle store, whose staged blob
  // and marker are visible to the same launch: "uploads an incident ONCE when an injected bundle store
  // holds the blob a dead sibling's marker covers", "gives each dead sibling only its own blobs out of a
  // shared injected store", and "waits for an injected ASYNC store to hydrate before reconciling it",
  // plus `core/src/capture-recovery.test.ts` (2), `node/src/recover-instances.test.ts` (4) and
  // `node/src/launch.test.ts` (3). Deleting the guard fails 15 tests across those four packages —
  // counted by deleting it, not estimated.

  // R2-1. An explicit `bundleStore` BYPASSES coexistence: it is the integrator's own store, stable across
  // page loads, so it holds the previous session's staged bundle while that incident's marker still sits in
  // the dead session's IndexedDB namespace. Replaying it blind and then rebuilding from the marker uploaded
  // the incident twice, with DIFFERING payloads (the staged frame vs a freshly assembled zip).
  it('uploads an incident ONCE when an injected bundle store holds the blob a dead sibling’s marker covers', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true); // marker inc-deadsib + chunks
    const { store, map } = bundleMemStore();
    map.set('staged', pendingBundle('inc-deadsib (staged)', 'inc-deadsib'));
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        bundleStore: store,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(map.size).toBe(0)); // the staged blob was delivered and freed
    await new Promise((r) => setTimeout(r, 30)); // let a second (wrong) upload land if it is going to
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual(new Uint8Array([0x50, 0x4b, 1])); // the staged body verbatim, not a rebuild
    await vi.waitFor(async () => expect(await siblingMarkers(idb, 'deadsib')).toEqual([])); // retired
  });

  // R5-4. The SAME wiring under a RETRYABLE failure — the only condition under which routing a recovered
  // blob back through the durable queue is visible. `pipeline: baseUploadPipeline` →
  // `pipeline: durable ?? baseUploadPipeline` survived every suite in three review rounds because every
  // platform test used an accepting transport: the second copy the durable queue stages on the way IN is
  // removed the instant the upload succeeds, so the duplicate never outlives the pass. On a 503 it does —
  // and the next page load uploads that incident twice, from two blobs, with differing payloads.
  it('re-stages NOTHING in the injected store when a recovered blob’s upload fails retryably', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true); // marker inc-deadsib + chunks
    const { store, map, puts } = bundleMemStore();
    map.set('staged', pendingBundle('inc-deadsib (staged)', 'inc-deadsib'));
    // 503 on the session call: RETRYABLE, so the attempt never settles — the blob is kept, which is
    // exactly when a re-staged second copy would survive to the next launch.
    const transport = vi.fn<HttpTransport>(async (url: string) => ({
      status: url.endsWith('/v2/sessions') ? 503 : 200,
      headers: {},
      body: new Uint8Array(),
    }));

    const client = launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        bundleStore: store,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks: fakeWebLocks(),
        onError: vi.fn(),
      }),
    );

    const sessions = () => transport.mock.calls.filter(([url]) => url.endsWith('/v2/sessions'));
    await vi.waitFor(() => expect(sessions().length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 30)); // let a re-stage land if it is going to
    expect(puts).toEqual([]); // NOTHING was written back into the integrator's store…
    expect([...map.keys()]).toEqual(['staged']); // …so one incident is still exactly one blob
    // The marker survives too (retryable ⇒ both durable traces kept), so the next launch retries once.
    expect(await siblingMarkers(idb, 'deadsib')).toEqual(['deadsib/inc-deadsib']);
    // The 5 s retry backoff is deliberately still running: bound the teardown rather than wait it out.
    await client.stop(0);
  });

  // TWO dead siblings sharing one injected store. Each pass must take ONLY the blobs its own markers cover:
  // a pass that grabs the whole store delivers the other sibling's blob through a replay that knows nothing
  // about that sibling's marker, and the marker leg then rebuilds and uploads it a second time.
  it('gives each dead sibling only its own blobs out of a shared injected store', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadA', 500, { m: 'A' }, true);
    await seedSibling(idb, 'deadB', 501, { m: 'B' }, true);
    const { store, map } = bundleMemStore();
    map.set('sA', pendingBundle('inc-deadA (staged)', 'inc-deadA'));
    map.set('sB', pendingBundle('inc-deadB (staged)', 'inc-deadB'));
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        bundleStore: store,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(map.size).toBe(0));
    await new Promise((r) => setTimeout(r, 30)); // let a third (wrong) upload land if it is going to
    expect(puts).toHaveLength(2); // exactly one per incident — NOT three
    expect(puts).toEqual([new Uint8Array([0x50, 0x4b, 1]), new Uint8Array([0x50, 0x4b, 1])]);
  });

  // The reconciliation reads the injected store through the SAME sync BundleStore contract the browser's own
  // IndexedDB queue uses — an in-memory mirror that is empty until it has hydrated. Reconciling before that
  // sees no blobs at all, so the marker leg rebuilds the incident and the later unfiltered pass then replays
  // the blob: the duplicate, restored by a missing await.
  it('waits for an injected ASYNC store to hydrate before reconciling it', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true);
    const staged = pendingBundle('inc-deadsib (staged)', 'inc-deadsib');
    const blob: AsyncBlobStore = {
      // Deliberately slow: the dead-sibling scan finishes long before the mirror is populated.
      loadAll: () => new Promise((resolve) => setTimeout(() => resolve([['left', staged]]), 25)),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        bundleStore: createPersistentBundleStore(blob),
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 40));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual(new Uint8Array([0x50, 0x4b, 1])); // the staged body, not a rebuild
  });

  // The other half of the same wiring: the unfiltered pass that follows the sibling scan must still take
  // the blobs NO dead sibling's markers claimed, or an injected store would stop being recovered at all.
  it('still replays an injected store’s unclaimed blob after the dead-sibling scan', async () => {
    const idb = new IDBFactory();
    const { store, map } = bundleMemStore();
    map.set('orphan', pendingBundle('nobody-claims-me', 'inc-other'));
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        bundleStore: store,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(map.size).toBe(0));
    expect(puts).toHaveLength(1);
  });

  it('routes a dead-sibling discovery-source failure to onError, still recovering via the other sources', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'discoverable via markers/capture' }, true);
    // The bundle-queue database is the ONE discovery source that fails; markers/capture still find
    // 'deadsib' and recover it normally — a single broken source must not sink the whole scan.
    const broken = brokenDbFactory(idb, coexistenceDatabaseName('tok'));
    const onError = vi.fn();
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: broken,
        locks: fakeWebLocks(),
        onError,
      }),
    );

    // THREE independent readers of that one broken database fail, and they are NOT interchangeable:
    //   1. the launch's OWN durable bundle store fails to HYDRATE (idb-bundle-store),
    //   2. the dead-sibling SCAN fails to read it for discovery ids — the catch this test is about,
    //   3. 'deadsib' (discovered via the working marker/capture databases) then fails its bundle-queue
    //      replay (`recoverSiblingBundleQueue`'s own loadAll).
    // A bare `toHaveBeenCalled()` is satisfied by (1) alone, so deleting the discovery catch left it
    // green. All three report the same underlying open failure, so identity cannot separate them; the
    // arity can.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(onError).toHaveBeenCalledTimes(3); // and no more — one per reader, none retried
    expect(
      JSON.parse(strFromU8(unzipSync(puts[0] as Uint8Array)['logs.json'] as Uint8Array)),
    ).toEqual([{ m: 'discoverable via markers/capture' }]);
  });

  it('swallows a discovery-source failure with the DEFAULT (no onError given) sink: recovery still completes', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'default sink' }, true);
    const broken = brokenDbFactory(idb, coexistenceDatabaseName('tok'));
    const { fn: transport, puts } = recordingTransport();

    // No `onError` in baseOptions: the internal default no-op sink swallows the broken source's
    // failure without throwing into launch, and the other (working) sources still recover normally.
    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: broken,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
    expect(
      JSON.parse(strFromU8(unzipSync(puts[0] as Uint8Array)['logs.json'] as Uint8Array)),
    ).toEqual([{ m: 'default sink' }]);
  });

  it('routes a discovery-source failure to onError even when it is the ONLY recovery source', async () => {
    const idb = new IDBFactory();
    // captureStore overrides the persistent capture backend → capture recovery is off (no marker/capture
    // shared stores at all) — the durable bundle queue is the ONLY discovery source this launch has, so
    // its failure is the ONE thing that can call onError here (isolates the discovery catch, not a
    // downstream purge failure sharing the same broken database).
    const broken = brokenDbFactory(idb, coexistenceDatabaseName('tok'));
    const onError = vi.fn();
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        captureStore: memStore(),
        clock: recoveryClock,
        indexedDB: broken,
        locks: fakeWebLocks(),
        onError,
      }),
    );

    // TWO independent readers of that one broken database fail, and they are NOT interchangeable: the
    // launch's OWN durable bundle store fails to HYDRATE (idb-bundle-store), and the dead-sibling scan
    // fails to READ it (the discovery catch). Asserting merely "onError was called" passes on the
    // hydration failure alone, so deleting the discovery catch would leave the test green — the count is
    // what actually pins it. Both report the same underlying open failure, so identity cannot separate
    // them; the arity can.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(onError).toHaveBeenCalledTimes(2); // and no more — one per reader, neither retried
    expect(puts).toEqual([]); // nothing was discoverable, so nothing was (mis)recovered either
  });

  it('recovers a DEAD sibling even when its generation equals the live launch generation', async () => {
    // Per-instance namespacing means two tabs can share a wall-clock generation (1000) without colliding;
    // the dead sibling's recovery must use a `currentGeneration: -1` sentinel so its gen is NOT excluded.
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 1000, { m: 'same-gen-crash' }, true); // gen == recoveryClock wallNow
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1)); // recovered despite gen == 1000
    expect(
      JSON.parse(strFromU8(unzipSync(puts[0] as Uint8Array)['logs.json'] as Uint8Array)),
    ).toEqual([{ m: 'same-gen-crash' }]);
  });

  it('sweeps a DEAD sibling with capture but NO incident, without uploading anything', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'orphan' }, false); // chunks, but NO marker
    const { fn: transport, puts } = recordingTransport();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );

    await vi.waitFor(async () =>
      expect((await siblingGenerations(idb, 'deadsib')).has(500)).toBe(false),
    );
    expect(puts).toEqual([]); // no incident → no report (capture only swept to reclaim space)
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

  it('does not recover capture/markers when recover:false (no marker store, no upload, sibling kept)', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'x' }, true); // a dead sibling's pending incident
    const { fn: transport, puts } = recordingTransport();
    const client = launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        recover: false,
        clock: recoveryClock,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow(); // recovery off → no marker recording
    // Wait long enough that an (erroneously) wired recovery WOULD have uploaded + swept by now.
    await new Promise((r) => setTimeout(r, 50));
    expect(puts).toEqual([]); // nothing recovered/uploaded
    expect(await siblingMarkers(idb, 'deadsib')).toEqual(['deadsib/inc-deadsib']); // marker left intact
    expect((await siblingGenerations(idb, 'deadsib')).has(500)).toBe(true); // capture NOT swept (recover off)
  });
});

// launchCore() is the seam the umbrella uses: it returns the same public client launch() returns, PLUS
// the internal wiring (api/transport/baseUrl/getEnvironment/network/app metadata) the umbrella needs to
// build the performance `send` + http-span source. launch() is just `launchCore(...).client`.
describe('launchCore', () => {
  it('returns the public client plus a populated internals bag', () => {
    const carrier = {};
    const { client, internals } = launchCore(
      'tok',
      baseOptions({ carrier, appVersion: '1.2.3', appBuild: '99' }),
    );
    clients.push(client);
    expect(client).toBeDefined();
    expect(internals).toBeDefined();
    expect(internals?.baseUrl).toBe('https://api.bugsee.com'); // the default endpoint
    expect(internals?.appVersion).toBe('1.2.3');
    expect(internals?.appBuild).toBe('99');
    expect(typeof internals?.transport).toBe('function');
    expect(internals?.api).toBeDefined();
    expect(typeof internals?.getEnvironment).toBe('function');
    expect(internals?.getEnvironment().platform.type).toBe('macos'); // a real browser envelope: the OS
    expect(internals?.getEnvironment().runtime.type).toBe('web'); // ...and the runtime, separately
    expect(internals?.network.interceptor).toBeDefined(); // the listenable network source for http spans
    expect(internals?.onError).toBeUndefined();
  });

  it('carries the injected endpoint + onError on the internals bag', () => {
    const carrier = {};
    const onError = vi.fn();
    const { client, internals } = launchCore(
      'tok',
      baseOptions({ carrier, endpoint: 'https://eu.bugsee.test', onError }),
    );
    clients.push(client);
    expect(internals?.baseUrl).toBe('https://eu.bugsee.test');
    expect(internals?.onError).toBe(onError);
    expect(internals?.appVersion).toBeUndefined();
    expect(internals?.appBuild).toBeUndefined();
  });

  it('returns internals: undefined on a repeat launch (the process singleton is already owned)', () => {
    const carrier = {};
    const first = launchCore('tok', baseOptions({ carrier }));
    clients.push(first.client);
    const onError = vi.fn();
    const second = launchCore('tok', baseOptions({ carrier, onError }));
    expect(second.client).toBe(first.client); // the existing client, not a second one
    expect(second.internals).toBeUndefined(); // nothing to re-wire
    expect(onError).toHaveBeenCalledTimes(1); // the repeat-launch warning still fires
  });

  it('launch() returns exactly launchCore().client (public surface unchanged)', () => {
    const carrier = {};
    const client = launch('tok', baseOptions({ carrier }));
    clients.push(client);
    // A second entry via launchCore resolves the same singleton client.
    expect(launchCore('tok', baseOptions({ carrier })).client).toBe(client);
  });
});

describe('launch — session replay (lazy)', () => {
  // Replay needs a DOM to record, and launch gates the lazy import on the SAME `domDocument` binding the
  // report-time viewtree uses. `baseOptions`' fake window deliberately has NO `document` — that is the SSR /
  // pre-render shape, exercised by the DOM-less tests at the end of this block — so every "replay is on"
  // case has to supply one explicitly.
  const domReplayOptions = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions =>
    baseOptions({ document: fakeDocument(viewEl('body')), ...over });

  // Replay is ON BY DEFAULT (parity with the iOS/Android SDKs, which record by default): the option is an
  // opt-OUT. `replay: false` is what carries the errors-only guarantees the old default used to carry.
  it('records by DEFAULT — replay is enabled when the option is absent', async () => {
    launchTracked('tok', domReplayOptions());
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    const call = registerReplay.mock.calls[0] as unknown[];
    expect(typeof (call[0] as { addCaptureProvider?: unknown }).addCaptureProvider).toBe(
      'function',
    );
    expect(call[1]).toEqual({}); // the shared fileEncoders map (replay writes its encoder into it)
    expect(call[2]).toEqual({}); // no caller overrides → replay's own fail-closed defaults apply
  });

  it('records when the document arrives via window.document (the real-browser path)', async () => {
    // The gate must read the RESOLVED `domDocument` — `options.document ?? win.document` — not just the
    // injected seam. In a real browser nobody passes `document`; it comes off the window.
    const win = Object.assign(fakeWindow().win, { document: fakeDocument(viewEl('body')) });
    launchTracked('tok', baseOptions({ window: win })); // no `document` option at all
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
  });

  it('the DEFAULT path resolves to FAIL-CLOSED masking (mask all text/inputs, block all media)', async () => {
    // The default now applies to EVERY integration that does not opt out, so "fail-closed" has to hold on
    // the default path and not merely on the opted-in one. Asserting the forwarded options object is `{}`
    // proves nothing on its own — what matters is what `{}` RESOLVES to, so run the real resolver over
    // exactly what launch forwards (importActual: this module is mocked for the rest of the file).
    launchTracked('tok', domReplayOptions());
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    const forwarded = registerReplay.mock.calls[0]?.[2] as Record<string, unknown>;
    const { MEDIA_SELECTOR, resolveReplayMaskingOptions } =
      await vi.importActual<typeof import('@bugsee/replay')>('@bugsee/replay');
    const masking = resolveReplayMaskingOptions(forwarded);
    expect(masking.maskAllText).toBe(true);
    expect(masking.maskAllInputs).toBe(true);
    expect(masking.blockSelector).toContain(MEDIA_SELECTOR);
  });

  it('does NOT load @bugsee/replay-canvas on the DEFAULT path — canvas stays opt-in', async () => {
    launchTracked('tok', domReplayOptions());
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
    const opts = registerReplay.mock.calls[0]?.[2] as { canvas?: unknown };
    expect(opts.canvas).toBeUndefined();
  });

  it('lazy-loads @bugsee/replay + registers it when replay is enabled, forwarding the options', async () => {
    launchTracked(
      'tok',
      domReplayOptions({ replay: { maskAllText: false, checkoutEveryNms: 5000 } }),
    );
    // The dynamic import resolves on a microtask.
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    const call = registerReplay.mock.calls[0] as unknown[];
    expect(typeof (call[0] as { addCaptureProvider?: unknown }).addCaptureProvider).toBe(
      'function',
    );
    expect(call[1]).toEqual({}); // the shared fileEncoders map (replay writes its encoder into it)
    expect(call[2]).toEqual({ maskAllText: false, checkoutEveryNms: 5000 }); // options forwarded
  });

  it('forwards the launch onError so a dropped masking selector is actually reported', async () => {
    // Wave 1.4. @bugsee/replay reports an invalid selector it had to drop; that report needs a sink on the
    // production path, or the fix is only reachable from replay's own tests.
    const onError = vi.fn();
    launchTracked('tok', domReplayOptions({ replay: { blockSelector: 'div[' }, onError }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect((registerReplay.mock.calls[0]?.[2] as { onError?: unknown }).onError).toBe(onError);
  });

  it('enables replay with default options when replay is `true`', async () => {
    launchTracked('tok', domReplayOptions({ replay: true }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(registerReplay.mock.calls[0]?.[2]).toEqual({}); // no options object → {}
  });

  // `replay: false` is now THE errors-only path — it inherits the guarantee the old default carried: no
  // recorder, no replay.bin encoder, and (below) no @bugsee/replay in the bundle at all.
  it('does NOT register replay when replay is `false` — the errors-only opt-out', async () => {
    // A DOM IS present here: this asserts the OPT-OUT, so it must not pass merely for want of a document
    // (with `baseOptions` it would pass even if the opt-out were deleted — the DOM-less gate would carry it).
    launchTracked('tok', domReplayOptions({ replay: false }));
    await new Promise((r) => setTimeout(r, 10));
    expect(registerReplay).not.toHaveBeenCalled(); // no recorder, and no replay.bin encoder registered
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
  });

  it('routes a replay load/registration failure to onError (never breaks launch)', async () => {
    registerReplay.mockImplementationOnce(() => {
      throw new Error('replay boom');
    });
    const onError = vi.fn();
    launchTracked('tok', domReplayOptions({ replay: true, onError }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('wires canvas when replay.canvas is set — resolves the config + threads it into registerReplay', async () => {
    launchTracked('tok', domReplayOptions({ replay: { canvas: { fps: 4 } } }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).toHaveBeenCalledWith({ fps: 4 });
    const opts = registerReplay.mock.calls[0]?.[2] as { canvas?: unknown };
    expect(opts.canvas).toEqual({
      recordCanvas: true,
      sampling: { canvas: 2 },
      dataURLOptions: { type: 'image/webp', quality: 0.6 },
    });
  });

  it('enables canvas with default options when replay.canvas is `true`', async () => {
    launchTracked('tok', domReplayOptions({ replay: { canvas: true } }));
    await vi.waitFor(() => expect(createCanvasRecordConfig).toHaveBeenCalledWith({}));
  });

  it('does NOT load @bugsee/replay-canvas when canvas is off (replay without canvas)', async () => {
    launchTracked('tok', domReplayOptions({ replay: true }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
    const opts = registerReplay.mock.calls[0]?.[2] as { canvas?: unknown };
    expect(opts.canvas).toBeUndefined();
  });

  it('does NOT load @bugsee/replay-canvas when replay.canvas is explicitly false', async () => {
    launchTracked('tok', domReplayOptions({ replay: { canvas: false } }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled(); // explicit opt-out must not load the add-on
    const opts = registerReplay.mock.calls[0]?.[2] as { canvas?: unknown };
    expect(opts.canvas).toBeUndefined();
  });

  it('forwards blockAllCanvas through to the replay masking options', async () => {
    launchTracked('tok', domReplayOptions({ replay: { blockAllCanvas: true } }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    const opts = registerReplay.mock.calls[0]?.[2] as { blockAllCanvas?: boolean };
    expect(opts.blockAllCanvas).toBe(true); // not stripped by the canvas destructure; flows to masking
  });

  // --- SSR / pre-render: no DOM ------------------------------------------------------------------
  //
  // `@bugsee/browser` is launched in DOM-less hosts for real: all five meta-framework adapters
  // (nextjs/nuxt/remix/sveltekit/astro) server-render. Now that replay is an opt-OUT, a missing DOM check
  // means every server render dynamic-imports ~56KB of rrweb, calls record(), throws, and the rejection is
  // swallowed by `.catch(onError)` when no onError is configured.
  it('does NOT register replay when there is no DOM (SSR / pre-render), and stays silent', async () => {
    const onError = vi.fn();
    launchTracked('tok', baseOptions({ onError })); // the default path — and no document anywhere
    await new Promise((r) => setTimeout(r, 10));
    expect(registerReplay).not.toHaveBeenCalled();
    // Silence is deliberate: a DOM-less host is not a misconfiguration, and this is the DEFAULT path — an
    // onError here would fire on every single server render for behaving exactly as designed.
    expect(onError).not.toHaveBeenCalled();
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
  });

  it('does NOT register replay without a DOM even when replay is explicitly opted IN', async () => {
    // Meta-framework integrations share ONE options object across the server and the client render, so an
    // explicit `replay: true` reaches the server render too. It cannot conjure a DOM — skip, silently.
    const onError = vi.fn();
    launchTracked('tok', baseOptions({ replay: { canvas: true }, onError }));
    await new Promise((r) => setTimeout(r, 10));
    expect(registerReplay).not.toHaveBeenCalled();
    expect(createCanvasRecordConfig).not.toHaveBeenCalled(); // nor the canvas add-on chunk
    expect(onError).not.toHaveBeenCalled();
  });

  // Kept LAST in this block: it swaps the module mocks out and back around a fresh module registry.
  //
  // What makes both the opt-out and the SSR gate worth having is that rrweb (~56KB) is never even loaded —
  // the reason the import is dynamic in the first place. `registerReplay` not having been called would ALSO
  // pass if the chunk were fetched and the registration merely skipped (that is precisely what the self-skip
  // inside @bugsee/replay does), so count module EVALUATIONS. The positive control at the end is what makes
  // the zeros meaningful.
  //
  // All three cases share ONE fresh registry deliberately: a second `vi.resetModules()` + `vi.doMock()` pass
  // in a follow-up test does not reliably re-run a factory for a module the first pass already
  // instantiated, so a split would count evaluations against a stale mock (observed: replay stuck at 0
  // while canvas counted 1).
  it('never EVALUATES @bugsee/replay unless replay is on AND there is a DOM (bundle guarantee)', async () => {
    vi.resetModules();
    const evaluated = { canvas: 0, replay: 0 };
    vi.doMock('@bugsee/replay', () => {
      evaluated.replay += 1;
      return { registerReplay: vi.fn() };
    });
    vi.doMock('@bugsee/replay-canvas', () => {
      evaluated.canvas += 1;
      return { createCanvasRecordConfig: vi.fn(() => ({})) };
    });
    try {
      const fresh = await import('./launch');

      // (1) The errors-only opt-out, with a DOM present — so this measures the opt-out and nothing else.
      const off = fresh.launch('tok', domReplayOptions({ carrier: {}, replay: false }));
      await new Promise((r) => setTimeout(r, 10));
      expect(evaluated.replay).toBe(0); // the chunk was never fetched/evaluated
      await off.stop();

      // (2) SSR / pre-render: opted IN explicitly (the shared server+client config case) and DOM-less.
      const ssr = fresh.launch('tok', baseOptions({ carrier: {}, replay: { canvas: true } }));
      await new Promise((r) => setTimeout(r, 10));
      expect(evaluated.replay).toBe(0); // no rrweb chunk fetched on a server render
      expect(evaluated.canvas).toBe(0); // nor the canvas add-on
      await ssr.stop();

      // (3) Positive control: the SAME fresh module DOES evaluate both once a document is present — so the
      // zeros above are real absences, not a broken counter or a launch that died before the import.
      const dom = fresh.launch('tok', domReplayOptions({ carrier: {}, replay: { canvas: true } }));
      // ONE wait covering both: the canvas add-on is imported inside replay's own `.then()`, so it lands
      // strictly after replay does — reading it inline races. The explicit budget follows the repo's
      // slow-runner convention (vitest's 1 s waitFor default is short under a loaded parallel `turbo run`).
      await vi.waitFor(
        () => {
          expect(evaluated.replay).toBe(1);
          expect(evaluated.canvas).toBe(1);
        },
        { timeout: 5000 },
      );
      await dom.stop();
    } finally {
      // Restore the file-level mocks for the tests that follow (doUnmock would hand them the REAL module).
      vi.doMock('@bugsee/replay', () => ({ registerReplay }));
      vi.doMock('@bugsee/replay-canvas', () => ({ createCanvasRecordConfig }));
      vi.resetModules();
    }
  });
});

// R1 (docs/design/electron-renderer-incident-convergence.md §4.2): an injectable trigger pipeline.
//
// Symmetric with the `captureStore` seam that already exists. @bugsee/electron needs it because a renderer
// must FORWARD its incidents to the main process rather than assembling a bundle from its streaming store —
// which yields nothing — and uploading under a foreign session id (docs/review/electron.md SEV1 #2).
// @bugsee/webview solves the same problem, but only because it composes its client directly via
// createClient; a full browser SDK cannot do that without duplicating this entire module.
describe('launchCore — triggerPipeline seam', () => {
  it('routes reports through an injected pipeline instead of assembling + uploading', async () => {
    const reported: unknown[] = [];
    const client = launchCore(
      'tok',
      baseOptions({
        triggerPipeline: {
          report: async (request: unknown) => {
            reported.push(request);
            return { ok: true };
          },
        },
      } as Partial<BugseeLaunchOptions>),
    ).client;
    await client.logException(new Error('renderer boom'));
    expect(reported).toHaveLength(1);
    expect(JSON.stringify(reported[0])).toContain('renderer boom');
    await client.stop();
  });

  it('falls back to the built-in assemble+upload pipeline when none is injected', async () => {
    // The compatibility guarantee: every existing consumer is untouched.
    const transport = uploadTransport();
    const client = launchCore('tok', baseOptions({ transport })).client;
    await client.logException(new Error('boom'));
    await client.flush();
    expect(transport.mock.calls.some(([url]) => String(url).includes('/v2/issues'))).toBe(true);
    await client.stop();
  });
});

// WAVE 6.2 — the page-lifecycle flush, wired.
//
// `installPageHideFlush` is unit-tested on its own; these assert launch actually CONNECTS it to something,
// because the failure this fixes was precisely that the SDK listened to `pagehide` and then did nothing
// with it. Each test observes a real consequence — a store flushed, a listener removed — not the mere
// presence of a listener.
describe('flush on page hide (Wave 6.2)', () => {
  /** A capture store that records whether its pending durable writes were committed. */
  const flushableStore = () => {
    const store = memStore();
    store.flush = vi.fn(() => Promise.resolve());
    return store;
  };

  it('commits the capture store’s pending writes when the page hides', () => {
    const win = fakeWindow();
    const captureStore = flushableStore();
    launchTracked('tok', baseOptions({ window: win.win, captureStore }));
    win.emit('pagehide', {});
    expect(captureStore.flush).toHaveBeenCalled();
  });

  it('flushes the CLIENT too, draining a report that is still assembling', () => {
    // Committing the capture store is only half of it. A report can be mid-assembly when the page hides,
    // and an assembling report has not reached the durable queue yet — `client.flush()` is what awaits it
    // (packages/core/src/client.ts: uploadPipeline.flush alone misses reports with no upload enqueued).
    // Without this leg, the last crash before a tab is backgrounded is the one most likely to be lost.
    const win = fakeWindow();
    const client = launchTracked('tok', baseOptions({ window: win.win, captureStore: memStore() }));
    const flush = vi.spyOn(client, 'flush').mockResolvedValue(true);
    win.emit('pagehide', {});
    expect(flush).toHaveBeenCalled();
  });

  it('does not flush on a visibilitychange back to VISIBLE', () => {
    const win = fakeWindow();
    const doc = fakeWindow();
    const captureStore = flushableStore();
    launchTracked(
      'tok',
      baseOptions({
        window: win.win,
        document: Object.assign(doc.win, { visibilityState: 'visible' }) as unknown as Document,
        captureStore,
      }),
    );
    doc.emit('visibilitychange', {});
    expect(captureStore.flush).not.toHaveBeenCalled();
  });

  it('removes the page-hide listener on stop()', async () => {
    const win = fakeWindow();
    const captureStore = flushableStore();
    // System events off, so the only `pagehide` listener in play is the flush hook's — the system-event
    // SOURCE also listens for one, and counting both would hide a leak in either.
    const client = launchTracked(
      'tok',
      baseOptions({ window: win.win, captureStore, captureSystemEvents: false }),
    );
    expect(win.count('pagehide')).toBe(1);
    await client.stop();
    expect(win.count('pagehide')).toBe(0);
    win.emit('pagehide', {});
    expect(captureStore.flush).not.toHaveBeenCalled(); // …and it is genuinely disconnected
  });

  it('a failing flush never throws back into the browser’s dispatch', () => {
    const win = fakeWindow();
    const onError = vi.fn();
    const captureStore = memStore();
    captureStore.flush = () => {
      throw new Error('commit failed');
    };
    launchTracked('tok', baseOptions({ window: win.win, captureStore, onError }));
    expect(() => win.emit('pagehide', {})).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});
