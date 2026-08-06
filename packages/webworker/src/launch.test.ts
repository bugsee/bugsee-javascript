import 'fake-indexeddb/auto'; // polyfills indexedDB/IDBKeyRange for the persist (Service Worker) path
import type { WindowEvents } from '@bugsee/browser';
import {
  captureDatabaseName,
  coexistenceDatabaseName,
  createIdbBlobStore,
  createIdbChunkBackend,
  createIdbKeyedStore,
  createPrefixedKeyedStore,
  createWebLockLiveness,
  instanceLockName,
  type LockManagerLike,
  markerDatabaseName,
} from '@bugsee/browser-utils';
import {
  type BundleStore,
  BundleStoreToken,
  contributeServiceManifest,
  createMemoryCaptureStore,
  createReportingRequest,
  createSystemClock,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  ReportMarkerStoreToken,
  type Scheduler,
  type StoredEntry,
  serializeBundle,
} from '@bugsee/core';
import { Severity } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BugseeWorkerLaunchOptions, launch } from './launch';

// A fresh IndexedDB per test so the persist path is isolated.
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));

const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });

// A memory BundleStore (the durable queue's backing store) that records put/remove for assertions.
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

const pendingBundle = (summary: string): Uint8Array =>
  serializeBundle({
    request: {
      type: 'crash',
      summary,
      severity: Severity.Blocker,
      source: { mechanism: 'uncaught' },
      created_on: '2026-06-29T00:00:00Z',
      environment: {
        platform: { type: 'web-worker', version: '1' },
        sdk: { version: '0', type: 'javascript' },
      },
    },
    body: new Uint8Array([0x50, 0x4b, 1]),
    fileName: 'recovered.zip',
  });

const jsonBody = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

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

const inertScheduler: Scheduler = {
  setInterval: () => 0 as unknown as ReturnType<Scheduler['setInterval']>,
  clearInterval: () => {},
};

// An in-memory Web Locks fake (node has no navigator.locks). Two sets, faithful to real `ifAvailable`
// semantics: `heldForever` = a LIVE instance's holdSelf lock; `inUse` = momentarily held during a
// recoverIfDead callback. A name in neither is "dead" (acquirable). `null` is yielded for a held/busy lock.
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

// A fake worker scope: records error/unhandledrejection listeners + dispatches synthetic events.
function fakeScope() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const scope: WindowEvents = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    scope,
    emit: (type: string, event: unknown) => {
      for (const l of listeners.get(type) ?? []) l(event as Event);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const track = (token: string, options: BugseeWorkerLaunchOptions) => {
  const client = launch(token, options);
  clients.push(client);
  return client;
};

const baseOptions = (over: Partial<BugseeWorkerLaunchOptions> = {}): BugseeWorkerLaunchOptions => ({
  transport: uploadTransport(),
  scheduler: inertScheduler,
  captureNetwork: false, // don't patch the real fetch global in unit tests
  globalScope: fakeScope().scope, // a benign scope so detection wiring doesn't read a real `self`
  ...over,
});

const findPut = (transport: ReturnType<typeof uploadTransport>) =>
  transport.mock.calls.find(([url]) => url === 'https://s3.test/put');

// The /v2/issues request body (request.json) — a JSON STRING (createIssue uses JSON.stringify).
const issueJson = (transport: ReturnType<typeof uploadTransport>) => {
  const call = transport.mock.calls.find(([url]) => url.endsWith('/v2/issues'));
  return JSON.parse((call?.[1] as HttpRequestOptions).body as string) as {
    summary?: string;
    environment: {
      platform: { type: string; version: string };
      app?: { package_id: string; version: string; build: string };
    };
  };
};

// --- capture recovery (#165): seed a sibling instance's prior crash into the shared IDB -------------------
const recoveryClock = { wallNow: () => 1000, monotonicNow: () => 0 }; // launch generation 1000

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

const logRecord = (data: unknown): StoredEntry => ({
  type: 'log',
  timestamp: 1,
  serialized: JSON.stringify({ timestamp: 1, data }),
});

const siblingGenerations = async (idb: IDBFactory, instanceId: string): Promise<Set<number>> => {
  const metas = await captureStoreFor(idb).readPrefix(`${instanceId}/m/`);
  return new Set(
    metas.map(([key]) => {
      const inner = key.slice(instanceId.length + 1); // `m/<gen>/<chunk>`
      return Number(inner.slice(2, inner.indexOf('/', 2)));
    }),
  );
};
const siblingMarkers = (idb: IDBFactory, instanceId: string): Promise<string[]> =>
  markerStoreFor(idb)
    .loadAll()
    .then((es) => es.map(([k]) => k).filter((k) => k.startsWith(`${instanceId}/`)));

// Seed a SIBLING instance's prior crash (a closed capture chunk + optionally a pending marker) under its own
// `"<instanceId>/"` prefix — exactly how that instance's own launch would have written it.
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

describe('launch — capture recovery (#165: persist the rolling buffer)', () => {
  it('persist ON (service-worker) registers the report-marker store', () => {
    const client = track(
      'tok',
      baseOptions({ platformType: 'service-worker', clock: recoveryClock }),
    );
    expect(client.getService(ReportMarkerStoreToken)).toBeDefined();
  });

  it('a web-worker (persist OFF) registers no marker store', () => {
    const client = track('tok', baseOptions()); // default web-worker
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
  });

  it('a captureStore override disables durable capture (no marker store)', () => {
    const client = track(
      'tok',
      baseOptions({ platformType: 'service-worker', captureStore: memStore() }),
    );
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
  });

  it('recover:false persists the buffer + bundle queue but records no markers', () => {
    const client = track(
      'tok',
      baseOptions({ platformType: 'service-worker', recover: false, clock: recoveryClock }),
    );
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow(); // no marker store...
    expect(client.getService(BundleStoreToken)).toBeDefined(); // ...but the durable bundle store still wired
  });

  it('persists the rolling capture buffer under a per-instance prefix in the per-token capture db', async () => {
    const idb = new IDBFactory();
    const tick: Array<() => void> = [];
    const scheduler: Scheduler = {
      setInterval: (cb: () => void) => {
        tick.push(cb);
        return 'h';
      },
      clearInterval: () => {},
    };
    track(
      'tok',
      baseOptions({
        platformType: 'service-worker',
        scheduler,
        indexedDB: idb,
        clock: recoveryClock,
        transport: uploadTransport(),
      }),
    );
    console.log('persist-me'); // a captured log → written to the durable chunk store as captured
    await new Promise((r) => setTimeout(r, 0));
    for (const cb of tick) cb(); // a tick closes the part (rewrites its durable meta)
    await vi.waitFor(async () => {
      const keys = await captureStoreFor(idb).keys('');
      expect(keys.length).toBeGreaterThan(0); // a plain memory store would persist nothing here
      expect(keys.every((k) => /^[0-9a-f]{32}\//.test(k))).toBe(true); // every key under an <instanceId>/ prefix
    });
  });

  it('writes a recovery marker for a live incident through the launch wiring', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const client = track(
      'tok',
      baseOptions({ platformType: 'service-worker', clock: recoveryClock }),
    );
    const putSpy = vi.spyOn(client.getService(ReportMarkerStoreToken), 'put');
    await client.logException(new Error('live boom'));
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0]?.[0]?.generation).toBe(1000); // this launch's capture generation
    expect(putSpy.mock.calls[0]?.[0]?.request.report.summary).toBe('live boom');
  });

  it('recovers a DEAD sibling incident (rebuild + upload from its preserved chunks) + sweeps its marker', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'pre-crash' }, true); // a crashed activation's pending incident
    const transport = uploadTransport();
    track(
      'tok',
      baseOptions({
        transport,
        platformType: 'service-worker',
        clock: recoveryClock,
        indexedDB: idb,
        locks: fakeWebLocks(),
        onError: vi.fn(),
      }),
    );
    await vi.waitFor(() => expect(findPut(transport)).toBeDefined());
    const files = unzipSync((findPut(transport)?.[1] as HttpRequestOptions).body as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([{ m: 'pre-crash' }]);
    await vi.waitFor(async () => expect(await siblingMarkers(idb, 'deadsib')).toEqual([])); // marker swept
  });

  it('recovers a DEAD sibling incident but NEVER touches a LIVE one (SEV1)', async () => {
    const idb = new IDBFactory();
    const locks = fakeWebLocks();
    createWebLockLiveness(locks).holdSelf(instanceLockName('tok', 'livesib')); // a still-open tab holds its lock
    await seedSibling(idb, 'deadsib', 500, { m: 'dead-crash' }, true);
    await seedSibling(idb, 'livesib', 700, { m: 'live-buffer' }, true);
    const transport = uploadTransport();
    track(
      'tok',
      baseOptions({
        transport,
        platformType: 'service-worker',
        clock: recoveryClock,
        indexedDB: idb,
        locks,
        onError: vi.fn(),
      }),
    );
    await vi.waitFor(() => expect(findPut(transport)).toBeDefined());
    // ONLY the dead sibling is rebuilt + delivered; its marker is swept.
    const files = unzipSync((findPut(transport)?.[1] as HttpRequestOptions).body as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([{ m: 'dead-crash' }]);
    await vi.waitFor(async () => expect(await siblingMarkers(idb, 'deadsib')).toEqual([]));
    // The LIVE sibling's marker + capture generation are completely untouched (the multi-tab sweep guarantee).
    expect(await siblingMarkers(idb, 'livesib')).toEqual(['livesib/inc-livesib']);
    expect((await siblingGenerations(idb, 'livesib')).has(700)).toBe(true);
    expect(transport.mock.calls.filter(([url]) => url === 'https://s3.test/put')).toHaveLength(1);
  });

  it('sweeps a DEAD sibling with capture but NO incident, uploading nothing', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 500, { m: 'orphan' }, false); // chunks, but NO marker
    const transport = uploadTransport();
    // No onError here → also covers the recovery path's onError-absent branch.
    track(
      'tok',
      baseOptions({
        transport,
        platformType: 'service-worker',
        clock: recoveryClock,
        indexedDB: idb,
        locks: fakeWebLocks(),
      }),
    );
    await vi.waitFor(async () =>
      expect((await siblingGenerations(idb, 'deadsib')).has(500)).toBe(false),
    ); // capture generation swept
    expect(findPut(transport)).toBeUndefined(); // no incident → nothing uploaded
  });
});

describe('launch (webworker)', () => {
  it('uploads a bundle on logException through the full worker path (session→issue→PUT)', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport }));
    await client.logException(new Error('worker boom'));
    await client.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('worker boom');
    const put = findPut(transport);
    expect(put).toBeDefined();
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    expect(Object.keys(files).length).toBeGreaterThan(0);
  });

  it('reports the web-worker platform type by default', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.platform.type).toBe('web-worker');
  });

  it('honors an overridden platformType (service-worker)', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport, platformType: 'service-worker' }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.platform.type).toBe('service-worker');
  });

  it('threads the system probe (userAgent) into the environment', async () => {
    const transport = uploadTransport();
    const client = track(
      'tok',
      baseOptions({
        transport,
        systemProbe: {
          userAgent: () => 'CustomWorker/9',
          locale: () => 'en-GB',
          utcOffsetMinutes: () => 0,
          deviceMemoryBytes: () => undefined,
          cpuCount: () => undefined,
        },
      }),
    );
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.platform.version).toBe('CustomWorker/9');
  });

  it('tags every SDK request with x-bugsee-internal', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    expect((findPut(transport)?.[1] as HttpRequestOptions).headers?.['x-bugsee-internal']).toBe(
      '1',
    );
  });

  it('captures console output as log entries', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport }));
    console.log('hello-worker');
    await client.logException(new Error('x'));
    await client.flush();
    const files = unzipSync((findPut(transport)?.[1] as HttpRequestOptions).body as Uint8Array);
    const logsFile = Object.keys(files).find((n) => n.includes('log'));
    expect(logsFile).toBeDefined();
    expect(strFromU8(files[logsFile as string] as Uint8Array)).toContain('hello-worker');
  });

  it('detects a global error on the worker scope → uploads a crash report', async () => {
    const transport = uploadTransport();
    const s = fakeScope();
    const client = track('tok', baseOptions({ transport, globalScope: s.scope }));
    expect(s.count('error')).toBe(1); // the error detection provider registered
    s.emit('error', { error: new Error('worker uncaught') });
    await client.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('worker uncaught');
  });

  it('detects an unhandledrejection on the worker scope → uploads an error report', async () => {
    const transport = uploadTransport();
    const s = fakeScope();
    const client = track('tok', baseOptions({ transport, globalScope: s.scope }));
    expect(s.count('unhandledrejection')).toBe(1);
    s.emit('unhandledrejection', { reason: new Error('worker floating') });
    await client.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('worker floating');
  });

  it('does not wire detection when detectCrashes is false', () => {
    const s = fakeScope();
    track('tok', baseOptions({ globalScope: s.scope, detectCrashes: false }));
    expect(s.count('error')).toBe(0); // the controllingOption gate kept the providers inert
    expect(s.count('unhandledrejection')).toBe(0);
  });

  it('defaults the detection scope to the worker self (globalThis.self)', async () => {
    const transport = uploadTransport();
    const s = fakeScope();
    vi.stubGlobal('self', s.scope); // no globalScope injected → the `?? globalThis.self` default path
    const client = launch('tok', {
      transport,
      scheduler: inertScheduler,
      captureNetwork: false,
    });
    clients.push(client);
    expect(s.count('error')).toBe(1);
    s.emit('error', { error: new Error('from-self') });
    await client.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('from-self');
  });

  it('skips detection when there is no worker scope (non-worker runtime)', async () => {
    vi.stubGlobal('self', undefined); // no scope at all → detection skipped, capture still works
    const transport = uploadTransport();
    const client = launch('tok', {
      transport,
      scheduler: inertScheduler,
      captureNetwork: false,
    });
    clients.push(client);
    await client.logException(new Error('still-captured'));
    await client.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('still-captured');
  });

  it('accepts an injected clock + a DEFAULT scheduler (none injected)', async () => {
    const client = launch('tok', {
      transport: uploadTransport(),
      captureNetwork: false,
      globalScope: fakeScope().scope,
      clock: createSystemClock(),
    });
    clients.push(client);
    await client.logException(new Error('x'));
    await client.flush();
    expect(client).toBeDefined();
  });

  it('defaults to the fetch transport when none is injected', () => {
    const client = launch('tok', { captureNetwork: false, globalScope: fakeScope().scope });
    clients.push(client);
    expect(client).toBeDefined();
  });

  it('threads the app identity (id/version/build) into the environment', async () => {
    const transport = uploadTransport();
    const client = track(
      'tok',
      baseOptions({ transport, appId: 'com.acme.worker', appVersion: '2.0.0', appBuild: '99' }),
    );
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.app).toMatchObject({
      package_id: 'com.acme.worker',
      version: '2.0.0',
      build: '99',
    });
  });

  it('runs contributed service manifests (extension wiring) at launch', () => {
    const carrier = {}; // a fresh carrier so the manifest is isolated to this launch
    const ran = vi.fn();
    contributeServiceManifest(() => ran(), carrier);
    track('tok', baseOptions({ carrier }));
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('a service-worker defaults persist ON → registers a durable BundleStore', () => {
    const client = track('tok', baseOptions({ platformType: 'service-worker' }));
    expect(client.getService(BundleStoreToken)).toBeDefined(); // IndexedDB durable queue wired
  });

  it('a web-worker defaults persist OFF → no durable BundleStore', () => {
    const client = track('tok', baseOptions()); // default web-worker
    expect(() => client.getService(BundleStoreToken)).toThrow(); // not registered (memory-only)
  });

  it('persists then removes a bundle through the durable queue on a successful upload', async () => {
    const { store, puts, map } = bundleMemStore();
    const client = track(
      'tok',
      baseOptions({ transport: uploadTransport(), bundleStore: store, captureStore: memStore() }),
    );
    await client.logException(new Error('boom'));
    await vi.waitFor(() => expect(puts.length).toBeGreaterThan(0)); // persisted BEFORE upload
    await vi.waitFor(() => expect(map.size).toBe(0)); // removed after a successful upload
  });

  it('recovers (re-uploads) a bundle a prior activation left in the durable store', async () => {
    const { store, map } = bundleMemStore();
    map.set('leftover-1', pendingBundle('a prior SW crash')); // seed a leftover (the worker died mid-upload)
    const transport = uploadTransport();
    track(
      'tok',
      baseOptions({ transport, bundleStore: store, captureStore: memStore(), onError: vi.fn() }),
    );
    await vi.waitFor(() => expect(map.has('leftover-1')).toBe(false)); // recovered → uploaded → removed
    expect(transport.mock.calls.some(([url]) => url === 'https://s3.test/put')).toBe(true);
  });

  it('does not recover when recover is false (the leftover stays)', async () => {
    const { store, map } = bundleMemStore();
    map.set('leftover-2', pendingBundle('a prior SW crash'));
    track('tok', baseOptions({ bundleStore: store, captureStore: memStore(), recover: false }));
    await new Promise((r) => setTimeout(r, 5));
    expect(map.has('leftover-2')).toBe(true); // never recovered
  });

  it("recovers a DEAD sibling instance's leftover bundle from the shared origin store", async () => {
    const idb = new IDBFactory();
    // Seed a dead sibling's bundle under its own instance prefix in the per-token coexistence database.
    const shared = createIdbBlobStore({
      databaseName: coexistenceDatabaseName('tok'),
      indexedDB: idb,
    });
    await shared.put('deadsib/b1', pendingBundle('a prior tab crash'));

    const transport = uploadTransport();
    track(
      'tok',
      baseOptions({
        transport,
        platformType: 'service-worker', // persist ON (no bundleStore override → real coexistence layer)
        captureStore: memStore(),
        indexedDB: idb,
        locks: fakeWebLocks(),
        onError: vi.fn(),
      }),
    );

    await vi.waitFor(() =>
      expect(transport.mock.calls.some(([url]) => url === 'https://s3.test/put')).toBe(true),
    );
    await vi.waitFor(async () =>
      expect((await shared.loadAll()).some(([k]) => k === 'deadsib/b1')).toBe(false),
    ); // dead sibling's bundle re-uploaded → removed
    expect(issueJson(transport).summary).toBe('a prior tab crash'); // the SEEDED bundle was delivered
  });

  it('SKIPS a LIVE sibling (lock held) while recovering a DEAD one — end to end', async () => {
    const idb = new IDBFactory();
    const locks = fakeWebLocks();
    // A live sibling holds its lock (a tab that is still open); a dead one never did.
    createWebLockLiveness(locks).holdSelf(instanceLockName('tok', 'livesib'));
    const shared = createIdbBlobStore({
      databaseName: coexistenceDatabaseName('tok'),
      indexedDB: idb,
    });
    await shared.put('deadsib/b1', pendingBundle('dead tab crash'));
    await shared.put('livesib/b2', pendingBundle('live tab, in flight'));

    const transport = uploadTransport();
    track(
      'tok',
      baseOptions({
        transport,
        platformType: 'service-worker',
        captureStore: memStore(),
        indexedDB: idb,
        locks,
        onError: vi.fn(),
      }),
    );

    await vi.waitFor(async () =>
      expect((await shared.loadAll()).some(([k]) => k === 'deadsib/b1')).toBe(false),
    ); // dead sibling recovered
    expect(issueJson(transport).summary).toBe('dead tab crash'); // ONLY the dead one was delivered
    expect((await shared.loadAll()).some(([k]) => k === 'livesib/b2')).toBe(true); // live sibling untouched
  });

  it('is a per-worker singleton — a repeat launch is ignored (and onError-warned)', () => {
    const onError = vi.fn();
    const first = track('tok', baseOptions({ onError }));
    const second = launch('tok', baseOptions({ onError }));
    expect(second).toBe(first);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/more than once/);
  });
});

// WAVE 4.2 — a Service Worker must not have to be TOLD it is a Service Worker.
//
// `platformType` defaulted to 'web-worker', and `persist` derives from it. So a developer who installs the
// SDK in a Service Worker the documented way — and has no reason to know the option exists — silently got
// memory-only capture, losing everything each time the worker is terminated for idleness. That is precisely
// the "feature that silently does nothing" class: nothing errors, nothing warns, the data is just gone.
//
// `isServiceWorker()` has existed in @bugsee/util the whole time and had ZERO callers.
describe('Service Worker detection (Wave 4.2)', () => {
  const withGlobal = async (present: boolean, run: () => Promise<void>): Promise<void> => {
    const g = globalThis as { ServiceWorkerGlobalScope?: unknown };
    const had = 'ServiceWorkerGlobalScope' in g;
    const prev = g.ServiceWorkerGlobalScope;
    if (present) {
      g.ServiceWorkerGlobalScope = class {};
    } else {
      delete g.ServiceWorkerGlobalScope;
    }
    try {
      await run();
    } finally {
      if (had) {
        g.ServiceWorkerGlobalScope = prev;
      } else {
        delete g.ServiceWorkerGlobalScope;
      }
    }
  };

  it('reports platform.type `service-worker` without being told', async () => {
    await withGlobal(true, async () => {
      const transport = uploadTransport();
      const client = track('tok', baseOptions({ transport }));
      await client.logException(new Error('x'));
      await client.flush();
      expect(issueJson(transport).environment.platform.type).toBe('service-worker');
    });
  });

  it('still reports `web-worker` in a plain Web Worker', async () => {
    await withGlobal(false, async () => {
      const transport = uploadTransport();
      const client = track('tok', baseOptions({ transport }));
      await client.logException(new Error('x'));
      await client.flush();
      expect(issueJson(transport).environment.platform.type).toBe('web-worker');
    });
  });

  it('turns PERSISTENCE on for a detected Service Worker — the half that actually matters', async () => {
    // Reporting `platform.type: 'service-worker'` is cosmetic on its own. `persist` is what makes the
    // worker durable, and it must derive from the DETECTED type: deriving it from the raw option instead
    // leaves a detected Service Worker still running memory-only, which is the whole defect. A mutation
    // doing exactly that passed every other test in this block.
    await withGlobal(true, async () => {
      const client = track('tok', baseOptions({ clock: recoveryClock }));
      expect(client.getService(ReportMarkerStoreToken)).toBeDefined();
    });
  });

  it('leaves persistence OFF in a plain Web Worker', async () => {
    await withGlobal(false, async () => {
      const client = track('tok', baseOptions({ clock: recoveryClock }));
      expect(() => client.getService(ReportMarkerStoreToken)).toThrow();
    });
  });

  it('an EXPLICIT platformType still wins over detection', async () => {
    await withGlobal(true, async () => {
      const transport = uploadTransport();
      const client = track('tok', baseOptions({ transport, platformType: 'web-worker' }));
      await client.logException(new Error('x'));
      await client.flush();
      expect(issueJson(transport).environment.platform.type).toBe('web-worker');
    });
  });
});
