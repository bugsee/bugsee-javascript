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
  BlackoutToken,
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
  LifecycleEvents,
  ReportMarkerStoreToken,
  type StoredEntry,
  screenTrackerFor,
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
import {
  applicationTrackerFor,
  connectivityTrackerFor,
  environmentTrackerFor,
  processTrackerFor,
  resetEnvironmentTracker,
  resetProcessTracker,
  resetStorageTracker,
  resetUiTracker,
  storageTrackerFor,
  uiTrackerFor,
} from '@bugsee/trackers/browser';
import { strFromU8, unzipSync } from '@bugsee/util';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeviceIdLocalStorage, resetBrowserDeviceIdCache } from './device-id';
import { type BrowserProbe, BrowserProbeToken } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch, launchCore } from './launch';

const TEST_DEVICE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

function testDeviceIdLocalStorage(): DeviceIdLocalStorage {
  const data = new Map([['bugsee.device_id', TEST_DEVICE_ID]]);
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

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
    // A real window IS the global scope: its navigator / performance / screen are the same objects the
    // tests stub on the globals. The traces read them from THIS window (never from the host globals).
    get navigator() {
      return (globalThis as { navigator?: unknown }).navigator;
    },
    get performance() {
      return (globalThis as { performance?: unknown }).performance;
    },
    get screen() {
      return (globalThis as { screen?: unknown }).screen;
    },
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

const clients: Bugsee[] = [];
const clientsStop = (): Array<Promise<boolean>> => clients.splice(0).map((c) => c.stop());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  resetBrowserDeviceIdCache();
  vi.restoreAllMocks();
  registerReplay.mockClear(); // vi.fn call history isn't cleared by restoreAllMocks
  createCanvasRecordConfig.mockClear();
  vi.unstubAllGlobals();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const launchTracked = async (token: string, options: BugseeLaunchOptions = {}) => {
  const client = await launch(token, options);
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
  persist: false, // tests opt in; the shipped default is on wherever IndexedDB exists
  deviceIdEnv: {
    localStorage: testDeviceIdLocalStorage(),
    randomUUID: () => TEST_DEVICE_ID,
    ...(over.deviceIdEnv ?? {}),
  },
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
  it('returns a launched client', async () => {
    const client = await launchTracked('tok', baseOptions({ captureStore: memStore() }));
    expect(client.isLaunched()).toBe(true);
  });

  it('sends no user-agent header: a script-set one forces a CORS preflight the collector does not allow', async () => {
    const transport = uploadTransport();
    const client = await launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    await client.logException(new Error('boom'));

    const session = transport.mock.calls.find(([url]) => url.endsWith('/v2/sessions'));
    const headers = (session?.[1] as HttpRequestOptions).headers as Record<string, string>;
    expect(headers['x-app-token']).toBe('tok');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
  });

  it('registers the fetch transport as a resolvable service that internal-tags requests', async () => {
    const transport = uploadTransport();
    const client = await launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    const svc = client.getService(TransportToken);
    expect(typeof svc).toBe('function');
    await svc('https://x.test/v2/sessions', { headers: { 'x-custom': 'keep' } });
    const lastCall = transport.mock.calls.at(-1);
    const headers = (lastCall?.[1] as HttpRequestOptions).headers;
    expect(headers?.['x-bugsee-internal']).toBe('1');
    expect(headers?.['x-custom']).toBe('keep'); // caller headers are MERGED, not replaced
  });

  it('uses the default fetch transport when none is injected', async () => {
    const client = await launchTracked(
      'tok',
      baseOptions({ transport: undefined, captureStore: memStore() }),
    );
    expect(typeof client.getService(TransportToken)).toBe('function');
  });

  it('wires an injected clock + scheduler and the default store/sampler when overrides are omitted', async () => {
    const fixedClock = { wallNow: () => 1000, monotonicNow: () => 0 };
    const calls: Array<{ cb: () => void; ms: number }> = [];
    const scheduler = {
      setInterval: (cb: () => void, ms: number) => {
        calls.push({ cb, ms });
        return 'h';
      },
      clearInterval: () => {},
    };
    const client = await launchTracked(
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

  it('falls back to the global window, realBrowserProbe, and the default store when nothing is injected', async () => {
    const w = fakeWindow();
    vi.stubGlobal('window', w.win);
    vi.stubGlobal('navigator', { userAgent: 'Real-UA' });
    vi.stubGlobal('screen', { width: 100, height: 200 });
    const client = await launchTracked(
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

  it('registers the systemProbe and captureStore as resolvable services', async () => {
    const store = memStore();
    const client = await launchTracked(
      'tok',
      baseOptions({ systemProbe: probe, captureStore: store }),
    );
    expect(client.getService(BrowserProbeToken)).toBe(probe);
    expect(client.getService(CaptureStoreToken)).toBe(store);
  });

  it('registers an injected bundleStore as the resolvable service (by identity)', async () => {
    const { store } = bundleMemStore();
    const client = await launchTracked(
      'tok',
      baseOptions({ bundleStore: store, captureStore: memStore() }),
    );
    expect(client.getService(BundleStoreToken)).toBe(store);
  });

  it('does not register bundleStore in in-memory mode', async () => {
    const client = await launchTracked(
      'tok',
      baseOptions({ persist: false, captureStore: memStore() }),
    );
    expect(() => client.getService(BundleStoreToken)).toThrow();
  });

  it('runs a carrier-contributed service manifest against the launched container', async () => {
    contributeServiceManifest((internal) => {
      internal.addService(
        defineService(DemoExtToken, () => ({
          storeIsRegistered: internal.getService(CaptureStoreToken) !== undefined,
        })),
      );
    });
    const client = await launchTracked('tok', baseOptions({ captureStore: memStore() }));
    expect(client.getService(DemoExtToken)).toEqual({ storeIsRegistered: true });
  });

  it('captures console output as log entries (captureLogs default on)', async () => {
    const store = memStore();
    await launchTracked('tok', baseOptions({ captureStore: store }));
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
    await launchTracked('tok', baseOptions({ captureStore: store }));

    console.trace('traced-in-firefox');

    const logs = await drain(store, 'log');
    const message = String((logs?.[0]?.data as { message?: string }).message);
    expect(message).toContain('traced-in-firefox');
    expect(message).toContain('at handler (https://app.test/x.js:4:2)'); // frames recovered, not dropped
    expect(message).toContain('at <anonymous> (https://app.test/y.js:9:1)');
  });

  it('applies a log filter set on the returned client', async () => {
    const store = memStore();
    const client = await launchTracked('tok', baseOptions({ captureStore: store }));
    client.setLogEventFilter((e) => ({ ...e, message: e.message.replace('secret', '***') }));
    console.log('my secret data');
    const logs = await drain(store, 'log');
    expect(logs?.some((e) => JSON.stringify(e.data).includes('***'))).toBe(true);
    expect(logs?.some((e) => JSON.stringify(e.data).includes('secret'))).toBe(false);
  });

  it('does not capture console output when captureLogs is disabled', async () => {
    const store = memStore();
    await launchTracked('tok', baseOptions({ captureStore: store, captureLogs: false }));
    console.log('not-captured-by-browser-launch');
    expect(await drain(store, 'log')).toBeUndefined();
  });

  it('records the process_started system event on launch', async () => {
    const store = memStore();
    await launchTracked('tok', baseOptions({ captureStore: store }));
    const events = await drain(store, 'events.system');
    expect(events?.map((e) => (e.data as { name: string }).name)).toContain('process_started');
  });

  it('a page hidden at launch does not report UIApplicationDidEnterBackgroundNotification for a duplicate hidden visibilitychange', async () => {
    const store = memStore();
    const w = fakeWindow();
    const doc = fakeWindow();
    const docWin = { ...doc.win, visibilityState: 'hidden' };
    await launchTracked(
      'tok',
      baseOptions({
        window: w.win,
        document: docWin as unknown as Document,
        captureStore: store,
        systemMetricsSampler: undefined,
      }),
    );
    doc.emit('visibilitychange', {});
    const names = ((await drain(store, 'events.system')) ?? []).map(
      (e) => (e.data as { name: string }).name,
    );
    expect(names).not.toContain('UIApplicationDidEnterBackgroundNotification');
    expect(names).toContain('process_started');
  });

  it('ONE shared lifecycle tracker serves traces and events: a single listener per type; visibility reaches events.system via the injected document', async () => {
    const store = memStore();
    const w = fakeWindow();
    const doc = fakeWindow();
    const docWin = { ...doc.win, visibilityState: 'visible' };
    const client = await launchTracked(
      'tok',
      baseOptions({
        window: w.win,
        document: docWin as unknown as Document,
        captureStore: store,
        systemMetricsSampler: undefined,
      }),
    );
    // traces (orientation) AND the events source share ONE UiTracker (a single orientationchange listener);
    // online/offline are bound ONCE, by the domain ConnectivityTracker that both the connection trace and the
    // online/offline events subscribe to (the ApplicationTracker no longer binds them).
    expect(w.count('online')).toBe(1);
    expect(w.count('offline')).toBe(1);
    expect(w.count('orientationchange')).toBe(1);
    // The page starts visible, so only a REAL change to hidden is a background transition.
    docWin.visibilityState = 'hidden';
    doc.emit('visibilitychange', {});
    const names = ((await drain(store, 'events.system')) ?? []).map(
      (e) => (e.data as { name: string }).name,
    );
    expect(names).toContain('UIApplicationDidEnterBackgroundNotification');
    await client.stop();
    expect(w.count('online') + w.count('orientationchange')).toBe(0);
    expect(doc.count('visibilitychange')).toBe(0);
  });

  describe('launch goes through the ApplicationTracker registry', () => {
    const blockedDoc = () => {
      const doc = fakeWindow();
      const boom = new Error('visibilityState blocked');
      const state = { armed: false };
      Object.defineProperty(doc.win, 'visibilityState', {
        get() {
          if (state.armed) throw boom;
          return 'visible';
        },
      });
      return { doc, boom, state, document: doc.win as unknown as Document };
    };

    it('shares ONE tracker per document: a lookup for the launched document sees the launch listeners, not a second set', async () => {
      const w = fakeWindow();
      const { document } = blockedDoc();
      await launchTracked(
        'tok',
        baseOptions({ window: w.win, document, captureStore: memStore() }),
      );
      const before = w.count('pagehide');
      expect(before).toBeGreaterThan(0);
      const shared = applicationTrackerFor({ window: w.win as never, document });
      const off = shared.on('pagehide', () => {});
      expect(w.count('pagehide')).toBe(before); // the SAME tracker: one listener serves launch and this subscriber
      off();
    });

    it("the latest launch's onError becomes the reporter; a relaunch without one keeps it", async () => {
      const w = fakeWindow();
      const { doc, boom, state, document } = blockedDoc();
      const first = vi.fn();
      const second = vi.fn();
      // The tracker's own read fails only while the event is dispatched (launch itself reads the document too).
      const fireBlocked = () => {
        state.armed = true;
        try {
          doc.emit('visibilitychange', {});
        } catch {
          /* a real DOM dispatch never propagates a listener's throw */
        } finally {
          state.armed = false;
        }
      };
      const run = async (onError?: (e: unknown) => void) => {
        const client = await launch(
          'tok',
          baseOptions({
            window: w.win,
            document,
            captureStore: memStore(),
            ...(onError !== undefined ? { onError } : {}),
          }),
        );
        return client;
      };
      await (await run(first)).stop();
      await (await run(second)).stop();
      first.mockClear();
      second.mockClear();
      const live = await run(second);
      clients.push(live);
      fireBlocked();
      expect(second).toHaveBeenCalledWith(boom);
      expect(first).not.toHaveBeenCalledWith(boom);
      await live.stop();
      second.mockClear();
      const bare = await run(); // no onError: must NOT silence the earlier launch's sink
      clients.push(bare);
      fireBlocked();
      expect(second).toHaveBeenCalledWith(boom);
    });
  });

  describe('dark mode, freeze and resume events (from the injected window + document)', () => {
    const mkMedia = () => {
      const l = new Set<(e: { matches: boolean }) => void>();
      const thisSeen: unknown[] = [];
      return {
        thisSeen,
        l,
        matchMedia(this: unknown, _q: string) {
          thisSeen.push(this);
          return {
            matches: false,
            addEventListener: (_t: string, f: (e: { matches: boolean }) => void) => void l.add(f),
            removeEventListener: (_t: string, f: (e: { matches: boolean }) => void) =>
              void l.delete(f),
          };
        },
      };
    };
    const names = async (store: ReturnType<typeof memStore>) =>
      ((await drain(store, 'events.system')) ?? []).map(
        (e) => e.data as { name: string; params?: unknown },
      );

    it('records display_mode_changed from the injected window matchMedia, with the previous mode', async () => {
      const w = fakeWindow();
      const listeners = new Set<(e: { matches: boolean }) => void>();
      let standalone = false;
      Object.assign(w.win, {
        matchMedia(q: string) {
          return {
            get matches() {
              return standalone && q === '(display-mode: standalone)';
            },
            addEventListener: (_t: string, f: (e: { matches: boolean }) => void) =>
              void listeners.add(f),
            removeEventListener: (_t: string, f: (e: { matches: boolean }) => void) =>
              void listeners.delete(f),
          };
        },
      });
      const store = memStore();
      const client = await launchTracked(
        'tok',
        baseOptions({ window: w.win, captureStore: store }),
      );
      standalone = true;
      for (const f of [...listeners]) f({ matches: true });
      expect((await names(store)).filter((e) => e.name === 'display_mode_changed')).toEqual([
        expect.objectContaining({
          name: 'display_mode_changed',
          params: { mode: 'standalone', previousMode: 'browser' },
        }),
      ]);
      await client.stop();
      expect(listeners.size).toBe(0);
    });

    it('records DarkModeChanged from the injected window matchMedia (bound to it), and removes the listener on stop', async () => {
      const w = fakeWindow();
      const m = mkMedia();
      Object.assign(w.win, { matchMedia: m.matchMedia });
      const store = memStore();
      const client = await launchTracked(
        'tok',
        baseOptions({ window: w.win, captureStore: store }),
      );
      expect(m.thisSeen).toHaveLength(12); // dark: baseline read + watch (2); display mode: 3 queries x (baseline read + watch + previous-mode read) (9); displays: the (pointer: coarse) watch (1)
      expect(m.thisSeen.every((t) => t === w.win)).toBe(true); // always called as a method of ITS window
      for (const f of [...m.l]) f({ matches: true });
      expect((await names(store)).filter((e) => e.name === 'DarkModeChanged')).toEqual([
        expect.objectContaining({ name: 'DarkModeChanged', params: { dark: true } }),
      ]);
      await client.stop();
      expect(m.l.size).toBe(0);
    });

    it('a window without matchMedia emits no dark-mode event (silently), never falls back to the host global, and still starts input', async () => {
      const hostCalls: string[] = [];
      vi.stubGlobal('matchMedia', (q: string) => {
        hostCalls.push(q);
        return {};
      });
      try {
        const store = memStore();
        const doc = fakeWindow();
        const onError = vi.fn();
        const client = await launchTracked(
          'tok',
          baseOptions({
            document: doc.win as unknown as Document,
            captureStore: store,
            onError,
          }),
        );
        expect(hostCalls).toEqual([]); // the host's matchMedia is never consulted
        expect(onError).not.toHaveBeenCalled(); // absence is not a failure
        expect(doc.count('pointerdown')).toBeGreaterThan(0); // input capture started (document-bound)
        expect((await names(store)).map((e) => e.name)).not.toContain('DarkModeChanged');
        await client.stop();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('a window whose matchMedia getter or call throws never fails launch (reported)', async () => {
      for (const kind of ['getter', 'call']) {
        const w = fakeWindow();
        if (kind === 'getter') {
          Object.defineProperty(w.win, 'matchMedia', {
            get(): never {
              throw new Error('matchMedia blocked');
            },
          });
        } else {
          Object.assign(w.win, {
            matchMedia() {
              throw new Error('matchMedia blocked');
            },
          });
        }
        const onError = vi.fn();
        const store = memStore();
        const client = await launchTracked(
          'tok',
          baseOptions({ window: w.win, captureStore: store, onError }),
        );
        expect(
          onError.mock.calls.map((c) => (c[0] as Error).message),
          kind,
        ).toContain('matchMedia blocked');
        // the other signals still started despite the failure
        expect(
          (await names(store)).map((e) => e.name),
          kind,
        ).toContain('process_started');
        await client.stop(); // one launch per process: release it before the next iteration
      }
    });

    it('records freeze and resume from the injected DOCUMENT (a window listener never sees them)', async () => {
      const w = fakeWindow();
      const doc = fakeWindow();
      const store = memStore();
      await launchTracked(
        'tok',
        baseOptions({
          window: w.win,
          document: doc.win as unknown as Document,
          captureStore: store,
        }),
      );
      w.emit('freeze', {});
      expect((await names(store)).map((e) => e.name)).not.toContain('freeze');
      doc.emit('freeze', {});
      doc.emit('resume', {});
      const got = (await names(store)).map((e) => e.name);
      expect(got).toEqual(expect.arrayContaining(['freeze', 'resume']));
    });
  });

  // Re-pointed from "captures a document interaction (click) as an events.user entry". What that test
  // was really protecting: launch() actually WIRES the DOM input source into the client, so a real
  // document interaction lands in the bundle. That still matters — but the stream it lands in was the
  // defect: `events.user` is the app's own `client.event()` stream and SDK capture must stay out of it.
  it('captures a document interaction (pointer press) as an `input` entry', async () => {
    const store = memStore();
    const doc = fakeWindow();
    await launchTracked(
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
    const client = await launchTracked(
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
    await launchTracked(
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
    const client = await launchTracked(
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
    await launchTracked(
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
    await launchTracked(
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
    const client = await launchTracked(
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

  describe('blackout', () => {
    const press = (doc: ReturnType<typeof fakeWindow>, id: number): void =>
      doc.emit('pointerdown', {
        pointerId: id,
        pointerType: 'mouse',
        target: {
          tagName: 'BUTTON',
          getAttribute: () => null,
          closest: () => null,
          matches: () => false,
        },
        clientX: id,
        clientY: id,
        button: 0,
        pressure: 0.5,
      });
    const field = {
      tagName: 'INPUT',
      id: 'qty',
      type: 'number',
      getAttribute: () => null,
      closest: () => null,
      matches: () => false,
    };

    it('exposes startBlackout / endBlackout / isBlackout on the launched client', async () => {
      const client = await launchTracked('tok', baseOptions({ captureStore: memStore() }));
      expect(client.isBlackout()).toBe(false);
      client.startBlackout();
      expect(client.isBlackout()).toBe(true);
      client.endBlackout();
      expect(client.isBlackout()).toBe(false);
    });

    it('suppresses input presses and ui.* breadcrumbs for the blackout window only', async () => {
      const store = memStore();
      const doc = fakeWindow();
      const client = await launchTracked(
        'tok',
        baseOptions({ captureStore: store, document: doc.win as unknown as Document }),
      );
      press(doc, 1);
      doc.emit('focusin', { target: field });
      client.startBlackout();
      press(doc, 2);
      doc.emit('change', { target: field });
      doc.emit('submit', { target: field });
      client.endBlackout();
      press(doc, 3);
      doc.emit('change', { target: field });

      const input = await drain(store, 'input');
      expect(input?.map((e) => (e.data as { x: number }).x)).toEqual([1, 3]);
      const crumbs = await drain(store, 'breadcrumbs');
      expect(crumbs?.map((e) => (e.data as { category: string }).category)).toEqual([
        'ui.focus',
        'ui.change',
      ]);
    });

    it('a wheel turn made DURING a blackout is never emitted, even if the frame flushes after it ended', async () => {
      const store = memStore();
      const doc = fakeWindow();
      const client = await launchTracked(
        'tok',
        baseOptions({ captureStore: store, document: doc.win as unknown as Document }),
      );
      doc.emit('wheel', {
        deltaX: 0,
        deltaY: 11,
        deltaMode: 0,
        clientX: 1,
        clientY: 1,
        buttons: 0,
      });
      client.startBlackout();
      doc.emit('wheel', {
        deltaX: 0,
        deltaY: 22,
        deltaMode: 0,
        clientX: 1,
        clientY: 1,
        buttons: 0,
      });
      client.endBlackout();
      await new Promise((resolve) => setTimeout(resolve, 60)); // the frame (16ms fallback) flushes
      expect(await drain(store, 'input')).toBeUndefined();
    });

    it('does NOT suppress non-visual capture: logs, events and app breadcrumbs continue', async () => {
      const store = memStore();
      const client = await launchTracked('tok', baseOptions({ captureStore: store }));
      client.startBlackout();
      client.log('kept');
      client.event('kept-event');
      client.addBreadcrumb({ category: 'app.step', message: 'kept' });
      expect(await drain(store, 'log')).toHaveLength(1);
      expect(await drain(store, 'events.user')).toHaveLength(1);
      expect(
        (await drain(store, 'breadcrumbs'))?.map((e) => (e.data as { category: string }).category),
      ).toEqual(['app.step']);
    });

    it('a report built DURING a blackout carries no viewtree; one built after it does', async () => {
      const transport = uploadTransport();
      const doc = fakeDocument(viewEl('body', { children: [viewEl('main')] }));
      const client = await launchTracked(
        'tok',
        baseOptions({ transport, captureStore: memStore(), document: doc }),
      );
      const bundleFiles = (n: number): Record<string, Uint8Array> => {
        const puts = transport.mock.calls.filter(([url]) => url === 'https://s3.test/put');
        return unzipSync((puts[n]?.[1] as HttpRequestOptions).body as Uint8Array);
      };
      client.startBlackout();
      await client.upload({ summary: 'during' });
      expect(bundleFiles(0)['viewtree.json']).toBeUndefined();
      client.endBlackout();
      await client.upload({ summary: 'after' });
      expect(bundleFiles(1)['viewtree.json']).toBeDefined();
    });

    describe('startInBlackout: a page that loads already blacked out', () => {
      it('defaults to NOT blacked out', async () => {
        const client = await launchTracked('tok', baseOptions({ captureStore: memStore() }));
        expect(client.isBlackout()).toBe(false);
      });

      it('launches with the blackout already in force, so isBlackout() is true from the first tick', async () => {
        const client = await launchTracked(
          'tok',
          baseOptions({ captureStore: memStore(), startInBlackout: true }),
        );
        expect(client.isBlackout()).toBe(true);
        client.endBlackout();
        expect(client.isBlackout()).toBe(false);
      });

      it('captures NO input / ui breadcrumbs / wheel between launch and endBlackout()', async () => {
        const store = memStore();
        const doc = fakeWindow();
        const client = await launchTracked(
          'tok',
          baseOptions({
            captureStore: store,
            document: doc.win as unknown as Document,
            startInBlackout: true,
          }),
        );
        press(doc, 1);
        doc.emit('focusin', { target: field });
        doc.emit('change', { target: field });
        client.endBlackout();
        press(doc, 2);
        const input = await drain(store, 'input');
        expect(input?.map((e) => (e.data as { x: number }).x)).toEqual([2]);
        expect(await drain(store, 'breadcrumbs')).toBeUndefined();
      });

      it('a report built before endBlackout() carries no viewtree', async () => {
        const transport = uploadTransport();
        const doc = fakeDocument(viewEl('body', { children: [viewEl('main')] }));
        const client = await launchTracked(
          'tok',
          baseOptions({
            transport,
            captureStore: memStore(),
            document: doc,
            startInBlackout: true,
          }),
        );
        await client.upload({ summary: 'dark' });
        const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
        const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
        expect(files['viewtree.json']).toBeUndefined();
      });

      it('the replay recorder is handed a gate that is ALREADY active when it is registered', async () => {
        await launchTracked(
          'tok',
          baseOptions({ document: fakeDocument(viewEl('body')), startInBlackout: true }),
        );
        await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
        const options = registerReplay.mock.calls[0]?.[2] as { blackout: { isActive(): boolean } };
        expect(options.blackout.isActive()).toBe(true);
      });

      it('the canonical key `com.bugsee.option.capture.start-in-blackout` is reported in sdk.options', async () => {
        const client = await launchTracked(
          'tok',
          baseOptions({ captureStore: memStore(), startInBlackout: true }),
        );
        expect(client.getLaunchOptions()).toMatchObject({
          'com.bugsee.option.capture.start-in-blackout': true,
        });
      });

      it('the blackout is already in force when the FIRST provider starts', async () => {
        const carrier = {};
        const atStart: boolean[] = [];
        contributeServiceManifest((registrar) => {
          // The manifest is handed the client itself at runtime (typed narrowly as a registrar).
          const internal = registrar as unknown as {
            addCaptureProvider(provider: unknown): void;
            isBlackout(): boolean;
          };
          internal.addCaptureProvider({
            name: 'probe',
            init: () => {},
            start: () => atStart.push(internal.isBlackout()),
            stop: () => {},
          });
        }, carrier);
        await launchTracked(
          'tok',
          baseOptions({ captureStore: memStore(), startInBlackout: true, carrier }),
        );
        expect(atStart).toEqual([true]);
      });

      it('BlackoutStarted comes AFTER Launching, exactly once, never before it', async () => {
        const seen: string[] = [];
        await launchTracked(
          'tok',
          baseOptions({
            captureStore: memStore(),
            startInBlackout: true,
            lifecycleEventsListener: (type) => seen.push(type),
          }),
        );
        const names = seen
          .filter((t) => /Launching|Launched|Blackout/.test(t))
          .map((t) => t.split('.').at(-1));
        expect(names).toEqual(['Launching', 'Launched', 'BlackoutStarted']);
      });

      it('an internal launch HOLD is dark but silent: no event on hold, none on its release', async () => {
        const seen: string[] = [];
        const client = await launchTracked(
          'tok',
          baseOptions({
            captureStore: memStore(),
            holdBlackout: true,
            lifecycleEventsListener: (type) => seen.push(type.split('.').at(-1) as string),
          }),
        );
        expect(client.isBlackout()).toBe(true);
        client.getService(BlackoutToken).end({ silent: true });
        expect(client.isBlackout()).toBe(false);
        expect(seen.filter((t) => t.startsWith('Blackout'))).toEqual([]);
      });

      it('a non-true value does not black the page out', async () => {
        const client = await launchTracked(
          'tok',
          baseOptions({ captureStore: memStore(), startInBlackout: false }),
        );
        expect(client.isBlackout()).toBe(false);
      });
    });

    it('hands the replay recorder the client blackout gate so it follows the blackout', async () => {
      const client = await launchTracked(
        'tok',
        baseOptions({ document: fakeDocument(viewEl('body')) }),
      );
      await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
      const options = registerReplay.mock.calls[0]?.[2] as {
        blackout: { isActive(): boolean };
      };
      expect(options.blackout.isActive()).toBe(false);
      client.startBlackout();
      expect(options.blackout.isActive()).toBe(true);
    });
  });

  it('omits the viewtree when captureViewHierarchy is disabled', async () => {
    const transport = uploadTransport();
    const doc = fakeDocument(viewEl('body'));
    const client = await launchTracked(
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
    await launchTracked('tok', baseOptions({ captureStore: store }));
    const traces = await drain(store, 'traces.system');
    expect(traces?.map((e) => (e.data as { name: string }).name)).toContain('ram_js_heap_used');
  });

  it('does not capture system traces when disabled', async () => {
    const store = memStore();
    await launchTracked('tok', baseOptions({ captureStore: store, captureSystemTraces: false }));
    expect(await drain(store, 'traces.system')).toBeUndefined();
  });

  const batteryManager = () => ({
    level: 0.5,
    charging: true,
    addEventListener() {},
    removeEventListener() {},
  });

  it('drives battery/charging through the real provider: getBattery is called and traces are stored', async () => {
    const getBattery = vi.fn(() => Promise.resolve(batteryManager()));
    vi.stubGlobal('navigator', { getBattery });
    const store = memStore();
    await launchTracked('tok', baseOptions({ captureStore: store }));
    await new Promise((r) => setTimeout(r, 0));
    expect(getBattery).toHaveBeenCalledTimes(1);
    const traces = (await drain(store, 'traces.system'))?.map(
      (e) => e.data as { name: string; value: unknown },
    );
    expect(traces).toContainEqual(expect.objectContaining({ name: 'battery', value: 50 }));
    expect(traces).toContainEqual(
      expect.objectContaining({ name: 'charging', value: { state: 2 } }),
    );
  });

  it('a battery manager that throws after getBattery resolves reaches options.onError', async () => {
    const getBattery = vi.fn(() =>
      Promise.resolve({
        ...batteryManager(),
        addEventListener() {
          throw new Error('battery add refused');
        },
      }),
    );
    vi.stubGlobal('navigator', { getBattery });
    const onError = vi.fn();
    await launchTracked('tok', baseOptions({ captureStore: memStore(), onError }));
    await new Promise((r) => setTimeout(r, 0));
    expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toContain('battery add refused');
  });

  it.each([
    { maxRecordingTime: 20, refreshMs: 5000 }, // 20s/4 = 5s
    { maxRecordingTime: 8, refreshMs: 2000 }, // 8s/4 = 2s, exactly the floor
    { maxRecordingTime: 2, refreshMs: 2000 }, // 0.5s clamped up to the 2s floor (2 x the 1s interval)
    { maxRecordingTime: 600, refreshMs: 10_000 }, // 150s clamped down to 10s
  ])('refreshes the held battery trace after $refreshMs ms (recording window $maxRecordingTime s)', async ({
    maxRecordingTime,
    refreshMs,
  }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      vi.stubGlobal('navigator', { getBattery: () => Promise.resolve(batteryManager()) });
      const ticks: Array<{ cb: () => void; ms: number }> = [];
      const store = memStore();
      await launchTracked(
        'tok',
        baseOptions({
          captureStore: store,
          maxRecordingTime,
          scheduler: {
            setInterval: (cb, ms) => {
              ticks.push({ cb, ms });
              return `h${ticks.length}`;
            },
            clearInterval: () => {},
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 0)); // getBattery resolves: the held baseline at t=0
      const battery = async () =>
        ((await drain(store, 'traces.system')) ?? []).filter(
          (e) => (e.data as { name: string }).name === 'battery',
        ).length;
      const tick = () => {
        for (const t of ticks.filter((x) => x.ms === 1000)) t.cb();
      };
      expect(await battery()).toBe(1);
      vi.setSystemTime(refreshMs - 1);
      tick();
      expect(await battery()).toBe(1);
      vi.setSystemTime(refreshMs);
      tick();
      expect(await battery()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls getBattery when captureSystemTraces is false', async () => {
    const getBattery = vi.fn(() => Promise.resolve(batteryManager()));
    vi.stubGlobal('navigator', { getBattery });
    await launchTracked(
      'tok',
      baseOptions({ captureStore: memStore(), captureSystemTraces: false }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(getBattery).not.toHaveBeenCalled();
  });

  describe('default sensor traces (tracker-backed producers, no sampler override)', () => {
    // The shipped path: no `systemMetricsSampler`, so heap / connection / orientation come from the
    // trackers over the injected window + the live globals.
    const noSampler = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => {
      const { systemMetricsSampler: _legacy, ...rest } = baseOptions(over);
      return rest;
    };
    const stubSensors = (): void => {
      vi.stubGlobal('navigator', {
        onLine: true,
        deviceMemory: 4,
        connection: { type: 'wifi', effectiveType: '4g' },
      });
      vi.stubGlobal('performance', {
        memory: { usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 100 },
      });
      vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', angle: 0 } });
    };

    it('captures heap, advertised RAM, connection and orientation from the real globals', async () => {
      stubSensors();
      const store = memStore();
      await launchTracked('tok', noSampler({ captureStore: store }));
      const rows = new Map(
        ((await drain(store, 'traces.system')) ?? []).map((e) => {
          const d = e.data as { name: string; value: unknown };
          return [d.name, d.value];
        }),
      );
      expect(rows.get('ram_js_heap_total')).toBe(100);
      expect(rows.get('ram_js_heap_free')).toBe(90);
      expect(rows.get('ram_js_heap_used')).toBe(10);
      expect(rows.get('ram_system_advertised')).toBe(4 * 1024 ** 3);
      expect(rows.get('connection')).toMatchObject({ type: 'wifi', effective_type: '4g' });
      expect(rows.get('orientation')).toBe(1);
    });

    it('captures storage_estimate (integer MB) through the per-window StorageTracker singleton', async () => {
      stubSensors();
      vi.stubGlobal('navigator', {
        storage: {
          estimate: () => Promise.resolve({ usage: 5 * 1024 * 1024 + 7, quota: 2 * 1024 ** 3 }),
          persisted: () => Promise.resolve(true),
        },
      });
      const w = fakeWindow();
      try {
        const store = memStore();
        await launchTracked('tok', noSampler({ window: w.win, captureStore: store }));
        await new Promise((r) => setTimeout(r, 0));
        const rows = new Map(
          ((await drain(store, 'traces.system')) ?? []).map((e) => {
            const d = e.data as { name: string; value: unknown };
            return [d.name, d.value];
          }),
        );
        expect(rows.get('storage_estimate')).toEqual({ usage: 5, quota: 2048 });
        // launch used the registry: the singleton for this window already holds the estimate
        expect(storageTrackerFor({ window: w.win }).current()).toEqual({
          usageBytes: 5 * 1024 * 1024 + 7,
          quotaBytes: 2 * 1024 ** 3,
          persisted: true,
        });
      } finally {
        resetStorageTracker({ window: w.win });
      }
    });

    it('captures the heap through the per-window ProcessTracker singleton (launch uses the registry)', async () => {
      stubSensors();
      const w = fakeWindow();
      try {
        const store = memStore();
        await launchTracked('tok', noSampler({ window: w.win, captureStore: store }));
        const rows = new Map(
          ((await drain(store, 'traces.system')) ?? []).map((e) => {
            const d = e.data as { name: string; value: unknown };
            return [d.name, d.value];
          }),
        );
        expect(rows.get('ram_js_heap_used')).toBe(10);
        // launch used the registry: the singleton for this window already has launch's performance seam, so it can read
        // the heap (a tracker built with `new` would be a different instance with no seams)
        expect(processTrackerFor({ window: w.win }).currentHeap()).toEqual({
          used: 10,
          limit: 100,
        });
      } finally {
        resetProcessTracker({ window: w.win });
      }
    });

    describe('user_idle_state is opt-in (captureUserIdle) and needs an already-granted permission', () => {
      const launchIdle = async (over: Partial<BugseeLaunchOptions>, permission: string) => {
        stubSensors();
        const query = vi.fn(() => Promise.resolve({ state: permission }));
        vi.stubGlobal('navigator', { onLine: true, permissions: { query } });
        const w = fakeWindow();
        class FakeDetector {
          userState = 'idle';
          screenState = 'unlocked';
          start = () => Promise.resolve(undefined);
          addEventListener = () => {};
          removeEventListener = () => {};
        }
        Object.assign(w.win, {
          IdleDetector: FakeDetector,
          AbortController: class {
            signal = {};
            abort() {}
          },
        });
        try {
          const store = memStore();
          await launchTracked('tok', noSampler({ window: w.win, captureStore: store, ...over }));
          await new Promise((r) => setTimeout(r, 0));
          const rows = new Map(
            ((await drain(store, 'traces.system')) ?? []).map((e) => {
              const d = e.data as { name: string; value: unknown };
              return [d.name, d.value];
            }),
          );
          return { rows, query };
        } finally {
          resetProcessTracker({ window: w.win });
        }
      };

      it('default: no user_idle_state and the permission is never even queried, though it is granted', async () => {
        const { rows, query } = await launchIdle({}, 'granted');
        expect(rows.has('user_idle_state')).toBe(false);
        expect(query).not.toHaveBeenCalled();
      });

      it('captureUserIdle:true + permission already granted: user_idle_state is captured', async () => {
        const { rows } = await launchIdle({ captureUserIdle: true }, 'granted');
        expect(rows.get('user_idle_state')).toBe('idle');
      });

      it('captureUserIdle:true but permission not granted: no trace (the SDK never prompts)', async () => {
        const { rows, query } = await launchIdle({ captureUserIdle: true }, 'prompt');
        expect(query).toHaveBeenCalled();
        expect(rows.has('user_idle_state')).toBe(false);
      });
    });

    it('options.scheduler drives the environment tracker slow timer: a time-zone shift becomes a timezone_changed event', async () => {
      stubSensors();
      vi.stubGlobal('navigator', { language: 'en-US' });
      const w = fakeWindow();
      const ticks: Array<{ cb: () => void; ms: number }> = [];
      try {
        const store = memStore();
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            captureStore: store,
            scheduler: {
              setInterval: (cb, ms) => {
                ticks.push({ cb, ms });
                return `h${ticks.length}`;
              },
              clearInterval: () => {},
            },
          }),
        );
        await new Promise((r) => setTimeout(r, 0));
        const slow = ticks.filter((t) => t.ms === 60_000); // the tracker's default cadence
        expect(slow).toHaveLength(1);
        const real = new Date().getTimezoneOffset();
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(real - 120);
        slow[0]?.cb();
        const events = ((await drain(store, 'events.system')) ?? []).map(
          (e) => e.data as { name: string; params?: { utcOffsetMinutes?: number } },
        );
        expect(
          events
            .filter((e) => e.name === 'timezone_changed')
            .map((e) => e.params?.utcOffsetMinutes),
        ).toEqual([-(real - 120) + 0]);
      } finally {
        vi.restoreAllMocks();
        resetEnvironmentTracker({ window: w.win });
      }
    });

    it('the launch document reaches the environment tracker: its visibility gates the slow tick and a return to visible re-reads', async () => {
      stubSensors();
      vi.stubGlobal('navigator', { language: 'en-US' });
      const w = fakeWindow();
      const d = fakeWindow();
      const vis = { state: 'visible' };
      const document = Object.defineProperty({ ...d.win, body: {} }, 'visibilityState', {
        get: () => vis.state,
      }) as unknown as Document;
      const ticks: Array<{ cb: () => void; ms: number }> = [];
      try {
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            document,
            captureStore: memStore(),
            scheduler: {
              setInterval: (cb, ms) => {
                ticks.push({ cb, ms });
                return `h${ticks.length}`;
              },
              clearInterval: () => {},
            },
          }),
        );
        const tracker = environmentTrackerFor({ window: w.win });
        const slow = ticks.filter((t) => t.ms === 60_000);
        expect(slow).toHaveLength(1);
        const real = new Date().getTimezoneOffset();
        expect(tracker.current().timeZone?.utcOffsetMinutes).toBe(-real + 0);
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(real - 45);
        vis.state = 'hidden';
        slow[0]?.cb();
        d.emit('visibilitychange', {});
        expect(tracker.current().timeZone?.utcOffsetMinutes).toBe(-real + 0); // hidden: nothing re-read
        vis.state = 'visible';
        d.emit('visibilitychange', {});
        expect(tracker.current().timeZone?.utcOffsetMinutes).toBe(-(real - 45) + 0);
      } finally {
        vi.restoreAllMocks();
        environmentTrackerFor({ window: w.win }).reset();
      }
    });

    it('launch goes through the per-window EnvironmentTracker singleton (language/timezone and private mode on by default, no hints/permissions)', async () => {
      stubSensors();
      const estimate = vi.fn(() => Promise.resolve({ usage: 1, quota: 10 * 1024 * 1024 }));
      const query = vi.fn(() => Promise.resolve({ state: 'granted' }));
      vi.stubGlobal('navigator', {
        language: 'en-US',
        languages: ['en-US', 'en'],
        cookieEnabled: true,
        permissions: { query },
        storage: { estimate },
      });
      const w = fakeWindow();
      try {
        const store = memStore();
        await launchTracked('tok', noSampler({ window: w.win, captureStore: store }));
        await new Promise((r) => setTimeout(r, 0));
        const snapshot = environmentTrackerFor({ window: w.win }).current();
        expect(snapshot.language).toEqual({ language: 'en-US', languages: ['en-US', 'en'] });
        expect(snapshot.timeZone?.utcOffsetMinutes).toBeTypeOf('number');
        expect(snapshot.privateMode).toEqual({ private: 'yes', method: 'storage-quota' }); // on by default
        expect(snapshot.hints).toBeUndefined(); // nothing consumes hints / permissions: never read
        expect(snapshot.permissions).toBeUndefined();
        expect(query).not.toHaveBeenCalled();
        expect(w.count('languagechange')).toBe(1);
        const events = ((await drain(store, 'events.system')) ?? []).map(
          (e) => e.data as { name: string; params?: unknown },
        );
        expect(events.find((e) => e.name === 'private_mode_detected')?.params).toEqual({
          method: 'storage-quota',
        });
      } finally {
        resetEnvironmentTracker({ window: w.win });
      }
    });

    it('captureEnvironmentHints: false opts out of the private-mode heuristic (no probe, no event)', async () => {
      stubSensors();
      const estimate = vi.fn(() => Promise.resolve({ usage: 1, quota: 10 }));
      vi.stubGlobal('navigator', { language: 'en-US', storage: { estimate } });
      const w = fakeWindow();
      try {
        const store = memStore();
        await launchTracked(
          'tok',
          noSampler({ window: w.win, captureStore: store, captureEnvironmentHints: false }),
        );
        await new Promise((r) => setTimeout(r, 0));
        // (the storage trace tracker calls estimate() too, so the proof is the missing answer and event)
        expect(environmentTrackerFor({ window: w.win }).current().privateMode).toBeUndefined();
        const names = ((await drain(store, 'events.system')) ?? []).map(
          (e) => (e.data as { name: string }).name,
        );
        expect(names).not.toContain('private_mode_detected');
      } finally {
        resetEnvironmentTracker({ window: w.win });
      }
    });

    it('a rejected storage.estimate() reaches options.onError and never fails launch', async () => {
      stubSensors();
      const boom = new Error('estimate refused');
      vi.stubGlobal('navigator', { storage: { estimate: () => Promise.reject(boom) } });
      const onError = vi.fn();
      const w = fakeWindow();
      try {
        await launchTracked('tok', noSampler({ window: w.win, captureStore: memStore(), onError }));
        await new Promise((r) => setTimeout(r, 0));
        expect(onError).toHaveBeenCalledWith(boom);
      } finally {
        resetStorageTracker({ window: w.win });
      }
    });

    it('listens on the INJECTED window for connectivity only while capturing, and releases it on stop', async () => {
      stubSensors();
      const w = fakeWindow();
      const client = await launchTracked(
        'tok',
        // the system-events source listens on the same window, so isolate the trace trackers
        noSampler({ window: w.win, captureStore: memStore(), captureSystemEvents: false }),
      );
      // online/offline: bound ONCE, by the ConnectivityTracker (the lifecycle tracker no longer binds them)
      expect(w.count('online')).toBe(1);
      expect(w.count('offline')).toBe(1);
      expect(w.count('orientationchange')).toBe(1);
      await client.stop();
      expect(w.count('online')).toBe(0);
      expect(w.count('offline')).toBe(0);
      expect(w.count('orientationchange')).toBe(0);
    });

    it('goes through the per-window UiTracker singleton (orientation/displays/fps/events share ONE set of listeners)', async () => {
      stubSensors();
      const w = fakeWindow();
      const client = await launchTracked(
        'tok',
        noSampler({ window: w.win, captureStore: memStore() }),
      );
      const before = w.count('orientationchange');
      expect(before).toBe(1); // traces' orientation + the events source's OrientationChanged: one listener
      // Asking for the window's tracker returns the SAME one: subscribing adds no new window listener.
      const ui = uiTrackerFor({ window: w.win });
      const seen: unknown[] = [];
      const off = ui.on('orientation', (s) => seen.push(s));
      expect(w.count('orientationchange')).toBe(before);
      off();
      await client.stop();
      expect(w.count('orientationchange')).toBe(0);
      resetUiTracker({ window: w.win });
    });

    it('the video.aux viewport source goes through the per-window UiTracker: no listener of its own, and its events are unchanged', async () => {
      stubSensors();
      const w = fakeWindow();
      Object.assign(w.win, { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 });
      const store = memStore();
      const client = await launchTracked(
        'tok',
        // isolate: nothing but the viewport source touches this window
        noSampler({
          window: w.win,
          captureStore: store,
          captureSystemTraces: false,
          captureSystemEvents: false,
        }),
      );
      // ONE resize and ONE orientationchange listener, owned by the shared tracker (no own `resize` binding).
      expect(w.count('resize')).toBe(1);
      expect(w.count('orientationchange')).toBe(1);
      // The window's tracker IS the one launch subscribed through: another consumer adds no window listener.
      const ui = uiTrackerFor({ window: w.win });
      const off = ui.on('viewport', () => {});
      expect(w.count('resize')).toBe(1);
      expect(w.count('orientationchange')).toBe(1);
      off();
      expect(w.count('resize')).toBe(1); // still held by the viewport source
      Object.assign(w.win, { innerWidth: 800, innerHeight: 600 });
      w.emit('resize', {});
      await new Promise((r) => setTimeout(r, 50)); // the source coalesces onto an animation frame / timer
      const rows = ((await drain(store, 'video.aux')) ?? []).map((e) => e.data);
      expect(rows).toMatchObject([
        { frameW: 390, frameH: 844, density: 3 },
        { frameW: 800, frameH: 600, density: 3 },
      ]);
      await client.stop();
      expect(w.count('resize')).toBe(0);
      expect(w.count('orientationchange')).toBe(0);
      resetUiTracker({ window: w.win });
    });

    it("after a relaunch the shared UiTracker reports to the LATEST launch (the carrier-shared viewport source must not pin the first launch's onError)", async () => {
      const armed = { on: false };
      vi.stubGlobal('screen', {
        get width(): number {
          if (armed.on) throw new Error('screen.width blocked');
          return 390;
        },
        height: 844,
      });
      stubSensors();
      vi.stubGlobal('screen', {
        get width(): number {
          if (armed.on) throw new Error('screen.width blocked');
          return 390;
        },
        height: 844,
      });
      const w = fakeWindow();
      Object.assign(w.win, { innerWidth: 390, innerHeight: 844, devicePixelRatio: 2 });
      const carrier = {};
      const errA = vi.fn();
      const errB = vi.fn();
      const common = {
        window: w.win,
        carrier,
        captureStore: memStore(),
        captureSystemTraces: false,
        captureSystemEvents: false,
      };
      const a = await launchTracked('tok', noSampler({ ...common, onError: errA }));
      await a.stop();
      await launchTracked('tok', noSampler({ ...common, captureStore: memStore(), onError: errB }));
      armed.on = true;
      w.emit('resize', {});
      expect(errB).toHaveBeenCalled();
      expect(errA).not.toHaveBeenCalled();
      armed.on = false;
      resetUiTracker({ window: w.win });
    });

    it('launch goes through the per-window ConnectivityTracker singleton: a second consumer shares its listeners, and downlinkMax reaches the trace', async () => {
      vi.stubGlobal('navigator', {
        onLine: true,
        connection: { type: 'wifi', downlink: 10, downlinkMax: 100 },
      });
      const w = fakeWindow();
      const store = memStore();
      const client = await launchTracked(
        'tok',
        noSampler({ window: w.win, captureStore: store, captureSystemEvents: false }),
      );
      const before = w.count('online'); // the connectivity tracker's alone
      // The singleton for this window is the one launch subscribed through: a new `ConnectivityTracker` would add
      // another pair of window listeners here instead of sharing the first.
      const off = connectivityTrackerFor({ window: w.win }).on('online', () => {});
      expect(w.count('online')).toBe(before);
      off();
      expect(w.count('online')).toBe(before); // launch's own subscription still holds it
      const rows = new Map(
        ((await drain(store, 'traces.system')) ?? []).map((e) => {
          const d = e.data as { name: string; value: unknown };
          return [d.name, d.value];
        }),
      );
      expect(rows.get('connection')).toMatchObject({
        type: 'wifi',
        link_downstream_kbps: 10_000,
        link_downstream_max_kbps: 100_000,
      });
      await client.stop();
      expect(w.count('online')).toBe(0);
    });

    it('with captureSystemTraces:false no sensor listener is attached and no timer is started', async () => {
      stubSensors();
      const w = fakeWindow();
      const timers = vi.fn(() => 'h');
      await launchTracked(
        'tok',
        noSampler({
          window: w.win,
          captureStore: memStore(),
          captureSystemTraces: false,
          captureSystemEvents: false, // the events source listens on the same window
          scheduler: { setInterval: timers, clearInterval: () => {} },
        }),
      );
      expect(w.count('online') + w.count('offline')).toBe(0);
      // The video.aux viewport source is the lone window consumer left; its one orientationchange is the UiTracker's.
      expect(w.count('orientationchange')).toBe(1);
      // the capture-store tick may use the scheduler; the heap poll must not add its own 1 s timer
      const heapTimers = timers.mock.calls.length;
      expect(heapTimers).toBeLessThanOrEqual(1);
    });

    it('drives the heap poll through the launch scheduler (one extra interval only where the engine has performance.memory)', async () => {
      const intervals = async (withHeap: boolean): Promise<number> => {
        stubSensors();
        if (!withHeap) vi.stubGlobal('performance', {});
        const timers = vi.fn((_cb: () => void, _ms: number) => 'h');
        await launchTracked(
          'tok',
          noSampler({
            captureStore: memStore(),
            scheduler: { setInterval: timers, clearInterval: () => {} },
          }),
        );
        return timers.mock.calls.filter(([, ms]) => ms === 1000).length;
      };
      const without = await intervals(false);
      await Promise.all(clientsStop());
      const withHeap = await intervals(true);
      expect(withHeap).toBe(without + 1);
    });

    it('reads every surface from the INJECTED window: a window without performance.memory omits the heap even when the host global has one', async () => {
      stubSensors(); // the HOST global has a heap
      const w = fakeWindow();
      Object.defineProperty(w.win, 'performance', { value: {}, configurable: true });
      const store = memStore();
      await launchTracked('tok', noSampler({ window: w.win, captureStore: store }));
      const names = ((await drain(store, 'traces.system')) ?? []).map(
        (e) => (e.data as { name: string }).name,
      );
      expect(names).not.toContain('ram_js_heap_used');
      expect(names).toContain('orientation'); // the other surfaces still come from the window
    });

    it('a window whose getters throw never fails launch: each surface is omitted and reported, the rest still record', async () => {
      stubSensors();
      const w = fakeWindow();
      const hostile = (key: string): void =>
        void Object.defineProperty(w.win, key, {
          get(): never {
            throw new Error(`${key} blocked`);
          },
          configurable: true,
        });
      for (const key of [
        'navigator',
        'performance',
        'screen',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'visualViewport',
      ]) {
        hostile(key);
      }
      const onError = vi.fn();
      const store = memStore();
      const client = await launchTracked(
        'tok',
        noSampler({ window: w.win, captureStore: store, onError }),
      );
      const names = ((await drain(store, 'traces.system')) ?? []).map(
        (e) => (e.data as { name: string }).name,
      );
      expect(names).not.toContain('ram_js_heap_used');
      expect(names).not.toContain('orientation');
      const blocked = onError.mock.calls
        .map((c) => (c[0] as Error).message)
        .filter((m) => m.endsWith(' blocked'));
      expect(blocked).toEqual(
        expect.arrayContaining([
          'navigator blocked',
          'performance blocked',
          'screen blocked',
          'requestAnimationFrame blocked',
          'cancelAnimationFrame blocked',
        ]),
      );
      await client.stop();
    });

    it('a window whose document getter throws never fails launch (reported, no document-bound capture)', async () => {
      stubSensors();
      const w = fakeWindow();
      Object.defineProperty(w.win, 'document', {
        get(): never {
          throw new Error('document blocked');
        },
        configurable: true,
      });
      const onError = vi.fn();
      const client = await launchTracked(
        'tok',
        noSampler({ window: w.win, captureStore: memStore(), onError }),
      );
      expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toContain('document blocked');
      await client.stop();
    });

    describe('app_state and fps (visibility-gated, from the injected window + document)', () => {
      const mkDoc = (visible: boolean) => {
        const l = new Map<string, Set<(e: Event) => void>>();
        const doc = {
          visibilityState: visible ? 'visible' : 'hidden',
          addEventListener: (t: string, f: (e: Event) => void) => {
            const set = l.get(t) ?? new Set();
            set.add(f);
            l.set(t, set);
          },
          removeEventListener: (t: string, f: (e: Event) => void) => void l.get(t)?.delete(f),
        };
        return {
          doc,
          setVisible: (v: boolean) => {
            doc.visibilityState = v ? 'visible' : 'hidden';
            for (const f of [...(l.get('visibilitychange') ?? [])]) f({} as Event);
          },
        };
      };
      const rowsOf = async (store: ReturnType<typeof memStore>, name: string) =>
        ((await drain(store, 'traces.system')) ?? [])
          .map((e) => e.data as { name: string; value: unknown })
          .filter((d) => d.name === name)
          .map((d) => d.value);

      it('records app_state from the injected document in the Android vocabulary and follows it', async () => {
        stubSensors();
        const d = mkDoc(true);
        const store = memStore();
        await launchTracked(
          'tok',
          noSampler({ document: d.doc as unknown as Document, captureStore: store }),
        );
        d.setVisible(false);
        d.setVisible(true);
        expect(await rowsOf(store, 'app_state')).toEqual([
          'foreground',
          'background',
          'foreground',
        ]);
      });

      it('runs the rAF loop on the INJECTED window only while visible and records the measured fps', async () => {
        stubSensors();
        const d = mkDoc(true);
        const w = fakeWindow();
        let clock = 0;
        Object.defineProperty(w.win, 'performance', {
          value: { now: () => clock },
          configurable: true,
        });
        const frames: Array<() => void> = [];
        const cancelled: number[] = [];
        Object.assign(w.win, {
          requestAnimationFrame(cb: (t: number) => void) {
            frames.push(() => cb(0));
            return frames.length;
          },
          cancelAnimationFrame(id: number) {
            cancelled.push(id);
          },
        });
        const ticks: Array<() => void> = [];
        const store = memStore();
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            document: d.doc as unknown as Document,
            captureStore: store,
            scheduler: {
              setInterval: (cb, ms) => {
                if (ms === 1000) ticks.push(cb);
                return 'h';
              },
              clearInterval: () => {},
            },
          }),
        );
        expect(frames).toHaveLength(1); // visible: loop armed on the injected window
        frames[0]?.(); // one frame, which re-arms
        frames[1]?.();
        clock = 500;
        for (const t of ticks) t();
        expect(await rowsOf(store, 'fps')).toEqual([4]); // 2 frames over 500 ms
        d.setVisible(false);
        expect(cancelled).toHaveLength(1); // hidden: the pending frame is cancelled
      });

      it('a hidden injected document never starts a frame loop', async () => {
        stubSensors();
        const d = mkDoc(false);
        const w = fakeWindow();
        let armed = 0;
        Object.assign(w.win, {
          requestAnimationFrame() {
            armed += 1;
            return armed;
          },
        });
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            document: d.doc as unknown as Document,
            captureStore: memStore(),
          }),
        );
        expect(armed).toBe(0);
      });

      it('records the displays list from the INJECTED window (device pixels, scale) and follows its resize', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 390, height: 844 });
        const w = fakeWindow();
        Object.assign(w.win, { devicePixelRatio: 2 });
        const store = memStore();
        const settle: Array<() => void> = [];
        const scheduler = {
          setInterval: (cb: () => void, ms: number) => {
            if (ms === 250) settle.push(cb); // the displays settle timer (never cleared in this test)
            return settle.length;
          },
          clearInterval: () => {},
        };
        await launchTracked('tok', noSampler({ window: w.win, captureStore: store, scheduler }));
        Object.assign(w.win, { devicePixelRatio: 3 });
        w.emit('resize', {});
        expect(settle).toHaveLength(1); // settled, not written immediately
        settle[0]?.();
        expect(await rowsOf(store, 'displays')).toEqual([
          [{ id: 0, state: 'on', width: 780, height: 1688, scale: 2 }],
          [{ id: 0, state: 'on', width: 1170, height: 2532, scale: 3 }],
        ]);
      });

      it('hostOwnedTraces: [displays] (an Electron renderer) writes no displays trace even with a readable screen', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 390, height: 844 });
        const w = fakeWindow();
        Object.assign(w.win, { devicePixelRatio: 2 });
        const store = memStore();
        await launchTracked(
          'tok',
          noSampler({ window: w.win, captureStore: store, hostOwnedTraces: ['displays'] }),
        );
        expect(await rowsOf(store, 'displays')).toEqual([]);
      });

      it('a non-string element in hostOwnedTraces is dropped and reported; the valid names still apply', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 390, height: 844 });
        const w = fakeWindow();
        Object.assign(w.win, { devicePixelRatio: 2 });
        const store = memStore();
        const onError = vi.fn();
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            captureStore: store,
            onError,
            hostOwnedTraces: [123, 'displays'] as never,
          }),
        );
        expect(await rowsOf(store, 'displays')).toEqual([]);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(String(onError.mock.calls[0]?.[0])).toMatch(/hostOwnedTraces/);
      });

      it('a clean hostOwnedTraces reports nothing', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 390, height: 844 });
        const w = fakeWindow();
        Object.assign(w.win, { devicePixelRatio: 2 });
        const onError = vi.fn();
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            captureStore: memStore(),
            onError,
            hostOwnedTraces: ['displays'],
          }),
        );
        expect(onError).not.toHaveBeenCalled();
      });

      it.each([
        ['a string', 'displays'],
        ['a number', 7],
        ['an object', { includes: 1 }],
      ])('a non-array hostOwnedTraces (%s) is ignored and reported (displays stays on), never a failed launch', async (_n, bad) => {
        stubSensors();
        vi.stubGlobal('screen', { width: 390, height: 844 });
        const w = fakeWindow();
        Object.assign(w.win, { devicePixelRatio: 2 });
        const store = memStore();
        const onError = vi.fn();
        await launchTracked(
          'tok',
          noSampler({ window: w.win, captureStore: store, onError, hostOwnedTraces: bad as never }),
        );
        expect(await rowsOf(store, 'displays')).toEqual([
          [{ id: 0, state: 'on', width: 780, height: 1688, scale: 2 }],
        ]);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(String(onError.mock.calls[0]?.[0])).toMatch(/hostOwnedTraces/);
      });

      describe('the route and view traces (client.setRoute / client.setView)', () => {
        it('writes what the application reports, held and sanitized, through the carrier-shared tracker', async () => {
          stubSensors();
          const store = memStore();
          const client = await launchTracked(
            'tok',
            noSampler({ window: fakeWindow().win, captureStore: store, carrier: {} }),
          );
          expect(await rowsOf(store, 'route')).toEqual([]); // never fabricated: nothing until the app reports one
          expect(await rowsOf(store, 'view')).toEqual([]);
          client.setRoute('/orders/:id?token=abc');
          client.setRoute('/orders/:id'); // equal once the query is gone: not written again
          client.setRoute('/cart');
          client.setView({ name: 'OrderDetail', type: 'react' });
          client.setView(null);
          expect(await rowsOf(store, 'route')).toEqual(['/orders/:id', '/cart']);
          expect(await rowsOf(store, 'view')).toEqual([
            { name: 'OrderDetail', type: 'react' },
            '$$none',
          ]);
        });

        it('writes a route set BEFORE launch at launch (an adapter wires at app start), and survives a systemMetricsSampler', async () => {
          stubSensors();
          const carrier = {};
          screenTrackerFor(carrier).setRoute('/early');
          const store = memStore();
          await launchTracked(
            'tok',
            baseOptions({ window: fakeWindow().win, captureStore: store, carrier }),
          );
          expect(await rowsOf(store, 'route')).toEqual(['/early']);
        });
      });

      describe('the url trace (captureUrl / urlSanitizer)', () => {
        // A window with a location and a real-shaped History: pushState moves the location, as a browser does.
        const urlWindow = (href: string) => {
          const w = fakeWindow();
          const location = { pathname: new URL(href).pathname, href };
          const history = {
            pushState(_s: unknown, _t: string, next: string) {
              const u = new URL(next, location.href);
              location.href = u.href;
              location.pathname = u.pathname;
            },
            replaceState() {},
          };
          Object.assign(w.win, { location, history });
          return { ...w, history };
        };

        it('records the SANITIZED location at start and on every navigation, held, from the injected window', async () => {
          stubSensors();
          const w = urlWindow('https://a.com/a?token=abc&tab=1');
          const store = memStore();
          await launchTracked('tok', noSampler({ window: w.win, captureStore: store }));
          w.history.pushState({}, '', '/b?api_key=zzz');
          w.history.pushState({}, '', '/b?api_key=yyy'); // equal once sanitized: not written again
          w.history.pushState({}, '', '/c');
          expect(await rowsOf(store, 'url')).toEqual([
            'https://a.com/a?token=%3Credacted%3E&tab=1',
            'https://a.com/b?api_key=%3Credacted%3E',
            'https://a.com/c',
          ]);
        });

        it('survives a systemMetricsSampler (the url trace is not a sensor)', async () => {
          stubSensors();
          const w = urlWindow('https://a.com/x');
          const store = memStore();
          await launchTracked('tok', baseOptions({ window: w.win, captureStore: store }));
          expect(await rowsOf(store, 'url')).toEqual(['https://a.com/x']);
        });

        it('captureUrl:false writes no url trace and never patches the window history', async () => {
          stubSensors();
          const w = urlWindow('https://a.com/x');
          const patched = w.history.pushState;
          const store = memStore();
          await launchTracked(
            'tok',
            noSampler({ window: w.win, captureStore: store, captureUrl: false }),
          );
          expect(w.history.pushState).toBe(patched);
          expect(await rowsOf(store, 'url')).toEqual([]);
        });

        it('urlSanitizer runs after the default and its result is written as given', async () => {
          stubSensors();
          const w = urlWindow('https://u:pw@a.com/orders/42?token=abc');
          const seen: string[] = [];
          const store = memStore();
          await launchTracked(
            'tok',
            noSampler({
              window: w.win,
              captureStore: store,
              urlSanitizer: (u) => {
                seen.push(u);
                return u.replace('/orders/42', '/orders/:id');
              },
            }),
          );
          expect(seen).toEqual(['https://u:%3Credacted%3E@a.com/orders/42?token=%3Credacted%3E']);
          expect(await rowsOf(store, 'url')).toEqual([
            'https://u:%3Credacted%3E@a.com/orders/:id?token=%3Credacted%3E',
          ]);
        });

        it('a throwing urlSanitizer is reported, writes nothing, and never fails the launch', async () => {
          stubSensors();
          const w = urlWindow('https://a.com/x');
          const onError = vi.fn();
          const store = memStore();
          await launchTracked(
            'tok',
            noSampler({
              window: w.win,
              captureStore: store,
              onError,
              urlSanitizer: () => {
                throw new Error('hook');
              },
            }),
          );
          expect(await rowsOf(store, 'url')).toEqual([]);
          expect(onError).toHaveBeenCalledTimes(1);
        });

        it('a non-function urlSanitizer is ignored and reported; the default still writes', async () => {
          stubSensors();
          const w = urlWindow('https://a.com/x?token=1');
          const onError = vi.fn();
          const store = memStore();
          await launchTracked(
            'tok',
            noSampler({
              window: w.win,
              captureStore: store,
              onError,
              urlSanitizer: 'nope' as never,
            }),
          );
          expect(await rowsOf(store, 'url')).toEqual(['https://a.com/x?token=%3Credacted%3E']);
          expect(onError).toHaveBeenCalledTimes(1);
          expect(String(onError.mock.calls[0]?.[0])).toMatch(/urlSanitizer must be a function/);
        });

        it('a window without a location writes no url and reports nothing', async () => {
          stubSensors();
          const onError = vi.fn();
          const store = memStore();
          await launchTracked(
            'tok',
            noSampler({ window: fakeWindow().win, captureStore: store, onError }),
          );
          expect(await rowsOf(store, 'url')).toEqual([]);
          expect(onError).not.toHaveBeenCalled();
        });
      });

      it('displays is omitted (not 0) when the window has no readable screen or pixel ratio', async () => {
        stubSensors(); // the stubbed screen has no width/height
        const w = fakeWindow();
        Object.assign(w.win, { devicePixelRatio: 2 });
        const store = memStore();
        await launchTracked('tok', noSampler({ window: w.win, captureStore: store }));
        expect(await rowsOf(store, 'displays')).toEqual([]);
      });

      it('records main_thread_lag_ms as timer drift on the INJECTED window clock, visible only, with a fresh baseline after a hide', async () => {
        stubSensors();
        const d = mkDoc(true);
        const w = fakeWindow();
        let clock = 5_000;
        Object.defineProperty(w.win, 'performance', {
          value: { now: () => clock },
          configurable: true,
        });
        const live = new Map<number, () => void>();
        let nextHandle = 1;
        const store = memStore();
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            document: d.doc as unknown as Document,
            captureStore: store,
            scheduler: {
              setInterval: (cb, ms) => {
                if (ms !== 1000) return 'other';
                const h = nextHandle++;
                live.set(h, cb);
                return h;
              },
              clearInterval: (h) => void live.delete(h as number),
            },
          }),
        );
        const runTicks = (): void => {
          for (const cb of [...live.values()]) cb();
        };
        clock += 1000;
        runTicks(); // on time
        clock += 1000 + 300; // a 300 ms block spans the next tick
        runTicks();
        const before = live.size;
        d.setVisible(false);
        const hiddenTimers = live.size;
        clock += 60_000;
        d.setVisible(true); // a fresh baseline: the hidden minute is not lag
        clock += 1000;
        runTicks();
        // fps shares the 1 s cadence but emits its own name; only the lag rows are read here
        expect(await rowsOf(store, 'main_thread_lag_ms')).toEqual([0, 300, 0]);
        expect(hiddenTimers).toBeLessThan(before); // hiding tore the sampling timer(s) down
      });

      it('a hidden injected document never reads the clock for lag (no timer is started)', async () => {
        stubSensors();
        const d = mkDoc(false);
        const w = fakeWindow();
        let reads = 0;
        Object.defineProperty(w.win, 'performance', {
          value: {
            now: () => {
              reads += 1;
              return 0;
            },
          },
          configurable: true,
        });
        await launchTracked(
          'tok',
          noSampler({
            window: w.win,
            document: d.doc as unknown as Document,
            captureStore: memStore(),
          }),
        );
        expect(reads).toBe(0);
      });

      it('a hostile devicePixelRatio getter never fails launch and is reported', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 390, height: 844 });
        const w = fakeWindow();
        Object.defineProperty(w.win, 'devicePixelRatio', {
          get(): never {
            throw new Error('devicePixelRatio blocked');
          },
          configurable: true,
        });
        const onError = vi.fn();
        const store = memStore();
        const client = await launchTracked(
          'tok',
          noSampler({ window: w.win, captureStore: store, onError }),
        );
        const messages = onError.mock.calls.map((c) => (c[0] as Error).message);
        expect(messages).toContain('devicePixelRatio blocked');
        expect(await rowsOf(store, 'displays')).toEqual([]);
        await client.stop();
      });

      it('a systemMetricsSampler override builds neither displays nor the lag timer', async () => {
        stubSensors();
        vi.stubGlobal('screen', { width: 390, height: 844 });
        const d = mkDoc(true);
        const w = fakeWindow();
        let reads = 0;
        Object.assign(w.win, { devicePixelRatio: 2 });
        Object.defineProperty(w.win, 'performance', {
          value: {
            now: () => {
              reads += 1;
              return 0;
            },
          },
          configurable: true,
        });
        const store = memStore();
        await launchTracked(
          'tok',
          baseOptions({
            window: w.win,
            document: d.doc as unknown as Document,
            captureStore: store,
          }),
        );
        expect(await rowsOf(store, 'displays')).toEqual([]);
        expect(reads).toBe(0); // no lag timer was even built
      });

      it('a systemMetricsSampler override omits app_state and fps with the other sensor traces', async () => {
        stubSensors();
        const d = mkDoc(true);
        const w = fakeWindow();
        let armed = 0;
        Object.assign(w.win, {
          requestAnimationFrame() {
            armed += 1;
            return armed;
          },
        });
        const store = memStore();
        await launchTracked(
          'tok',
          baseOptions({
            window: w.win,
            document: d.doc as unknown as Document,
            captureStore: store,
          }),
        );
        expect(await rowsOf(store, 'app_state')).toEqual([]);
        expect(armed).toBe(0); // no frame loop was even built
      });
    });

    it('a systemMetricsSampler REPLACES the sensor traces (no duplicate heap rows, no sensor listeners); battery still runs', async () => {
      stubSensors();
      const w = fakeWindow();
      const store = memStore();
      await launchTracked(
        'tok',
        baseOptions({
          window: w.win,
          captureStore: store,
          captureSystemEvents: false,
          systemMetricsSampler: () => [{ name: 'ram_js_heap_used', value: 42 }],
        }),
      );
      const names = ((await drain(store, 'traces.system')) ?? []).map(
        (e) => (e.data as { name: string; value: unknown }).name,
      );
      expect(names.filter((n) => n === 'ram_js_heap_used')).toHaveLength(1);
      expect(names).not.toContain('connection');
      expect(names).not.toContain('orientation');
      expect(w.count('online') + w.count('offline')).toBe(0);
      expect(w.count('orientationchange')).toBe(1); // the video.aux viewport source, via the UiTracker
    });

    it('an offline event is captured as a not_reachable connection row', async () => {
      stubSensors();
      const nav = (globalThis as { navigator: { onLine: boolean } }).navigator;
      const w = fakeWindow();
      const store = memStore();
      await launchTracked('tok', noSampler({ window: w.win, captureStore: store }));
      nav.onLine = false;
      w.emit('offline', {});
      const types = ((await drain(store, 'traces.system')) ?? [])
        .map((e) => e.data as { name: string; value: { type?: string } })
        .filter((d) => d.name === 'connection')
        .map((d) => d.value.type);
      expect(types).toEqual(['wifi', 'not_reachable']);
    });
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
      await launchTracked('tok', baseOptions({ captureNetwork: true, captureStore: store }));
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
    const client = await launchTracked('tok', baseOptions({ captureStore: store, onError }));
    client.setLogEventFilter(() => {
      throw new Error('filter boom');
    });
    console.log('triggers the throwing filter');
    await drain(store, 'log');
    expect(onError).toHaveBeenCalled(); // the client received launch's onError sink
  });

  it('registers window error + unhandledrejection detection providers on the window', async () => {
    const w = fakeWindow();
    await launchTracked('tok', baseOptions({ window: w.win, captureStore: memStore() }));
    expect(w.count('error')).toBe(1);
    expect(w.count('unhandledrejection')).toBe(1);
  });

  it('registers no detection listeners when detectCrashes is false', async () => {
    const w = fakeWindow();
    await launchTracked(
      'tok',
      baseOptions({ window: w.win, captureStore: memStore(), detectCrashes: false }),
    );
    expect(w.count('error')).toBe(0);
    expect(w.count('unhandledrejection')).toBe(0);
  });

  it('removes the detection listeners on stop', async () => {
    const w = fakeWindow();
    const client = await launch('tok', baseOptions({ window: w.win, captureStore: memStore() }));
    expect(w.count('error')).toBe(1);
    await client.stop();
    expect(w.count('error')).toBe(0);
    expect(w.count('unhandledrejection')).toBe(0);
  });

  it('tags every SDK request with X-Bugsee-Internal and targets the default endpoint', async () => {
    const transport = uploadTransport();
    const client = await launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    await client.logException(new Error('x'));
    expect(transport.mock.calls[0]?.[0]).toBe('https://api.bugsee.com/v2/sessions');
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    expect((put?.[1] as HttpRequestOptions).headers?.['x-bugsee-internal']).toBe('1');
  });

  it('honours a custom endpoint', async () => {
    const transport = uploadTransport();
    const client = await launchTracked(
      'tok',
      baseOptions({ transport, captureStore: memStore(), endpoint: 'https://eu.bugsee.test' }),
    );
    await client.logException(new Error('x'));
    expect(transport.mock.calls[0]?.[0]).toBe('https://eu.bugsee.test/v2/sessions');
  });

  it('builds a web environment envelope with sdk version, gates, and app defaults', async () => {
    const transport = uploadTransport();
    const client = await launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    await client.logException(new Error('x'));
    const env = (
      JSON.parse(String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body)) as {
        environment: EnvironmentEnvelope;
      }
    ).environment;
    // The OS, derived in-browser — `platform` is no longer the sandbox tag with a UA string for a
    // version, and the runtime/browser identity has its own blocks.
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
      const client = await launchTracked(
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
    const client = await launchTracked(
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

  it('registers the process-global interceptor singletons on the carrier (one patch each)', async () => {
    const carrier = {};
    await launchTracked('tok', baseOptions({ captureStore: memStore(), carrier }));
    const reg = getCarrier(carrier).interceptors;
    expect(reg.get('console')).toBeDefined();
    expect(reg.get('fetch')).toBeDefined();
    expect(reg.get('browser-input')).toBeDefined();
    expect(reg.get('browser-ui-breadcrumbs')).toBeDefined();
    // The frame `browser-input`'s coordinates are measured in — shared on the carrier for the same
    // reason the input source is: one set of window listeners per process, not one per launch.
    expect(reg.get('browser-viewport')).toBeDefined();
    // The navigation source behind the `url` trace: shared so `history` is patched once per process.
    expect(reg.get('browser-navigation')).toBeDefined();
    // console + browser-input + browser-ui-breadcrumbs + browser-viewport + browser-navigation + the 6
    // cross-runtime network leaves (fetch/xhr/sendBeacon/websocket/sse/webtransport) = 11. No node-http.
    expect(reg.get('sendbeacon')).toBeDefined();
    expect(reg.size).toBe(11);
  });

  it('is a per-process singleton: a second launch() warns, is ignored, and returns the first', async () => {
    const carrier = {};
    const onError = vi.fn();
    const first = await launchTracked(
      'tok',
      baseOptions({ captureStore: memStore(), carrier, onError }),
    );
    const second = await launchTracked(
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
    await launchTracked(
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
    await launchTracked(
      'tok',
      baseOptions({ bundleStore: store, captureStore: memStore(), recover: false }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(map.has(id)).toBe(true); // never recovered
  });

  it('persists then removes a bundle through the durable queue on a successful upload', async () => {
    const { store, puts, map } = bundleMemStore();
    const transport = uploadTransport();
    const client = await launchTracked(
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
    await launchTracked(
      'tok',
      baseOptions({ transport, bundleStore: store, captureStore: memStore() }),
    );
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
    await launchTracked(
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
    await launchTracked(
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
    const client = await launchTracked('tok', baseOptions({ persist: true }));
    expect(client.isLaunched()).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // let async hydration settle
  });

  describe('persist default', () => {
    const databaseNames = async (idb: IDBFactory): Promise<string[]> =>
      (await idb.databases()).map((d) => d.name ?? '');

    it('persists by default when IndexedDB is available: the capture database is created', async () => {
      const idb = new IDBFactory();
      vi.stubGlobal('indexedDB', idb);
      await launchTracked('tok', baseOptions({ persist: undefined, locks: fakeWebLocks() }));
      await vi.waitFor(async () =>
        expect(await databaseNames(idb)).toContain(captureDatabaseName('tok')),
      );
    });

    it('treats an injected indexedDB as availability too', async () => {
      const idb = new IDBFactory();
      await launchTracked(
        'tok',
        baseOptions({ persist: undefined, indexedDB: idb, locks: fakeWebLocks() }),
      );
      await vi.waitFor(async () =>
        expect(await databaseNames(idb)).toContain(captureDatabaseName('tok')),
      );
    });

    // Reload survival and prefix GC both need Web Locks (recoverIfDead is a no-op without them), so the
    // unattended default must not strand ~10 MB per launch in the origin's quota.
    it('stays in memory by default when IndexedDB exists but Web Locks do not', async () => {
      const idb = new IDBFactory();
      vi.stubGlobal('indexedDB', idb);
      vi.stubGlobal('navigator', {});
      const client = await launchTracked('tok', baseOptions({ persist: undefined }));
      expect(() => client.getService(BundleStoreToken)).toThrow();
      expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
      expect(await databaseNames(idb)).not.toContain(captureDatabaseName('tok'));
    });

    it('persists by default when IndexedDB and the page navigator.locks are both present', async () => {
      const idb = new IDBFactory();
      vi.stubGlobal('indexedDB', idb);
      vi.stubGlobal('navigator', { locks: fakeWebLocks() });
      await launchTracked('tok', baseOptions({ persist: undefined }));
      await vi.waitFor(async () =>
        expect(await databaseNames(idb)).toContain(captureDatabaseName('tok')),
      );
    });

    it('treats a throwing navigator getter as no Web Locks instead of failing launch', async () => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('navigator', {
        get locks(): never {
          throw new Error('denied');
        },
      });
      const client = await launchTracked('tok', baseOptions({ persist: undefined }));
      expect(client.isLaunched()).toBe(true);
      expect(() => client.getService(BundleStoreToken)).toThrow();
    });

    it('explicit persist:true still opts into the documented no-locks degrade', async () => {
      const idb = new IDBFactory();
      vi.stubGlobal('indexedDB', idb);
      vi.stubGlobal('navigator', {});
      await launchTracked('tok', baseOptions({ persist: true }));
      await vi.waitFor(async () =>
        expect(await databaseNames(idb)).toContain(captureDatabaseName('tok')),
      );
    });

    it('an injected locks manager counts as Web Locks availability for the default', async () => {
      const idb = new IDBFactory();
      vi.stubGlobal('navigator', {});
      await launchTracked(
        'tok',
        baseOptions({ persist: undefined, indexedDB: idb, locks: fakeWebLocks() }),
      );
      await vi.waitFor(async () =>
        expect(await databaseNames(idb)).toContain(captureDatabaseName('tok')),
      );
    });

    // The reported effective options must say what is actually in effect, not the static `false` default.
    describe('the effective persist option follows the capability-based default', () => {
      const PERSIST = 'com.bugsee.option.browser.persist';
      it('reports true when the default turns persistence on', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        vi.stubGlobal('navigator', { locks: fakeWebLocks() });
        const client = await launchTracked('tok', baseOptions({ persist: undefined }));
        expect(client.getLaunchOptions()[PERSIST]).toBe(true);
      });

      it('reports false when Web Locks are missing and the default keeps memory', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        vi.stubGlobal('navigator', {});
        const client = await launchTracked('tok', baseOptions({ persist: undefined }));
        expect(client.getLaunchOptions()[PERSIST]).toBe(false);
      });

      it('reports false when IndexedDB is missing and the default keeps memory', async () => {
        vi.stubGlobal('indexedDB', undefined);
        vi.stubGlobal('navigator', { locks: fakeWebLocks() });
        const client = await launchTracked('tok', baseOptions({ persist: undefined }));
        expect(client.getLaunchOptions()[PERSIST]).toBe(false);
      });

      it('leaves an explicit true alone, even without Web Locks', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        vi.stubGlobal('navigator', {});
        const client = await launchTracked('tok', baseOptions({ persist: true }));
        expect(client.getLaunchOptions()[PERSIST]).toBe(true);
      });

      it('leaves an explicit false alone, even where the default would persist', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        vi.stubGlobal('navigator', { locks: fakeWebLocks() });
        const client = await launchTracked('tok', baseOptions({ persist: false }));
        expect(client.getLaunchOptions()[PERSIST]).toBe(false);
      });
    });

    it('stays in memory when persist is false, even with IndexedDB available', async () => {
      const idb = new IDBFactory();
      vi.stubGlobal('indexedDB', idb);
      const client = await launchTracked('tok', baseOptions({ persist: false }));
      expect(() => client.getService(BundleStoreToken)).toThrow();
      expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
    });

    it('stays in memory when there is no IndexedDB at all', async () => {
      vi.stubGlobal('indexedDB', undefined);
      const client = await launchTracked('tok', baseOptions({ persist: undefined }));
      expect(() => client.getService(BundleStoreToken)).toThrow();
      expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
    });

    it('treats a throwing indexedDB getter as absent instead of failing launch', async () => {
      vi.stubGlobal('indexedDB', undefined);
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        get: () => {
          throw new Error('denied');
        },
      });
      try {
        const client = await launchTracked('tok', baseOptions({ persist: undefined }));
        expect(client.isLaunched()).toBe(true);
        expect(() => client.getService(BundleStoreToken)).toThrow();
      } finally {
        Object.defineProperty(globalThis, 'indexedDB', {
          configurable: true,
          writable: true,
          value: undefined,
        });
      }
    });

    // Persisting writes captured data at rest, so a non-boolean never turns it on, and it is reported.
    it.each([
      0,
      '',
      'false',
      'true',
      1,
      null,
    ])('persist=%j (invalid) is OFF even with IndexedDB available, and reports', async (bad) => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      const onError = vi.fn();
      const client = await launchTracked(
        'tok',
        baseOptions({ persist: bad as never, onError, locks: fakeWebLocks() }),
      );
      expect(() => client.getService(BundleStoreToken)).toThrow();
      expect(
        onError.mock.calls.filter((c) =>
          String((c[0] as Error).message).startsWith('persist must be a boolean'),
        ),
      ).toHaveLength(1);
    });
  });

  it('threads onError into the persistent capture store', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = await launchTracked('tok', baseOptions({ persist: true, onError: vi.fn() }));
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
    await launchTracked('tok', baseOptions({ persist: true, scheduler, indexedDB: idb })); // no captureStore override
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

// --- capture recovery: a prior run's detected incident is rebuilt + delivered next launch -------

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

    await launchTracked(
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
    // And the LIVE sibling's marker + capture are completely untouched (the double-upload fix).
    expect(await siblingMarkers(idb, 'livesib')).toEqual(['livesib/inc-livesib']);
    expect((await siblingGenerations(idb, 'livesib')).has(700)).toBe(true);
    expect(puts).toHaveLength(1); // only the dead sibling was delivered, not the live one
  });

  it('a recovered incident carries NO app.uptime_s (it is this tab’s), while a live report does', async () => {
    const idb = new IDBFactory();
    const locks = fakeWebLocks();
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true);
    const { fn: transport, puts } = recordingTransport();
    const client = await launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks,
        systemProbe: { ...probe, uptimeSeconds: () => 77 },
      }),
    );
    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
    const appOf = (put: Uint8Array) =>
      (
        JSON.parse(strFromU8(unzipSync(put)['request.json'] as Uint8Array)) as {
          environment: { app: Record<string, unknown> };
        }
      ).environment.app;
    expect(appOf(puts[0] as Uint8Array)).not.toHaveProperty('uptime_s');
    await client.logException(new Error('live'));
    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(2));
    expect(appOf(puts[puts.length - 1] as Uint8Array).uptime_s).toBe(77);
  });

  // (recovery double-upload, confirmed on 4 samples — events_count +2 per incident, never +1): the
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

    await launchTracked(
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

    await launchTracked(
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
  // could have worked. Previously the test failed on the mutation only incidentally, through the
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

  // An explicit `bundleStore` BYPASSES coexistence: it is the integrator's own store, stable across
  // page loads, so it holds the previous session's staged bundle while that incident's marker still sits in
  // the dead session's IndexedDB namespace. Replaying it blind and then rebuilding from the marker uploaded
  // the incident twice, with DIFFERING payloads (the staged frame vs a freshly assembled zip).
  it('uploads an incident ONCE when an injected bundle store holds the blob a dead sibling’s marker covers', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true); // marker inc-deadsib + chunks
    const { store, map } = bundleMemStore();
    map.set('staged', pendingBundle('inc-deadsib (staged)', 'inc-deadsib'));
    const { fn: transport, puts } = recordingTransport();

    await launchTracked(
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

  // The SAME wiring under a RETRYABLE failure — the only condition under which routing a recovered
  // blob back through the durable queue is visible. `pipeline: baseUploadPipeline` →
  // `pipeline: durable ?? baseUploadPipeline` survived every suite across several rounds of review because every
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

    const client = await launchTracked(
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
    // A repeat stop() answers for the REAL drain, which is the retry backoff described above: the shared
    // afterEach must not wait for it, so this already-stopped client leaves the tracked list.
    clients.splice(clients.indexOf(client), 1);
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

    await launchTracked(
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

    await launchTracked(
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

    await launchTracked(
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

    await launchTracked(
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
    await launchTracked(
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

    await launchTracked(
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

    await launchTracked(
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

    await launchTracked(
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
    const client = await launchTracked('tok', baseOptions({ persist: true, clock: recoveryClock }));
    const putSpy = vi.spyOn(client.getService(ReportMarkerStoreToken), 'put');

    await client.logException(new Error('live boom'));

    expect(putSpy).toHaveBeenCalledTimes(1);
    const marker = putSpy.mock.calls[0]?.[0];
    expect(marker?.generation).toBe(1000); // this launch's capture generation
    expect(marker?.request.report.summary).toBe('live boom');
  });

  it('registers the marker store as a service in persist (recovery) mode', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = await launchTracked('tok', baseOptions({ persist: true }));
    expect(typeof client.getService(ReportMarkerStoreToken).put).toBe('function');
  });

  it('builds no marker store without persist', async () => {
    const client = await launchTracked('tok', baseOptions({ persist: false })); // in-memory store
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
  });

  it('builds no marker store when a captureStore overrides the IndexedDB backend', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = await launchTracked(
      'tok',
      baseOptions({ persist: true, captureStore: memStore() }),
    );
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
  });

  it('does not recover capture/markers when recover:false (no marker store, no upload, sibling kept)', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'x' }, true); // a dead sibling's pending incident
    const { fn: transport, puts } = recordingTransport();
    const client = await launchTracked(
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
  it('returns the public client plus a populated internals bag', async () => {
    const carrier = {};
    const { client, internals } = await launchCore(
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

  it('carries the injected endpoint + onError on the internals bag', async () => {
    const carrier = {};
    const onError = vi.fn();
    const { client, internals } = await launchCore(
      'tok',
      baseOptions({ carrier, endpoint: 'https://eu.bugsee.test', onError }),
    );
    clients.push(client);
    expect(internals?.baseUrl).toBe('https://eu.bugsee.test');
    expect(internals?.onError).toBe(onError);
    expect(internals?.appVersion).toBeUndefined();
    expect(internals?.appBuild).toBeUndefined();
  });

  it('returns internals: undefined on a repeat launch (the process singleton is already owned)', async () => {
    const carrier = {};
    const first = await launchCore('tok', baseOptions({ carrier }));
    clients.push(first.client);
    const onError = vi.fn();
    const second = await launchCore('tok', baseOptions({ carrier, onError }));
    expect(second.client).toBe(first.client); // the existing client, not a second one
    expect(second.internals).toBeUndefined(); // nothing to re-wire
    expect(onError).toHaveBeenCalledTimes(1); // the repeat-launch warning still fires
  });

  it('launch() returns exactly launchCore().client (public surface unchanged)', async () => {
    const carrier = {};
    const client = await launch('tok', baseOptions({ carrier }));
    clients.push(client);
    // A second entry via launchCore resolves the same singleton client.
    expect((await launchCore('tok', baseOptions({ carrier }))).client).toBe(client);
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
    await launchTracked('tok', domReplayOptions());
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    const call = registerReplay.mock.calls[0] as unknown[];
    expect(typeof (call[0] as { addCaptureProvider?: unknown }).addCaptureProvider).toBe(
      'function',
    );
    expect(call[1]).toEqual({}); // the shared fileEncoders map (replay writes its encoder into it)
    expect(call[2]).toEqual({ blackout: expect.any(Object) }); // no caller overrides → replay's own fail-closed defaults apply
  });

  it('records when the document arrives via window.document (the real-browser path)', async () => {
    // The gate must read the RESOLVED `domDocument` — `options.document ?? win.document` — not just the
    // injected seam. In a real browser nobody passes `document`; it comes off the window.
    const win = Object.assign(fakeWindow().win, { document: fakeDocument(viewEl('body')) });
    await launchTracked('tok', baseOptions({ window: win })); // no `document` option at all
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
  });

  it('the DEFAULT path resolves to FAIL-CLOSED masking (mask all text/inputs, block all media)', async () => {
    // The default now applies to EVERY integration that does not opt out, so "fail-closed" has to hold on
    // the default path and not merely on the opted-in one. Asserting the forwarded options object is `{}`
    // proves nothing on its own — what matters is what `{}` RESOLVES to, so run the real resolver over
    // exactly what launch forwards (importActual: this module is mocked for the rest of the file).
    await launchTracked('tok', domReplayOptions());
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
    await launchTracked('tok', domReplayOptions());
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
    const opts = registerReplay.mock.calls[0]?.[2] as { canvas?: unknown };
    expect(opts.canvas).toBeUndefined();
  });

  it('lazy-loads @bugsee/replay + registers it when replay is enabled, forwarding the options', async () => {
    await launchTracked(
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
    expect(call[2]).toEqual({
      maskAllText: false,
      checkoutEveryNms: 5000,
      blackout: expect.any(Object),
    }); // options forwarded
  });

  it('forwards the launch onError so a dropped masking selector is actually reported', async () => {
    // @bugsee/replay reports an invalid selector it had to drop; that report needs a sink on the
    // production path, or the fix is only reachable from replay's own tests.
    const onError = vi.fn();
    await launchTracked('tok', domReplayOptions({ replay: { blockSelector: 'div[' }, onError }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect((registerReplay.mock.calls[0]?.[2] as { onError?: unknown }).onError).toBe(onError);
  });

  it('enables replay with default options when replay is `true`', async () => {
    await launchTracked('tok', domReplayOptions({ replay: true }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(registerReplay.mock.calls[0]?.[2]).toEqual({ blackout: expect.any(Object) }); // no options object
  });

  // Product decision: `replay` collects data and is ON by default, so an invalid scalar is OFF (fail
  // closed) and reported. It never throws (`null` once did). Masking stays fail-closed regardless.
  it.each([
    null,
    0,
    '',
    'false',
    'true',
    1,
  ])('a malformed replay value %j turns replay OFF (not registered) and reports', async (bad) => {
    const onError = vi.fn();
    await launchTracked('tok', domReplayOptions({ replay: bad as never, onError }));
    await new Promise((r) => setTimeout(r, 10));
    expect(registerReplay).not.toHaveBeenCalled();
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
    expect(
      onError.mock.calls.filter((c) =>
        String((c[0] as Error).message).startsWith('replay must be'),
      ),
    ).toHaveLength(1);
  });

  // Canvas pixels are unmasked, so ONLY boolean `true` or a plain object enables the add-on.
  it.each([
    0,
    null,
    '',
    'false',
    'true',
    1,
    [[]],
  ])('replay.canvas=%j is OFF (add-on not loaded) and reported', async (bad) => {
    const onError = vi.fn();
    await launchTracked('tok', domReplayOptions({ replay: { canvas: bad as never }, onError }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
    expect((registerReplay.mock.calls[0]?.[2] as { canvas?: unknown }).canvas).toBeUndefined();
    expect(
      onError.mock.calls.filter((c) => String((c[0] as Error).message).includes('replay.canvas')),
    ).toHaveLength(1);
  });

  // The canvas warning called the app's sink unguarded, so a sink that rethrows made launch() reject.
  it('a rethrowing onError cannot break launch over an invalid replay.canvas (the add-on stays OFF)', async () => {
    const onError = vi.fn(() => {
      throw new Error('the host sink rethrows');
    });
    await expect(
      launchTracked('tok', domReplayOptions({ replay: { canvas: 'yes' as never }, onError })),
    ).resolves.toBeDefined();
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  // `replay: false` is now THE errors-only path — it inherits the guarantee the old default carried: no
  // recorder, no replay.bin encoder, and (below) no @bugsee/replay in the bundle at all.
  it('does NOT register replay when replay is `false` — the errors-only opt-out', async () => {
    // A DOM IS present here: this asserts the OPT-OUT, so it must not pass merely for want of a document
    // (with `baseOptions` it would pass even if the opt-out were deleted — the DOM-less gate would carry it).
    await launchTracked('tok', domReplayOptions({ replay: false }));
    await new Promise((r) => setTimeout(r, 10));
    expect(registerReplay).not.toHaveBeenCalled(); // no recorder, and no replay.bin encoder registered
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
  });

  it('routes a replay load/registration failure to onError (never breaks launch)', async () => {
    registerReplay.mockImplementationOnce(() => {
      throw new Error('replay boom');
    });
    const onError = vi.fn();
    await launchTracked('tok', domReplayOptions({ replay: true, onError }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('a throwing onError sink cannot become an unhandled rejection when replay fails to load', async () => {
    registerReplay.mockImplementationOnce(() => {
      throw new Error('replay boom');
    });
    const onError = vi.fn(() => {
      throw new Error('sink boom');
    });
    const unhandled = vi.fn();
    const proc = (
      globalThis as unknown as {
        process: {
          on: (e: string, f: () => void) => void;
          off: (e: string, f: () => void) => void;
        };
      }
    ).process; // this package has no node types
    proc.on('unhandledRejection', unhandled);
    try {
      await launchTracked('tok', domReplayOptions({ replay: true, onError }));
      await vi.waitFor(() => expect(onError).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      proc.off('unhandledRejection', unhandled);
    }
  });

  it('wires canvas when replay.canvas is set — resolves the config + threads it into registerReplay', async () => {
    await launchTracked('tok', domReplayOptions({ replay: { canvas: { fps: 4 } } }));
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
    await launchTracked('tok', domReplayOptions({ replay: { canvas: true } }));
    await vi.waitFor(() => expect(createCanvasRecordConfig).toHaveBeenCalledWith({}));
  });

  it('does NOT load @bugsee/replay-canvas when canvas is off (replay without canvas)', async () => {
    await launchTracked('tok', domReplayOptions({ replay: true }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled();
    const opts = registerReplay.mock.calls[0]?.[2] as { canvas?: unknown };
    expect(opts.canvas).toBeUndefined();
  });

  it('does NOT load @bugsee/replay-canvas when replay.canvas is explicitly false', async () => {
    await launchTracked('tok', domReplayOptions({ replay: { canvas: false } }));
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    expect(createCanvasRecordConfig).not.toHaveBeenCalled(); // explicit opt-out must not load the add-on
    const opts = registerReplay.mock.calls[0]?.[2] as { canvas?: unknown };
    expect(opts.canvas).toBeUndefined();
  });

  it('forwards blockAllCanvas through to the replay masking options', async () => {
    await launchTracked('tok', domReplayOptions({ replay: { blockAllCanvas: true } }));
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
    await launchTracked('tok', baseOptions({ onError })); // the default path — and no document anywhere
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
    await launchTracked('tok', baseOptions({ replay: { canvas: true }, onError }));
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
      const off = await fresh.launch('tok', domReplayOptions({ carrier: {}, replay: false }));
      await new Promise((r) => setTimeout(r, 10));
      expect(evaluated.replay).toBe(0); // the chunk was never fetched/evaluated
      await off.stop();

      // (2) SSR / pre-render: opted IN explicitly (the shared server+client config case) and DOM-less.
      const ssr = await fresh.launch('tok', baseOptions({ carrier: {}, replay: { canvas: true } }));
      await new Promise((r) => setTimeout(r, 10));
      expect(evaluated.replay).toBe(0); // no rrweb chunk fetched on a server render
      expect(evaluated.canvas).toBe(0); // nor the canvas add-on
      await ssr.stop();

      // (3) Positive control: the SAME fresh module DOES evaluate both once a document is present — so the
      // zeros above are real absences, not a broken counter or a launch that died before the import.
      const dom = await fresh.launch(
        'tok',
        domReplayOptions({ carrier: {}, replay: { canvas: true } }),
      );
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

// An injectable trigger pipeline.
//
// Symmetric with the `captureStore` seam that already exists. @bugsee/electron needs it because a renderer
// must FORWARD its incidents to the main process rather than assembling a bundle from its streaming store —
// which yields nothing — and uploading under a foreign session id.
// @bugsee/webview solves the same problem, but only because it composes its client directly via
// createClient; a full browser SDK cannot do that without duplicating this entire module.
describe('launchCore — triggerPipeline seam', () => {
  it('routes reports through an injected pipeline instead of assembling + uploading', async () => {
    const reported: unknown[] = [];
    const client = (
      await launchCore(
        'tok',
        baseOptions({
          triggerPipeline: {
            report: async (request: unknown) => {
              reported.push(request);
              return { ok: true };
            },
          },
        } as Partial<BugseeLaunchOptions>),
      )
    ).client;
    await client.logException(new Error('renderer boom'));
    expect(reported).toHaveLength(1);
    expect(JSON.stringify(reported[0])).toContain('renderer boom');
    await client.stop();
  });

  it('falls back to the built-in assemble+upload pipeline when none is injected', async () => {
    // The compatibility guarantee: every existing consumer is untouched.
    const transport = uploadTransport();
    const client = (await launchCore('tok', baseOptions({ transport }))).client;
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
describe('flush on page hide', () => {
  /** A capture store that records whether its pending durable writes were committed. */
  const flushableStore = () => {
    const store = memStore();
    store.flush = vi.fn(() => Promise.resolve());
    return store;
  };

  it('commits the capture store’s pending writes when the page hides', async () => {
    const win = fakeWindow();
    const captureStore = flushableStore();
    await launchTracked('tok', baseOptions({ window: win.win, captureStore }));
    win.emit('pagehide', {});
    expect(captureStore.flush).toHaveBeenCalled();
  });

  it('flushes the CLIENT too, draining a report that is still assembling', async () => {
    // Committing the capture store is only half of it. A report can be mid-assembly when the page hides,
    // and an assembling report has not reached the durable queue yet — `client.flush()` is what awaits it
    // (packages/core/src/client.ts: uploadPipeline.flush alone misses reports with no upload enqueued).
    // Without this leg, the last crash before a tab is backgrounded is the one most likely to be lost.
    const win = fakeWindow();
    const client = await launchTracked(
      'tok',
      baseOptions({ window: win.win, captureStore: memStore() }),
    );
    const flush = vi.spyOn(client, 'flush').mockResolvedValue(true);
    win.emit('pagehide', {});
    expect(flush).toHaveBeenCalled();
  });

  it('does not flush on a visibilitychange back to VISIBLE', async () => {
    const win = fakeWindow();
    const doc = fakeWindow();
    const captureStore = flushableStore();
    await launchTracked(
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
    const client = await launchTracked(
      'tok',
      baseOptions({ window: win.win, captureStore, captureSystemEvents: false }),
    );
    expect(win.count('pagehide')).toBe(1);
    await client.stop();
    expect(win.count('pagehide')).toBe(0);
    // stop() itself commits the store once (the shutdown flush); the hook must add nothing after that.
    const flushesAtStop = vi.mocked(captureStore.flush as () => Promise<void>).mock.calls.length;
    win.emit('pagehide', {});
    expect(captureStore.flush).toHaveBeenCalledTimes(flushesAtStop); // …and it is genuinely disconnected
  });

  it('a failing flush never throws back into the browser’s dispatch', async () => {
    const win = fakeWindow();
    const onError = vi.fn();
    const captureStore = memStore();
    captureStore.flush = () => {
      throw new Error('commit failed');
    };
    await launchTracked('tok', baseOptions({ window: win.win, captureStore, onError }));
    expect(() => win.emit('pagehide', {})).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});

// RelaunchedAfterCrash is told only when recovery finds a dead sibling's unsettled incident marker.
describe('launch — RelaunchedAfterCrash needs evidence', () => {
  const run = async (seed: (idb: IDBFactory, locks: LockManagerLike) => Promise<void>) => {
    const idb = new IDBFactory();
    const locks = fakeWebLocks();
    await seed(idb, locks);
    const seen: string[] = [];
    const { fn: transport } = recordingTransport();
    await launchTracked(
      'tok',
      baseOptions({
        transport,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks,
        lifecycleEventsListener: (type) => seen.push(type),
      }),
    );
    // let the dead-sibling recovery finish (its marker is swept when it is done). The event can lag on a slow
    // machine, so wait for it for a bounded time; the cases that expect silence simply run out the clock.
    const deadline = Date.now() + 1500;
    while (!seen.includes(LifecycleEvents.RelaunchedAfterCrash) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50));
    return seen;
  };

  it('is emitted once, after Launched, when a dead sibling left an incident marker', async () => {
    const seen = await run(async (idb) => {
      await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true);
      await seedSibling(idb, 'deadsib2', 600, { m: 'pre-crash-2' }, true);
    });
    expect(seen).toEqual([
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
      LifecycleEvents.RelaunchedAfterCrash,
    ]);
  });

  it('is NOT emitted for a dead sibling with capture but no incident marker', async () => {
    const seen = await run(async (idb) => {
      await seedSibling(idb, 'deadsib', 500, { m: 'just capture' }, false);
    });
    expect(seen).not.toContain(LifecycleEvents.RelaunchedAfterCrash);
  });

  it('is NOT emitted for a LIVE sibling that has an incident marker', async () => {
    const seen = await run(async (idb, locks) => {
      createWebLockLiveness(locks).holdSelf(instanceLockName('tok', 'livesib'));
      await seedSibling(idb, 'livesib', 700, { m: 'live' }, true);
    });
    expect(seen).not.toContain(LifecycleEvents.RelaunchedAfterCrash);
  });

  it('is NOT told to a client that has been stopped before the recovery got there', async () => {
    const idb = new IDBFactory();
    const locks = fakeWebLocks();
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true);
    const seen: string[] = [];
    const client = await launchTracked(
      'tok',
      baseOptions({
        transport: recordingTransport().fn,
        persist: true,
        clock: recoveryClock,
        scheduler: noopScheduler,
        indexedDB: idb,
        locks,
        lifecycleEventsListener: (type) => seen.push(type),
      }),
    );
    await client.stop(); // the recovery is still reading IndexedDB: it will find the marker after this
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).not.toContain(LifecycleEvents.RelaunchedAfterCrash);
    expect(seen).toContain(LifecycleEvents.Stopped);
  });

  it('is NOT emitted on a first launch with nothing behind it', async () => {
    expect(await run(async () => {})).toEqual([
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
    ]);
  });
});

describe('app identity resolution', () => {
  const metaDocument = (meta: Record<string, string>) =>
    ({
      ...fakeWindow().win,
      querySelector: (selector: string) => {
        const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1] ?? '';
        const content = meta[name];
        return content === undefined ? null : { getAttribute: () => content };
      },
    }) as unknown as Document;

  const launchApp = async (over: Partial<BugseeLaunchOptions> = {}) => {
    const { client, internals } = await launchCore('tok', baseOptions({ carrier: {}, ...over }));
    clients.push(client);
    return {
      app: internals?.getEnvironment().app,
      version: internals?.appVersion,
      build: internals?.appBuild,
    };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the build-time constants and forwards them on the internals', async () => {
    vi.stubGlobal('__BUGSEE_APP_VERSION__', '4.5.6');
    vi.stubGlobal('__BUGSEE_APP_BUILD__', '777');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await launchApp();
    expect(out.app).toMatchObject({ version: '4.5.6', build: '777' });
    expect([out.version, out.build]).toEqual(['4.5.6', '777']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets explicit options win over the build-time constants', async () => {
    vi.stubGlobal('__BUGSEE_APP_VERSION__', '4.5.6');
    vi.stubGlobal('__BUGSEE_APP_BUILD__', '777');
    const out = await launchApp({ appVersion: '1.0.0', appBuild: '5' });
    expect(out.app).toMatchObject({ version: '1.0.0', build: '5' });
  });

  it('reads <meta name="bugsee:app-version|app-build"> from the page document', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await launchApp({
      document: metaDocument({ 'bugsee:app-version': '8.1.0', 'bugsee:app-build': '812' }),
    });
    expect(out.app).toMatchObject({ version: '8.1.0', build: '812' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('prefers the build-time constant over a meta tag', async () => {
    vi.stubGlobal('__BUGSEE_APP_VERSION__', '4.5.6');
    const out = await launchApp({
      document: metaDocument({ 'bugsee:app-version': '8.1.0', 'bugsee:app-build': '812' }),
    });
    expect(out.app).toMatchObject({ version: '4.5.6', build: '812' });
  });

  it('warns exactly once when no version can be found, and falls back to the defaults', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await launchApp({ document: metaDocument({}) });
    expect(out.app).toMatchObject({ version: '0.0.0', build: '0' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('app version');
    const text = String(warn.mock.calls[0]?.[0]);
    expect(text).toContain('appVersion');
    expect(text).toContain('Vite or webpack plugin');
    expect(text).toContain('__BUGSEE_APP_VERSION__');
    expect(text).toContain('bugsee:app-version');
    expect(text).not.toMatch(/\bBUGSEE_APP_VERSION\b/);
  });

  it('survives a window without a document', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await launchApp({ window: fakeWindow().win });
    expect(out.app).toMatchObject({ version: '0.0.0' });
  });
});

describe('launch — environment.app.uptime_s (snapshot at session start)', () => {
  it('stamps the probe value ONCE at launch; later environment builds do not drift', async () => {
    let seconds = 0.4;
    const spy = vi.fn(() => seconds);
    const { client, internals } = await launchCore(
      'tok',
      baseOptions({
        carrier: {},
        captureStore: memStore(),
        systemProbe: { ...probe, uptimeSeconds: spy },
      }),
    );
    clients.push(client);
    seconds = 900;
    expect(internals?.getEnvironment().app?.uptime_s).toBe(0);
    expect(internals?.getEnvironment().app?.uptime_s).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a probe whose uptimeSeconds throws omits the field and reports to onError; launch survives', async () => {
    const onError = vi.fn();
    const boom = new Error('probe broke');
    const { client, internals } = await launchCore(
      'tok',
      baseOptions({
        carrier: {},
        captureStore: memStore(),
        onError,
        systemProbe: {
          ...probe,
          uptimeSeconds: () => {
            throw boom;
          },
        },
      }),
    );
    clients.push(client);
    expect('uptime_s' in (internals?.getEnvironment().app ?? {})).toBe(false);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('omits the key when the probe has no clock', async () => {
    const { client, internals } = await launchCore(
      'tok',
      baseOptions({ carrier: {}, captureStore: memStore() }),
    );
    clients.push(client);
    expect('uptime_s' in (internals?.getEnvironment().app ?? {})).toBe(false);
  });
});
