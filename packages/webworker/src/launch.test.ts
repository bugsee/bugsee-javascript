import 'fake-indexeddb/auto'; // polyfills indexedDB/IDBKeyRange for the persist (Service Worker) path
import type { WindowEvents } from '@bugsee/browser';
import {
  coexistenceDatabaseName,
  createIdbBlobStore,
  type LockManagerLike,
} from '@bugsee/browser-utils';
import {
  type BundleStore,
  BundleStoreToken,
  contributeServiceManifest,
  createMemoryCaptureStore,
  createSystemClock,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  type Scheduler,
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

// An in-memory Web Locks fake (node has no navigator.locks): a never-held name is "dead" (acquirable).
function fakeWebLocks(): LockManagerLike {
  const held = new Set<string>();
  return {
    request(name, options, callback) {
      if (options.ifAvailable) {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve(callback({ name })).finally(() => held.delete(name));
      }
      held.add(name);
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
