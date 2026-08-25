import { version as packageVersion } from '../package.json' with { type: 'json' };
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
import { createConsoleInterceptor } from '@bugsee/capture';
import {
  type BundleStore,
  BundleStoreToken,
  contributeServiceManifest,
  createCaptureExporter,
  createMemoryCaptureStore,
  createReportingRequest,
  createSystemClock,
  getCarrier,
  getOrCreateInterceptor,
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
      source: { type: 'crash', mechanism: 'uncaught' },
      created_on: '2026-06-29T00:00:00Z',
      environment: {
        platform: { type: 'web-worker', version: '1' },
        runtime: { type: 'web-worker', version: '' },
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
      runtime: { type: string; version: string };
      browser?: { type: string; version: string };
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

  it('a memory-only (web-worker) launch records NO markers and reports no internal error', async () => {
    // The marker hook is handed to the core client only when there IS a marker store. Handing it over
    // unconditionally gives core `{ store: undefined }`, which it treats as present and then fails on at
    // every single report — swallowed into onError, so the only visible symptom is an internal error per
    // incident. A clean memory-only launch must produce none.
    const onError = vi.fn();
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport, onError })); // default web-worker → no markers
    await client.logException(new Error('memory-only incident'));
    await client.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('memory-only incident'); // delivered…
    expect(onError).not.toHaveBeenCalled(); // …with nothing failing behind the scenes
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

  it("recovers a dead sibling's incident WHATEVER generation it recorded under (the -1 sentinel)", async () => {
    // `currentGeneration: -1` means "no generation in this sibling's data is the live one, so every one
    // of them is eligible" — a marker whose generation equals `currentGeneration` is SKIPPED
    // (packages/core/src/capture-recovery.ts:51). Passing anything a real generation could equal (a
    // wall-clock ms, or a small counter after an injected clock) silently drops that sibling's incident.
    // The value below is arbitrary on purpose: recovery must not depend on it.
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 1, { m: 'gen-one-crash' }, true);
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
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([
      { m: 'gen-one-crash' },
    ]);
  });

  it('bounds the DURABLE (IndexedDB) rolling buffer too, not just the in-memory one', async () => {
    // The persist path builds a different store (createIdbChunkCaptureStore) and got its own copy of the
    // bounds argument; replacing that whole argument object with `{}` — an unbounded Service Worker
    // buffer growing in IndexedDB until the origin quota kills it — passed every other test here.
    const idb = new IDBFactory();
    const transport = uploadTransport();
    const ticks: Array<() => void> = [];
    const scheduler: Scheduler = {
      setInterval: (cb: () => void) => {
        ticks.push(cb);
        return 'h' as unknown as ReturnType<Scheduler['setInterval']>;
      },
      clearInterval: () => {},
    };
    const client = track(
      'tok',
      baseOptions({
        transport,
        scheduler,
        indexedDB: idb,
        platformType: 'service-worker',
        clock: recoveryClock,
        maxDataSize: 0.0001, // ≈ 104 bytes
      }),
    );
    console.log(`OLDEST-DURABLE${'x'.repeat(400)}`);
    await new Promise((r) => setTimeout(r, 0));
    for (const cb of ticks) {
      cb(); // close the part holding it
    }
    console.log(`NEWEST-DURABLE${'x'.repeat(400)}`);
    await new Promise((r) => setTimeout(r, 0));
    await client.logException(new Error('durable bounds probe'));
    await client.flush();
    await vi.waitFor(() => expect(findPut(transport)).toBeDefined());
    const files = unzipSync((findPut(transport)?.[1] as HttpRequestOptions).body as Uint8Array);
    const logs = strFromU8(files['logs.json'] as Uint8Array);
    expect(logs).toContain('NEWEST-DURABLE');
    expect(logs).not.toContain('OLDEST-DURABLE'); // evicted by the byte ceiling
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

  it('reports the web-worker runtime type by default', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.runtime.type).toBe('web-worker');
  });

  it('honors an overridden platformType (service-worker)', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport, platformType: 'service-worker' }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.runtime.type).toBe('service-worker');
  });

  it('threads the system probe (userAgent) into the environment', async () => {
    const transport = uploadTransport();
    const client = track(
      'tok',
      baseOptions({
        transport,
        systemProbe: {
          userAgent: () =>
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
          uaDataPlatform: () => undefined,
          locale: () => 'en-GB',
          utcOffsetMinutes: () => 0,
          deviceMemoryBytes: () => undefined,
          cpuCount: () => undefined,
        },
      }),
    );
    await client.logException(new Error('x'));
    await client.flush();
    // The injected agent has to reach the envelope, and it now does so DERIVED rather than verbatim —
    // asserting on the OS and the browser proves the probe was threaded AND that the parse ran on it.
    const env = issueJson(transport).environment;
    expect(env.platform.type).toBe('linux');
    expect(env.browser).toEqual({ type: 'Chrome', version: '119.0.0.0' });
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
    const transport = uploadTransport();
    const client = launch('tok', {
      transport,
      captureNetwork: false,
      globalScope: fakeScope().scope,
      clock: createSystemClock(),
    });
    clients.push(client);
    await client.logException(new Error('default-scheduler incident'));
    await client.flush();
    // Assert the SDK actually WORKS on the real timer scheduler — `expect(client).toBeDefined()` (what
    // this test used to check) passes for any launch at all, including one wired to nothing.
    expect(JSON.stringify(issueJson(transport))).toContain('default-scheduler incident');
  });

  it('defaults to the fetch transport when none is injected', async () => {
    // Same reason: the old body only checked that launch() returned something. Stub the global `fetch`
    // the browser transport is built on and assert the SDK's own request actually went through it.
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ access_token: 'access' }), { status: 200 });
    });
    const client = launch('tok', { captureNetwork: false, globalScope: fakeScope().scope });
    clients.push(client);
    await client.logException(new Error('x'));
    await client.flush();
    expect(calls[0]?.[0]).toBe('https://api.bugsee.com/v2/sessions');
    expect(
      (calls[0]?.[1]?.headers as Record<string, string> | undefined)?.['x-bugsee-internal'],
    ).toBe('1'); // …and still internal-tagged, so the SDK never captures its own traffic
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

  it('reports runtime.type `service-worker` without being told', async () => {
    await withGlobal(true, async () => {
      const transport = uploadTransport();
      const client = track('tok', baseOptions({ transport }));
      await client.logException(new Error('x'));
      await client.flush();
      expect(issueJson(transport).environment.runtime.type).toBe('service-worker');
    });
  });

  it('still reports `web-worker` in a plain Web Worker', async () => {
    await withGlobal(false, async () => {
      const transport = uploadTransport();
      const client = track('tok', baseOptions({ transport }));
      await client.logException(new Error('x'));
      await client.flush();
      expect(issueJson(transport).environment.runtime.type).toBe('web-worker');
    });
  });

  it('turns PERSISTENCE on for a detected Service Worker — the half that actually matters', async () => {
    // Reporting `runtime.type: 'service-worker'` is cosmetic on its own. `persist` is what makes the
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
      expect(issueJson(transport).environment.runtime.type).toBe('web-worker');
    });
  });
});

// The URL every request is sent to, the token that authorizes it, and the SDK version the backend keys the
// SDK by are all resolved in launch() from module constants — and were asserted by NOTHING. The suite's
// fake transport matches routes with `endsWith('/v2/sessions')`, so an empty (or wrong) endpoint, an empty
// SDK version and a dropped app token all sailed through it: mutations blanking DEFAULT_ENDPOINT and
// SDK_VERSION, and one replacing the whole `createBugseeApi` config with `{}`, each survived the full suite.
describe('launch — endpoint / app token / SDK version wiring', () => {
  const callTo = (transport: ReturnType<typeof uploadTransport>, suffix: string) =>
    transport.mock.calls.find(([url]) => url.endsWith(suffix));

  it('sends every API request to the default https://api.bugsee.com origin', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(callTo(transport, '/v2/sessions')?.[0]).toBe('https://api.bugsee.com/v2/sessions');
    expect(callTo(transport, '/v2/issues')?.[0]).toBe('https://api.bugsee.com/v2/issues');
  });

  it('routes to an explicit endpoint override instead', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport, endpoint: 'https://eu.bugsee.test' }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(callTo(transport, '/v2/sessions')?.[0]).toBe('https://eu.bugsee.test/v2/sessions');
    expect(callTo(transport, '/v2/issues')?.[0]).toBe('https://eu.bugsee.test/v2/issues');
  });

  it('authorizes with the launch app token (header + session body)', async () => {
    const transport = uploadTransport();
    const client = track('my-app-token', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    const session = callTo(transport, '/v2/sessions')?.[1] as HttpRequestOptions;
    expect(session.headers?.['x-app-token']).toBe('my-app-token');
    expect(JSON.parse(session.body as string)).toMatchObject({ app_token: 'my-app-token' });
  });

  it('reports the package SDK version (user-agent + environment.sdk.version) by default', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    const session = callTo(transport, '/v2/sessions')?.[1] as HttpRequestOptions;
    expect(session.headers?.['user-agent']).toBe(`BugseeJS/${packageVersion}`);
    expect(
      (issueJson(transport).environment as unknown as { sdk: { version: string } }).sdk.version,
    ).toBe(packageVersion);
  });

  it('honors an explicit sdkVersion override everywhere it is reported', async () => {
    const transport = uploadTransport();
    const client = track('tok', baseOptions({ transport, sdkVersion: '9.9.9' }));
    await client.logException(new Error('x'));
    await client.flush();
    const session = callTo(transport, '/v2/sessions')?.[1] as HttpRequestOptions;
    expect(session.headers?.['user-agent']).toBe('BugseeJS/9.9.9');
    expect(
      (issueJson(transport).environment as unknown as { sdk: { version: string } }).sdk.version,
    ).toBe('9.9.9');
  });
});

// The two bounds on the rolling buffer — `maxDataSize` (MB → bytes) and `maxRecordingTime` (s → ms) — are
// the only thing keeping a long-lived worker's capture from growing without limit, and the whole
// `storeBounds` object could be replaced with `{}` (unbounded), the MB conversion divided instead of
// multiplied, and the `maxDataSize` option definition deleted, without a single test noticing.
describe('launch — rolling capture bounds (maxDataSize / maxRecordingTime)', () => {
  // A scheduler whose interval callback is driven by hand: the client's tick is what CLOSES the current
  // part, and only a closed part can be evicted (by the byte cap or the time window).
  const manualTicker = () => {
    const ticks: Array<() => void> = [];
    const scheduler: Scheduler = {
      setInterval: (cb: () => void) => {
        ticks.push(cb);
        return 'h' as unknown as ReturnType<Scheduler['setInterval']>;
      },
      clearInterval: () => {},
    };
    return {
      scheduler,
      tick: () => {
        for (const cb of ticks) {
          cb();
        }
      },
    };
  };

  const settle = () => new Promise((r) => setTimeout(r, 0));

  const uploadedLogs = async (
    client: ReturnType<typeof launch>,
    transport: ReturnType<typeof uploadTransport>,
  ): Promise<string> => {
    await client.logException(new Error('bounds probe'));
    await client.flush();
    const files = unzipSync((findPut(transport)?.[1] as HttpRequestOptions).body as Uint8Array);
    const name = Object.keys(files).find((n) => n.includes('log')) as string;
    return strFromU8(files[name] as Uint8Array);
  };

  const bigLog = (marker: string) => `${marker}${'x'.repeat(400)}`;

  it('evicts the oldest closed part once the byte ceiling is exceeded (maxDataSize is in MEGABYTES)', async () => {
    const transport = uploadTransport();
    const { scheduler, tick } = manualTicker();
    // 0.0001 MB ≈ 104 bytes — smaller than a single one of the ~400-byte log lines below.
    const client = track('tok', baseOptions({ transport, scheduler, maxDataSize: 0.0001 }));
    console.log(bigLog('OLDEST-ENTRY'));
    await settle();
    tick(); // closes the part holding the oldest entry (an OPEN part is never evicted)
    console.log(bigLog('NEWEST-ENTRY'));
    await settle();
    const logs = await uploadedLogs(client, transport);
    expect(logs).toContain('NEWEST-ENTRY'); // the live part always survives (soft bound)
    expect(logs).not.toContain('OLDEST-ENTRY'); // …the closed one over the ceiling did not
  });

  it('keeps everything when the same capture fits the ceiling (the MB→bytes conversion is a multiply)', async () => {
    const transport = uploadTransport();
    const { scheduler, tick } = manualTicker();
    // 1 MB = 1_048_576 bytes: the same ~800 bytes of capture now fits comfortably. Divide instead of
    // multiply anywhere in `maxDataSize * 1024 * 1024` and this becomes a sub-byte ceiling that evicts.
    const client = track('tok', baseOptions({ transport, scheduler, maxDataSize: 1 }));
    console.log(bigLog('OLDEST-ENTRY'));
    await settle();
    tick();
    console.log(bigLog('NEWEST-ENTRY'));
    await settle();
    const logs = await uploadedLogs(client, transport);
    expect(logs).toContain('OLDEST-ENTRY');
    expect(logs).toContain('NEWEST-ENTRY');
  });

  it('keeps an entry captured 5 s ago inside the DEFAULT 60 s window (maxRecordingTime is in SECONDS)', async () => {
    const transport = uploadTransport();
    const { scheduler, tick } = manualTicker();
    let now = 0;
    const clock = { wallNow: () => now, monotonicNow: () => now };
    const client = track('tok', baseOptions({ transport, scheduler, clock }));
    console.log('INSIDE-WINDOW');
    await settle();
    now = 1000;
    tick(); // close the part at t=1s
    now = 5000;
    tick(); // …and tick again 4 s later: 5 s in, still far inside a 60 s window
    await settle();
    const logs = await uploadedLogs(client, transport);
    expect(logs).toContain('INSIDE-WINDOW'); // a seconds→ms divide would make the window 0.06 ms
  });

  it('drops an entry that falls out of an explicit 1 s maxRecordingTime window', async () => {
    const transport = uploadTransport();
    const { scheduler, tick } = manualTicker();
    let now = 0;
    const clock = { wallNow: () => now, monotonicNow: () => now };
    const client = track('tok', baseOptions({ transport, scheduler, clock, maxRecordingTime: 1 }));
    console.log('OUTSIDE-WINDOW');
    await settle();
    now = 1000;
    tick();
    now = 5000;
    tick(); // 5 s later: outside a 1 s window (+ the one-part grace) → evicted
    console.log('STILL-RECORDING');
    await settle();
    const logs = await uploadedLogs(client, transport);
    expect(logs).not.toContain('OUTSIDE-WINDOW');
    expect(logs).toContain('STILL-RECORDING'); // the option shortened the window, it did not stop capture
  });
});

// stop() is not the core client's stop: launch WRAPS it to release the per-worker singleton slot, and that
// wrapper is the only thing that lets a worker re-launch (a Service Worker script re-evaluated on a new
// activation, or a test/host that tears the SDK down and brings it back). Emptying the whole wrapper body
// left every test in this file green.
describe('launch — stop() releases the singleton', () => {
  it('returns the core stop result and stops the client', async () => {
    const client = launch('tok', baseOptions({ carrier: {} }));
    expect(client.isLaunched()).toBe(true);
    // Awaited as a value rather than via `.resolves` so a wrapper that returns nothing fails on the
    // assertion (expected undefined to be true) instead of on expect()'s own argument check.
    expect(await client.stop()).toBe(true); // delegates to the core stop (not a swallowed no-op)
    expect(client.isLaunched()).toBe(false);
  });

  it('lets a later launch() start a FRESH client on the same carrier (no repeat-launch warning)', async () => {
    const carrier = {};
    const onError = vi.fn();
    const first = launch('tok', baseOptions({ carrier, onError }));
    await first.stop();

    const transport = uploadTransport();
    const second = track('tok', baseOptions({ carrier, onError, transport }));
    expect(second).not.toBe(first); // the carrier slot was cleared → a real new launch
    expect(onError).not.toHaveBeenCalled(); // …so it is NOT treated as a duplicate launch
    // And the fresh client is fully wired, not a stopped husk.
    await second.logException(new Error('after-relaunch'));
    await second.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('after-relaunch');
  });

  it('ignores a repeat launch when no onError sink was supplied (the warning is optional)', () => {
    const carrier = {};
    const first = track('tok', baseOptions({ carrier, onError: undefined }));
    expect(() => launch('tok', baseOptions({ carrier, onError: undefined }))).not.toThrow();
    expect(launch('tok', baseOptions({ carrier }))).toBe(first);
  });
});

// Network capture is half of what a worker SDK is for (a Service Worker sits ON the network path), and
// every test above turns it OFF to keep the real `fetch` global unpatched — so nothing exercised the
// wiring: the whole `installNetworkCapture({ carrier, captureBodies, maxBodyBytes })` argument object
// could be replaced with `{}` and the body-capture default flipped to false with the suite still green.
// These use a private carrier + a stubbed `fetch`, so the leaf interceptors are fresh per test and the
// real global is never touched.
describe('launch — network capture wiring', () => {
  const drainNetwork = async (store: ReturnType<typeof memStore>) =>
    (await createCaptureExporter(store).drain()).get('network');

  const stubFetch = (body: string, extraHeaders: Record<string, string> = {}) => {
    const slot = globalThis as unknown as { fetch?: unknown };
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/plain', ...extraHeaders },
        }),
    );
    return () =>
      (slot.fetch as (i: unknown, init?: unknown) => Promise<unknown>)(
        'https://api.example.test/orders?token=secret',
        { method: 'POST' },
      );
  };

  // The response-body amendment is emitted asynchronously (a second `complete` event once the bounded
  // clone read settles), so poll until the capture contains the awaited marker rather than guessing a
  // number of ticks. `settled` is the last-read snapshot, used for the negative assertions.
  const networkJson = async (
    store: ReturnType<typeof memStore>,
    awaited: string,
  ): Promise<string> => {
    let settled = '[]';
    await vi.waitFor(async () => {
      settled = JSON.stringify((await drainNetwork(store)) ?? []);
      expect(settled).toContain(awaited);
    });
    return settled;
  };

  it('captures a fetch — url, method and the RESPONSE BODY (bodies default ON)', async () => {
    const store = memStore();
    const doFetch = stubFetch('the-response-payload');
    track('tok', baseOptions({ captureNetwork: true, captureStore: store, carrier: {} }));
    await doFetch();
    const json = await networkJson(store, 'the-response-payload'); // bodies default to ON
    expect(json).toContain('api.example.test/orders');
    expect(json).toContain('POST');
    expect(json).not.toContain('secret'); // …and the provider still redacts the URL's token param
  });

  it('captures the request but NOT the body when captureNetworkBodies is off', async () => {
    const store = memStore();
    const doFetch = stubFetch('the-response-payload');
    track(
      'tok',
      baseOptions({
        captureNetwork: true,
        captureNetworkBodies: false,
        captureStore: store,
        carrier: {},
      }),
    );
    await doFetch();
    const json = await networkJson(store, 'api.example.test/orders'); // still captured…
    expect(json).not.toContain('the-response-payload'); // …without the body
  });

  // Content-Length is set deliberately: it selects the interceptor's known-over-cap fast skip. The
  // streaming variant (no Content-Length, body read until it exceeds the cap) is currently unable to
  // report `size_too_large` at all — `readBoundedBody`'s `await reader.cancel()`
  // (packages/capture/src/fetch-interceptor.ts) is a CLONE (tee-branch) cancel, which per the WHATWG tee
  // algorithm only settles once the app's branch is also cancelled/consumed, so the amendment event
  // never fires. That is a defect in @bugsee/capture, not in this package's wiring.
  it('refuses to read a response bigger than maxNetworkBodySize', async () => {
    const store = memStore();
    const doFetch = stubFetch('x'.repeat(200), { 'content-length': '200' });
    track(
      'tok',
      baseOptions({
        captureNetwork: true,
        maxNetworkBodySize: 8,
        captureStore: store,
        carrier: {},
      }),
    );
    await doFetch();
    // The bounded read gives up instead of buffering it, and says why.
    const json = await networkJson(store, 'size_too_large');
    expect(json).not.toContain('x'.repeat(200));
  });

  // "Interceptors must not alter app behavior" (binding, docs): with body capture off the SDK must not
  // even CLONE the app's response — cloning tees the body stream, which changes buffering/backpressure
  // for the application. The captured output alone cannot show this (the provider strips bodies a second
  // time), so assert the observable side effect on the app's own Response object.
  it('does not clone the app response at all when body capture is off', async () => {
    const clones: boolean[] = [];
    const makeResponse = () => {
      const response = new Response('the-response-payload', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
      const original = response.clone.bind(response);
      response.clone = () => {
        clones.push(true);
        return original();
      };
      return response;
    };
    vi.stubGlobal('fetch', async () => makeResponse());
    const doFetch = () =>
      (globalThis as unknown as { fetch: (u: string) => Promise<unknown> }).fetch(
        'https://api.example.test/orders',
      );

    const off = memStore();
    track(
      'tok',
      baseOptions({
        captureNetwork: true,
        captureNetworkBodies: false,
        captureStore: off,
        carrier: {},
      }),
    );
    await doFetch();
    await new Promise((r) => setTimeout(r, 10));
    expect(clones).toEqual([]); // never touched the app's stream

    const on = memStore();
    track('tok2', baseOptions({ captureNetwork: true, captureStore: on, carrier: {} }));
    await doFetch();
    await networkJson(on, 'the-response-payload'); // …and with capture on it does read a clone
    expect(clones.length).toBeGreaterThan(0);
  });

  it('registers the interceptor singletons on the INJECTED carrier (one patch per global)', () => {
    const carrier = {};
    track('tok', baseOptions({ carrier }));
    const registry = getCarrier(carrier).interceptors;
    expect(registry.get('console')).toBeDefined(); // the console→log source, keyed for cross-package reuse
    expect(registry.get('fetch')).toBeDefined();
    // console + the 5 cross-runtime network leaves (fetch/xhr/websocket/sse/webtransport). No DOM input
    // source and no node-http: this is the DOM-less worker composition.
    expect([...registry.keys()].sort()).toEqual([
      'console',
      'fetch',
      'sse',
      'websocket',
      'webtransport',
      'xhr',
    ]);
  });

  it('reuses a console interceptor already on the carrier instead of installing a second one', () => {
    const carrier = {};
    const existing = getOrCreateInterceptor('console', () => createConsoleInterceptor(), carrier);
    track('tok', baseOptions({ carrier }));
    expect(getCarrier(carrier).interceptors.get('console')).toBe(existing); // same instance, one patch
  });
});
