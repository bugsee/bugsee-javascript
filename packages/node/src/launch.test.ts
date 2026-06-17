import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http, { createServer, type Server } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BundleStore,
  BundleStoreToken,
  CaptureStoreToken,
  ChunkStorageToken,
  type Clock,
  ContextProviderToken,
  contributeServiceManifest,
  createCaptureExporter,
  createFileChunkBackend,
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
import { createFsChunkStorage, createNodeReportMarkerStore } from '@bugsee/node-utils';
import {
  BugseeOption,
  type EnvironmentEnvelope,
  type FileType,
  optionKeyToWire,
  type RequestJson,
  Severity,
} from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SystemProbe, SystemProbeToken } from './environment';
import type { HangLevel } from './event-loop-watchdog';
import { type BugseeLaunchOptions, launch, launchCore, type NodeRuntime } from './launch';
import { createNodeRequestContextStore, RequestContextStoreToken } from './request-context-store';

/** A test-only contributed service token (an "extension"). */
const DemoExtToken = serviceToken<{ storeIsRegistered: boolean }>('demoExt');

// --- fakes -------------------------------------------------------------------------------------

function fakeProcess(onExit?: (code?: number) => void) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const exit = vi.fn(onExit);
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
    exit,
  };
  return {
    proc,
    exit,
    fire: (event: string, ...args: unknown[]) => {
      for (const l of [...(listeners.get(event) ?? [])]) {
        l(...args);
      }
    },
    count: (event: string) => listeners.get(event)?.length ?? 0,
  };
}

const probe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => '20.1.2',
  osType: () => 'Linux',
  osRelease: () => '6.0',
  machine: () => 'x86_64',
  cpuCount: () => 8,
  totalMemory: () => 16_000,
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

const fakeScheduler = () => {
  const calls: Array<{ cb: () => void; ms: number }> = [];
  return {
    scheduler: {
      setInterval: (cb: () => void, ms: number) => {
        calls.push({ cb, ms });
        return `h${calls.length}`;
      },
      clearInterval: () => {},
    },
    calls,
  };
};

const jsonBody = (obj: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(obj)));
// A transport that satisfies the full upload path (session → issue → signed PUT) and records calls.
function uploadTransport() {
  const fn = vi.fn<HttpTransport>(async (url: string, _options: HttpRequestOptions = {}) => {
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
  return fn;
}

// --- harness -----------------------------------------------------------------------------------

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  // Stop every launched client so the console interceptor unpatches the global console.
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
  // Reset the process Carrier so each test builds fresh interceptor singletons (default global path).
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const launchTracked = (token: string, options: BugseeLaunchOptions) => {
  const client = launch(token, options);
  clients.push(client);
  return client;
};

// Common injected seams: deterministic, no real process / network / perf_hooks; network capture off
// so the real node:http / fetch globals are never patched in unit tests.
const baseOptions = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  process: fakeProcess().proc,
  transport: uploadTransport(),
  systemProbe: probe,
  systemMetricsSampler: () => [{ name: 'process_memory_rss', value: 42 }],
  captureNetwork: false,
  ...over,
});

const drain = async (store: ReturnType<typeof createMemoryCaptureStore>, type: FileType) =>
  (await createCaptureExporter(store).drain()).get(type);

const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });

// In-memory durable BundleStore + live map/put-log for assertions.
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
// A serialized pending bundle (as a prior crashed run would have left on disk).
const pendingBundle = (summary: string): Uint8Array => {
  const request: RequestJson = {
    type: 'crash',
    summary,
    severity: Severity.Blocker,
    source: { mechanism: 'uncaught' },
    created_on: '2026-05-29T00:00:00Z',
    environment: {
      platform: { type: 'node', version: '1' },
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

  it('registers the HTTP transport as a resolvable service that internal-tags requests', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    const svc = client.getService(TransportToken); // the internal container resolves the node transport
    expect(typeof svc).toBe('function');
    await svc('https://x.test/v2/sessions', {});
    // The resolved service is the internal-tagged wrapper over the injected transport.
    const lastCall = transport.mock.calls.at(-1);
    expect((lastCall?.[1] as HttpRequestOptions).headers?.['x-bugsee-internal']).toBe('1');
  });

  it('registers the systemProbe and captureStore as resolvable container services (DI Phase 3)', () => {
    const store = memStore();
    const client = launchTracked('tok', baseOptions({ systemProbe: probe, captureStore: store }));
    expect(client.getService(SystemProbeToken)).toBe(probe);
    expect(client.getService(CaptureStoreToken)).toBe(store);
  });

  it('wires a request-context store as both the node store service and the core context provider', () => {
    const client = launchTracked(
      'tok',
      baseOptions({ captureStore: memStore(), detectHangs: false }),
    );
    const store = client.getService(RequestContextStoreToken);
    expect(typeof store.run).toBe('function');
    expect(typeof store.setUser).toBe('function');
    // The SAME instance is the core ContextProvider that feeds the aggregator/report merge.
    expect(client.getService(ContextProviderToken)).toBe(store);
  });

  it('honors an injected requestContextStore override', () => {
    const custom = createNodeRequestContextStore();
    const client = launchTracked(
      'tok',
      baseOptions({ captureStore: memStore(), detectHangs: false, requestContextStore: custom }),
    );
    expect(client.getService(RequestContextStoreToken)).toBe(custom);
    expect(client.getService(ContextProviderToken)).toBe(custom);
  });

  it('registers bundleStore + chunkStorage as services in file-backed (dataDir) mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-di-'));
    const client = launchTracked('tok', baseOptions({ dataDir: dir }));
    expect(typeof client.getService(BundleStoreToken).put).toBe('function');
    expect(typeof client.getService(ChunkStorageToken).append).toBe('function');
  });

  it('registers an injected bundleStore as the resolvable service (by identity)', () => {
    const { store } = bundleMemStore();
    const client = launchTracked(
      'tok',
      baseOptions({ bundleStore: store, captureStore: memStore() }),
    );
    expect(client.getService(BundleStoreToken)).toBe(store); // the exact instance the durable queue uses
  });

  it('does not register bundleStore/chunkStorage in in-memory mode', () => {
    const client = launchTracked('tok', baseOptions({ captureStore: memStore() }));
    expect(() => client.getService(BundleStoreToken)).toThrow();
    expect(() => client.getService(ChunkStorageToken)).toThrow();
  });

  it('runs a carrier-contributed service manifest against the launched container (auto-registration)', () => {
    // An "extension" contributes a manifest with NO knowledge of launch; its service wires itself from a
    // base service already in the internal container (DI), and is then resolvable like any other.
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

  it('threads captureNetworkBodies to the fetch interceptor: bodies captured by default (clones)', async () => {
    const slot = globalThis as unknown as {
      fetch?: (i: unknown, init?: unknown) => Promise<unknown>;
    };
    const real = slot.fetch;
    const clone = vi.fn(() => ({ body: null }));
    slot.fetch = async () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: {},
      clone,
    });
    try {
      launchTracked('tok', baseOptions({ captureNetwork: true, captureStore: memStore() }));
      await (slot.fetch as (i: unknown) => Promise<unknown>)('https://x.test/');
      expect(clone).toHaveBeenCalled(); // captureNetworkBodies default true → response cloned for capture
    } finally {
      slot.fetch = real;
    }
  });

  it('threads captureNetworkBodies:false to the fetch interceptor: no body read (no clone)', async () => {
    const slot = globalThis as unknown as {
      fetch?: (i: unknown, init?: unknown) => Promise<unknown>;
    };
    const real = slot.fetch;
    const clone = vi.fn(() => ({ body: null }));
    slot.fetch = async () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: {},
      clone,
    });
    try {
      launchTracked(
        'tok',
        baseOptions({
          captureNetwork: true,
          captureNetworkBodies: false,
          captureStore: memStore(),
        }),
      );
      await (slot.fetch as (i: unknown) => Promise<unknown>)('https://x.test/');
      expect(clone).not.toHaveBeenCalled(); // option threaded through → interceptor skips the read
    } finally {
      slot.fetch = real;
    }
  });

  it('threads maxNetworkBodySize to the fetch interceptor: the read is bounded by the cap', async () => {
    // The interceptor's READ is bounded by maxNetworkBodySize (don't read more than needed). The
    // provider's gate would drop an over-cap body either way, so we assert the bound by counting how
    // many 1-byte chunks the clone stream was pulled for: cap 3 → ~4 pulls (stops early), not all 50.
    const slot = globalThis as unknown as {
      fetch?: (i: unknown, init?: unknown) => Promise<unknown>;
    };
    const real = slot.fetch;
    const TE = (
      globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
    ).TextEncoder;
    const RS = (globalThis as unknown as { ReadableStream: new (s: object) => unknown })
      .ReadableStream;
    let pulls = 0;
    slot.fetch = async () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb('text/plain', 'content-type'),
      },
      clone: () => ({
        body: new RS({
          pull(c: { enqueue: (x: unknown) => void; close: () => void }) {
            pulls += 1;
            if (pulls <= 50) {
              c.enqueue(new TE().encode('x')); // 1 byte per pull
            } else {
              c.close();
            }
          },
        }),
      }),
    });
    const store = memStore();
    try {
      launchTracked(
        'tok',
        baseOptions({ captureNetwork: true, maxNetworkBodySize: 3, captureStore: store }),
      );
      await (slot.fetch as (i: unknown) => Promise<unknown>)('https://x.test/');
      await new Promise<void>((r) =>
        (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => void }).setTimeout(
          r,
          0,
        ),
      );
      // cap 3 → reads 4 bytes then cancels. A non-threaded (default 20480) cap would drain all 50.
      expect(pulls).toBeLessThanOrEqual(5);
    } finally {
      slot.fetch = real;
    }
  });

  it('threads captureNetworkBodies to the node:http interceptor (off → no request-body amendment)', async () => {
    // Real loopback server: launch patches the real node:http; with captureNetworkBodies:false the
    // node:http interceptor must not capture the POST body (no override amendment).
    const server: Server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = memStore();
    try {
      launchTracked(
        'tok',
        baseOptions({ captureNetwork: true, captureNetworkBodies: false, captureStore: store }),
      );
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${origin}/x`,
          { method: 'POST', headers: { 'content-type': 'text/plain' } },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.end('a body');
      });
      await new Promise((resolve) => setImmediate(resolve));
      const overrides = (await drain(store, 'network'))?.filter(
        (e) => (e.data as { override?: boolean }).override === true,
      );
      expect(overrides ?? []).toEqual([]); // captureNetworkBodies:false threaded → no body captured
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('captures a node:http request body by default (captureNetworkBodies on)', async () => {
    const server: Server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = memStore();
    try {
      launchTracked('tok', baseOptions({ captureNetwork: true, captureStore: store }));
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${origin}/x`,
          { method: 'POST', headers: { 'content-type': 'text/plain' } },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.end('small body');
      });
      await new Promise((resolve) => setImmediate(resolve));
      const bodies = (await drain(store, 'network'))?.map(
        (e) => (e.data as { custom?: { body?: string } }).custom?.body,
      );
      expect(bodies).toContain('small body'); // node:http capture works end-to-end through launch
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('captures console output as log entries (captureLogs default on)', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store }));
    console.log('hello-from-launch-test');
    const logs = await drain(store, 'log');
    expect(logs?.some((e) => JSON.stringify(e.data).includes('hello-from-launch-test'))).toBe(true);
  });

  it('applies a log filter set on the returned client (facade → carrier service → pipeline)', async () => {
    const store = memStore();
    const client = launchTracked('tok', baseOptions({ captureStore: store })); // global carrier
    client.setLogEventFilter((e) => ({ ...e, message: e.message.replace('secret', '***') }));
    console.log('my secret data');
    const logs = await drain(store, 'log');
    expect(logs?.some((e) => JSON.stringify(e.data).includes('***'))).toBe(true);
    expect(logs?.some((e) => JSON.stringify(e.data).includes('secret'))).toBe(false);
  });

  it('does not capture console output when captureLogs is disabled', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store, captureLogs: false }));
    console.log('not-captured-by-launch-test');
    expect(await drain(store, 'log')).toBeUndefined(); // console never patched → no log stream
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
    expect(traces?.map((e) => (e.data as { name: string }).name)).toContain('process_memory_rss');
  });

  it('does not capture system traces when disabled', async () => {
    const store = memStore();
    launchTracked('tok', baseOptions({ captureStore: store, captureSystemTraces: false }));
    expect(await drain(store, 'traces.system')).toBeUndefined();
  });

  it('delivers the crash bundle BEFORE exiting on uncaughtException (ordering)', async () => {
    const order: string[] = [];
    const fp = fakeProcess(() => order.push('exit'));
    // Record when the signed PUT (the bundle delivery) reaches the transport, relative to exit.
    const transport = vi.fn<HttpTransport>(async (url: string) => {
      if (url.endsWith('/v2/sessions')) {
        return { status: 200, headers: {}, body: jsonBody({ access_token: 'a' }) };
      }
      if (url.endsWith('/v2/issues')) {
        return {
          status: 200,
          headers: {},
          body: jsonBody({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
        };
      }
      order.push('put');
      return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
    });
    launchTracked('tok', baseOptions({ process: fp.proc, transport, captureStore: memStore() }));
    fp.fire('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(fp.exit).toHaveBeenCalledWith(1));
    expect(order).toEqual(['put', 'exit']); // bundle delivered, THEN exit — not the reverse / parallel
  });

  it('installs the crash handler but does not exit when exitOnUncaught is false', async () => {
    const fp = fakeProcess();
    const transport = uploadTransport();
    launchTracked(
      'tok',
      baseOptions({ process: fp.proc, transport, captureStore: memStore(), exitOnUncaught: false }),
    );
    // The launch crash handler is installed alongside the uncaught detection provider (2 listeners);
    // deleting the handler would drop this to 1, so this pins the handler's presence.
    expect(fp.count('uncaughtException')).toBe(2);
    fp.fire('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(transport.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(fp.exit).not.toHaveBeenCalled();
  });

  it('installs no uncaughtException handler when detectCrashes is false', () => {
    const fp = fakeProcess();
    launchTracked(
      'tok',
      baseOptions({ process: fp.proc, captureStore: memStore(), detectCrashes: false }),
    );
    expect(fp.count('uncaughtException')).toBe(0);
  });

  it('removes the crash handler on stop (a later uncaughtException neither flushes nor exits)', async () => {
    const fp = fakeProcess();
    const client = launch('tok', baseOptions({ process: fp.proc, captureStore: memStore() }));
    expect(fp.count('uncaughtException')).toBe(2); // detection provider + crash handler
    await client.stop();
    expect(fp.count('uncaughtException')).toBe(0); // both removed
    fp.fire('uncaughtException', new Error('after stop'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fp.exit).not.toHaveBeenCalled();
  });

  it('tags every SDK request with X-Bugsee-Internal and targets the default endpoint', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    await client.logException(new Error('x'));
    expect(transport.mock.calls[0]?.[0]).toBe('https://api.bugsee.com/v2/sessions');
    // The control-plane calls carry x-bugsee-internal via BugseeApi already; the transport wrapper's
    // unique job is tagging the signed S3 PUT (the uploader sets no such header), so assert it there.
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

  it('builds a Node environment envelope with sdk version, gates, and app defaults', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport, captureStore: memStore() }));
    await client.logException(new Error('x'));
    const sessionBody = JSON.parse(
      String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body),
    ) as { environment: EnvironmentEnvelope };
    const env = sessionBody.environment;
    expect(env.platform.type).toBe('node');
    expect(env.platform.version).toBe('20.1.2'); // from the injected probe
    // friendly captureNetwork:false → canonical com.bugsee.option.capture.network → colon wire form
    expect(env.sdk.options).toMatchObject({
      [optionKeyToWire(BugseeOption.CaptureLogs)]: true,
      [optionKeyToWire(BugseeOption.CaptureNetwork)]: false,
    });
    expect(env.app?.package_id).toBe('unknown'); // default when appId omitted
  });

  it('reports maxDataSize (default 50 MB) in the wire-form sdk.options, and honors an override', async () => {
    const sdkOptions = async (over: Partial<BugseeLaunchOptions>) => {
      const transport = uploadTransport();
      // Fresh carrier per call so each launch is independent (the per-process singleton guard would
      // otherwise ignore the second launch in this test).
      const client = launchTracked(
        'tok',
        baseOptions({ transport, captureStore: memStore(), carrier: {}, ...over }),
      );
      await client.logException(new Error('x'));
      const env = (
        JSON.parse(String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body)) as {
          environment: EnvironmentEnvelope;
        }
      ).environment;
      return env.sdk.options as Record<string, unknown>;
    };
    expect((await sdkOptions({}))[optionKeyToWire(BugseeOption.MaxDataSize)]).toBe(50); // default
    expect((await sdkOptions({ maxDataSize: 7 }))[optionKeyToWire(BugseeOption.MaxDataSize)]).toBe(
      7,
    );
  });

  it('registers the process-global interceptor singletons on the carrier (one patch each)', () => {
    const carrier = {};
    launchTracked('tok', baseOptions({ captureStore: memStore(), carrier }));
    const reg = getCarrier(carrier).interceptors;
    expect(reg.get('console')).toBeDefined();
    expect(reg.get('node-http')).toBeDefined();
    expect(reg.get('fetch')).toBeDefined();
    // console + node-http + the 5 cross-runtime network leaves = 7 process-global interceptors.
    expect(reg.size).toBe(7);
  });

  it('is a per-process singleton: a second launch() warns, is ignored, and returns the first client', async () => {
    const carrier = {};
    const onError = vi.fn();
    const first = launchTracked('tok', baseOptions({ captureStore: memStore(), carrier, onError }));
    const console1 = getCarrier(carrier).interceptors.get('console');
    expect(getCarrier(carrier).interceptors.size).toBe(7);

    const second = launchTracked(
      'tok',
      baseOptions({ captureStore: memStore(), carrier, onError }),
    );
    expect(second).toBe(first); // the repeat launch built nothing new — same client back
    expect(onError).toHaveBeenCalledTimes(1); // warned once
    expect(getCarrier(carrier).interceptors.get('console')).toBe(console1); // not re-wired
    expect(getCarrier(carrier).interceptors.size).toBe(7); // not doubled

    // After stop() the singleton is released, so a later launch() builds a fresh client.
    await first.stop();
    const third = launchTracked('tok', baseOptions({ captureStore: memStore(), carrier, onError }));
    expect(third).not.toBe(first);
  });

  it('passes through app identity and a custom sdk version', async () => {
    const transport = uploadTransport();
    const client = launchTracked(
      'tok',
      baseOptions({
        transport,
        captureStore: memStore(),
        appId: 'com.acme.app',
        appVersion: '2.5.0',
        appBuild: '42',
        sdkVersion: '9.9.9',
      }),
    );
    await client.logException(new Error('x'));
    const env = (
      JSON.parse(String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body)) as {
        environment: EnvironmentEnvelope;
      }
    ).environment;
    expect(env.app).toMatchObject({ package_id: 'com.acme.app', version: '2.5.0', build: '42' });
    expect(env.sdk.version).toBe('9.9.9');
  });

  it('persists capture to a file-backed store under the per-instance subtree when dataDir is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-launch-'));
    launchTracked('tok', baseOptions({ dataDir: dir, instanceIdentity: FIXED_INSTANCE }));
    console.log('to-disk-from-launch-test');
    // The file store lays out chunk dirs under <dataDir>/<instanceId>/capture/<gen13>/<chunk12>/{meta,…}.
    const cap = join(dir, '1-0-x', 'capture');
    expect(readdirSync(cap).some((name) => /^\d{13}$/.test(name))).toBe(true);
  });

  it('uses the injected clock for the file-backed generation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-launch-clk-'));
    launchTracked(
      'tok',
      baseOptions({ dataDir: dir, clock: fixedClock, instanceIdentity: FIXED_INSTANCE }),
    );
    console.log('to-disk-with-clock');
    // generation = clock.wallNow() = 1000 → the zero-padded-to-13 generation dir name.
    expect(readdirSync(join(dir, '1-0-x', 'capture'))).toContain('0000000001000');
  });

  it('uses the BATCHED capture writer: buffered entries are flushed to disk on stop()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-batched-'));
    const client = launchTracked(
      'tok',
      baseOptions({ dataDir: dir, clock: fixedClock, instanceIdentity: FIXED_INSTANCE }),
    );
    console.log('batched-capture-marker-xyz'); // → console interceptor → log capture → batched append
    await client.stop(); // dispose() flushes + closes the batched writer's handles

    const cap = join(dir, '1-0-x', 'capture');
    const data = readdirSync(cap, { recursive: true })
      .map((n) => join(cap, n.toString()))
      .filter((p) => statSync(p).isFile())
      .map((p) => readFileSync(p, 'utf8'))
      .join('');
    expect(data).toContain('batched-capture-marker-xyz'); // durable on disk after the dispose flush
  });

  it('writes owner.json and the .live heartbeat under the instance subtree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-owner-'));
    launchTracked('tok', baseOptions({ dataDir: dir, instanceIdentity: FIXED_INSTANCE }));
    expect(existsSync(join(dir, FIXED_INSTANCE_ID, 'owner.json'))).toBe(true); // peer attribution/liveness
    expect(existsSync(join(dir, FIXED_INSTANCE_ID, '.live'))).toBe(true); // heartbeat beat once on launch
  });

  it('defaults the transport to node-utils httpRequest when none is injected', () => {
    // No transport supplied → the real httpRequest is wired (assigned, never called: no report here).
    const client = launch('tok', {
      process: fakeProcess().proc,
      systemProbe: probe,
      systemMetricsSampler: () => [],
      captureNetwork: false,
      captureStore: memStore(),
    });
    clients.push(client);
    expect(client.isLaunched()).toBe(true);
  });

  it('routes a provider-start failure to onError and still launches (never throws, §15.1)', () => {
    const onError = vi.fn();
    // The system-traces provider samples on start; a sampler that throws makes its start() throw.
    // launch must isolate that to onError and still come up launched (the §15.1 guarantee).
    const client = launchTracked(
      'tok',
      baseOptions({
        captureStore: memStore(),
        onError,
        clock: fixedClock,
        scheduler: fakeScheduler().scheduler,
        systemMetricsSampler: () => {
          throw new Error('sampler boom');
        },
      }),
    );
    expect(client.isLaunched()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('sampler boom');
  });

  it('uses the real Node process / system probe / metrics sampler when not injected', async () => {
    // Omit process, systemProbe and systemMetricsSampler → real defaults wire in. Detection +
    // system events off so the real process is never subscribed; system traces on exercises the
    // real Node sampler (an initial real memory/cpu/event-loop sample).
    const store = memStore();
    launchTracked('tok', {
      transport: uploadTransport(),
      captureStore: store,
      captureNetwork: false,
      detectCrashes: false,
      captureSystemEvents: false,
    });
    const traces = await drain(store, 'traces.system');
    expect(traces?.some((e) => (e.data as { name: string }).name === 'process_memory_rss')).toBe(
      true,
    );
  });

  it('enables network capture by default (captureNetwork omitted)', () => {
    // captureNetwork omitted → defaults on → the network provider starts and patches the real
    // global fetch / node:http; afterEach stop() restores them.
    const client = launchTracked('tok', {
      process: fakeProcess().proc,
      transport: uploadTransport(),
      systemProbe: probe,
      systemMetricsSampler: () => [],
      captureStore: memStore(),
      detectCrashes: false,
    });
    expect(client.isLaunched()).toBe(true);
  });

  it('re-uploads a bundle left by a prior crashed run on launch (durable recovery)', async () => {
    const { store, map } = bundleMemStore();
    map.set('leftover', pendingBundle('recovered-crash'));
    const transport = uploadTransport();
    launchTracked(
      'tok',
      baseOptions({
        process: fakeProcess().proc,
        transport,
        captureStore: memStore(),
        bundleStore: store,
      }),
    );
    await vi.waitFor(() => expect(map.has('leftover')).toBe(false)); // re-uploaded → removed
    const issue = transport.mock.calls.find(([url]) => url.endsWith('/v2/issues'));
    expect(JSON.parse(String((issue?.[1] as HttpRequestOptions).body)).summary).toBe(
      'recovered-crash',
    );
  });

  it('persists a report bundle before upload and removes it on success (durable queue)', async () => {
    const { store, map, puts } = bundleMemStore();
    const transport = uploadTransport();
    const client = launchTracked(
      'tok',
      // onError threaded into the durable pipeline (a real, error-free run here).
      baseOptions({ transport, captureStore: memStore(), bundleStore: store, onError: vi.fn() }),
    );
    await client.logException(new Error('boom'));
    expect(puts).toHaveLength(1); // staged durably before the upload
    expect(map.size).toBe(0); // confirmed delivered → durable copy removed
  });

  it('does not re-upload leftovers (or persist) when recover is false', async () => {
    const { store, map } = bundleMemStore();
    map.set('leftover', pendingBundle('should-not-upload'));
    const transport = uploadTransport();
    launchTracked(
      'tok',
      baseOptions({ transport, captureStore: memStore(), bundleStore: store, recover: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(map.has('leftover')).toBe(true); // durable disabled → leftover untouched
    expect(transport.mock.calls).toHaveLength(0); // nothing re-uploaded
  });

  it('launches with all defaults (in-memory store, global timers, no overrides)', async () => {
    // Only the seams needed to avoid real process/network/perf_hooks + global patching; everything
    // else (store, clock, scheduler, onError) defaults — exercising those omitted branches.
    const client = launch('tok', {
      process: fakeProcess().proc,
      transport: uploadTransport(),
      systemProbe: probe,
      systemMetricsSampler: () => [],
      captureNetwork: false,
    });
    clients.push(client);
    expect(client.isLaunched()).toBe(true);
  });
});

// --- capture recovery (R4): a prior run's detected incident is rebuilt + delivered next launch -------

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
    return { status: 200, headers: {}, body: new Uint8Array() };
  });
  return { fn, puts };
}

const logRecord = (data: unknown): StoredEntry => ({
  type: 'log',
  timestamp: 1,
  serialized: JSON.stringify({ timestamp: 1, data }),
});

// A deterministic identity for the LIVE launch (so its subtree path is predictable in assertions).
const FIXED_INSTANCE = { pid: 1, threadId: 0, nonce: () => 'x' };
const FIXED_INSTANCE_ID = '1-0-x';
// A DEAD sibling instance's subtree name — a prior crashed run the coordinator must recover + remove.
const PRIOR_INSTANCE = '9-9-prior';

// Write a dead-pid owner.json so the liveness gate sees the seeded sibling as dead (recoverable).
const writeDeadOwner = (sub: string): void => {
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'owner.json'),
    JSON.stringify({
      instanceId: PRIOR_INSTANCE,
      pid: 999_999,
      threadId: 0,
      startedAt: 1,
      version: '0',
    }),
  );
};

// Seed a prior crashed instance's subtree under `<dataDir>/<PRIOR_INSTANCE>/`: a closed chunk generation +
// (optionally) a pending-incident marker. The live launch's coordinator scans it as a dead sibling.
function seedPriorGeneration(
  dataDir: string,
  gen: number,
  data: unknown,
  withMarker: boolean,
): void {
  const sub = join(dataDir, PRIOR_INSTANCE);
  writeDeadOwner(sub);
  const backend = createFileChunkBackend(createFsChunkStorage(join(sub, 'capture')), {
    generation: gen,
    cleanOtherGenerations: false,
  });
  backend.openPart({ generation: gen, number: 0 }, gen);
  backend.appendEntry({ generation: gen, number: 0 }, logRecord(data));
  backend.closePart({ generation: gen, number: 0 }, gen + 100, 0);
  if (withMarker) {
    createNodeReportMarkerStore(join(sub, 'incidents')).put({
      generation: gen,
      request: createReportingRequest({ source: { type: 'crash' }, id: 'inc-1' }),
      attributes: {},
      userIdentifier: null,
    });
  }
}

describe('launch — capture recovery', () => {
  // The launch generation is fixedClock.wallNow() = 1000, so prior gens use 500 (≠ 1000).
  it('rebuilds + uploads a prior run’s detected incident, then sweeps its generation + marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-'));
    seedPriorGeneration(dir, 500, { m: 'pre-crash' }, true);
    const { fn: transport, puts } = recordingTransport();
    const onError = vi.fn();

    launchTracked(
      'tok',
      baseOptions({
        transport,
        clock: fixedClock,
        dataDir: dir,
        onError,
        instanceIdentity: FIXED_INSTANCE,
      }),
    );

    // The recovered bundle is uploaded (the only thing that triggers a signed PUT here).
    await vi.waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1));
    const files = unzipSync(puts[0] as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([{ m: 'pre-crash' }]);
    expect(strFromU8(files.apptoken as Uint8Array)).toBe('tok'); // assembled with the launch app token

    // The dead sibling subtree is fully recovered and REMOVED (markers + chunks gone with it).
    await vi.waitFor(() => expect(existsSync(join(dir, PRIOR_INSTANCE))).toBe(false));
    // The LIVE instance's own subtree is never touched by recovery.
    expect(existsSync(join(dir, FIXED_INSTANCE_ID, 'capture'))).toBe(true);
    expect(onError).not.toHaveBeenCalled(); // recovery completed cleanly
  });

  it('writes a recovery marker for a live incident, tagged with this launch’s generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-write-'));
    const client = launchTracked('tok', baseOptions({ clock: fixedClock, dataDir: dir }));
    // The client uses the SAME marker store the container registered (the launch wiring link).
    const putSpy = vi.spyOn(client.getService(ReportMarkerStoreToken), 'put');

    await client.logException(new Error('live boom'));

    expect(putSpy).toHaveBeenCalledTimes(1);
    const marker = putSpy.mock.calls[0]?.[0];
    expect(marker?.generation).toBe(1000); // fixedClock.wallNow() = this launch's capture generation
    expect(marker?.request.report.summary).toBe('live boom');
  });

  it('sweeps a no-incident prior generation without uploading anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-noinc-'));
    seedPriorGeneration(dir, 500, { m: 'orphan' }, false); // chunks, but NO marker
    const { fn: transport, puts } = recordingTransport();

    launchTracked('tok', baseOptions({ transport, clock: fixedClock, dataDir: dir }));

    // The dead sibling (no incident) is swept entirely — its subtree removed — and nothing is uploaded.
    await vi.waitFor(() => expect(existsSync(join(dir, PRIOR_INSTANCE))).toBe(false));
    expect(puts).toEqual([]); // no incident → no report
  });

  it('registers the report-marker store as a service in file-backed recovery mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-svc-'));
    const client = launchTracked('tok', baseOptions({ dataDir: dir }));
    expect(typeof client.getService(ReportMarkerStoreToken).put).toBe('function');
  });

  it('does not recover (or build a marker store) when recover:false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-off-'));
    seedPriorGeneration(dir, 500, { m: 'x' }, true);
    const { fn: transport, puts } = recordingTransport();
    const client = launchTracked(
      'tok',
      baseOptions({ transport, clock: fixedClock, dataDir: dir, recover: false }),
    );
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow(); // no marker store built
    expect(puts).toEqual([]); // no recovery upload
    expect(existsSync(dir)).toBe(true);
    // With recovery off the coordinator never runs: the dead sibling's subtree is left untouched.
    expect(existsSync(join(dir, PRIOR_INSTANCE))).toBe(true);
  });

  it('builds no marker store when an explicit captureStore overrides the file backend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-override-'));
    const client = launchTracked('tok', baseOptions({ captureStore: memStore(), dataDir: dir }));
    expect(() => client.getService(ReportMarkerStoreToken)).toThrow(); // override → no file recovery
  });

  it('routes a corrupt pending marker to onError during recovery (best-effort)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-corrupt-'));
    const sub = join(dir, PRIOR_INSTANCE);
    writeDeadOwner(sub);
    mkdirSync(join(sub, 'incidents'), { recursive: true });
    writeFileSync(join(sub, 'incidents', 'bad.marker'), 'not-json'); // a torn marker a prior run left
    const onError = vi.fn();
    launchTracked('tok', baseOptions({ clock: fixedClock, dataDir: dir, onError }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  // CPU profiling (opt-in): a rolling V8 profile attached to the bundle at report time (real inspector).
  const profileInBundle = (transport: ReturnType<typeof uploadTransport>): boolean => {
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    return 'profile.json' in files;
  };

  it('attaches a rolling CPU profile to the bundle when profiling is enabled', async () => {
    // A FAKE profiler (no real node:inspector — a real V8 Profiler would corrupt vitest's v8 coverage).
    // collect() is gated on start() like the real one, so a missing controller.start() yields no profile.
    const cpuProfile = {
      nodes: [{ id: 1 }],
      startTime: 0,
      endTime: 5,
      samples: [1],
      timeDeltas: [0],
    };
    let started = false;
    const cpuProfiler = {
      get running() {
        return started;
      },
      start: async () => {
        started = true;
      },
      collect: async () => (started ? cpuProfile : undefined),
      stop: async () => cpuProfile,
    };
    const transport = uploadTransport();
    const { scheduler } = fakeScheduler();
    const client = launchTracked(
      'tok',
      baseOptions({ transport, captureStore: memStore(), scheduler, profiling: true, cpuProfiler }),
    );
    await client.logException(new Error('boom'));
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    expect('profile.json' in files).toBe(true);
    // profile.json is the single bare .cpuprofile object (the assembler's profile special-case).
    expect(JSON.parse(strFromU8(files['profile.json'] as Uint8Array))).toEqual(cpuProfile);
  });

  it('reports a main-thread hang as an AppHang error (detectHangs default on)', async () => {
    // A FAKE watchdog (no real worker_threads); the launch captures its onHang and we drive a hang.
    const transport = uploadTransport();
    let onHang: ((l: HangLevel, d: number) => void) | undefined;
    let thresholds: { fairMs: number; mediumMs: number; severeMs: number } | undefined;
    launchTracked(
      'tok',
      baseOptions({
        transport,
        captureStore: memStore(),
        scheduler: fakeScheduler().scheduler,
        hangFairMs: 1234, // a non-default threshold must flow through from options
        hangWatchdogFactory: (deps) => {
          onHang = deps.onHang;
          thresholds = deps.thresholds;
          return { start() {}, stop() {} };
        },
      }),
    );
    expect(onHang).toBeDefined(); // provider built + started (default on)
    expect(thresholds).toEqual({ fairMs: 1234, mediumMs: 5000, severeMs: 10_000 });
    onHang?.('severe', 12_000);
    await vi.waitFor(() =>
      expect(transport.mock.calls.some(([u]) => u === 'https://s3.test/put')).toBe(true),
    );
    const put = transport.mock.calls.find(([u]) => u === 'https://s3.test/put');
    const req = JSON.parse(
      strFromU8(
        unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array)[
          'request.json'
        ] as Uint8Array,
      ),
    );
    expect(req.summary).toBe('Main thread hang detected');
    expect(req.labels).toContain('AppHang::Severe');
  });

  it('does not start hang detection when detectHangs is false', () => {
    let started = false;
    launchTracked(
      'tok',
      baseOptions({
        captureStore: memStore(),
        scheduler: fakeScheduler().scheduler,
        detectHangs: false,
        hangWatchdogFactory: () => ({
          start: () => {
            started = true;
          },
          stop() {},
        }),
      }),
    );
    expect(started).toBe(false); // the controllingOption gate skips a disabled provider
  });

  it('attaches NO profile when profiling is disabled (the default)', async () => {
    const transport = uploadTransport();
    const { scheduler } = fakeScheduler();
    const client = launchTracked(
      'tok',
      baseOptions({ transport, captureStore: memStore(), scheduler }),
    );
    await client.logException(new Error('boom'));
    expect(profileInBundle(transport)).toBe(false);
  });
});

// launchCore() is the seam the umbrella uses: it returns the same public client launch() returns, PLUS the
// internal wiring the umbrella needs to wire performance/OTel. launch() = launchCore(...).client.
describe('launchCore', () => {
  it('returns the public client plus a populated internals bag', () => {
    const { client, internals } = launchCore(
      'tok',
      baseOptions({ carrier: {}, captureStore: memStore(), appVersion: '1.2.3', appBuild: '99' }),
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
    expect(internals?.getEnvironment().platform).toBeDefined(); // a real node envelope
    expect(internals?.network.interceptor).toBeDefined(); // the network source (+ request-decorator seam)
    expect(internals?.onError).toBeUndefined();
  });

  it('carries the injected endpoint + onError on the internals bag', () => {
    const onError = vi.fn();
    const { client, internals } = launchCore(
      'tok',
      baseOptions({
        carrier: {},
        captureStore: memStore(),
        endpoint: 'https://eu.bugsee.test',
        onError,
      }),
    );
    clients.push(client);
    expect(internals?.baseUrl).toBe('https://eu.bugsee.test');
    expect(internals?.onError).toBe(onError);
    expect(internals?.appVersion).toBeUndefined();
  });

  it('returns internals: undefined on a repeat launch (the process singleton is already owned)', () => {
    const carrier = {};
    const first = launchCore('tok', baseOptions({ carrier, captureStore: memStore() }));
    clients.push(first.client);
    const onError = vi.fn();
    const second = launchCore('tok', baseOptions({ carrier, captureStore: memStore(), onError }));
    expect(second.client).toBe(first.client); // the existing client, not a second one
    expect(second.internals).toBeUndefined(); // nothing to re-wire
    expect(onError).toHaveBeenCalledTimes(1); // the repeat-launch warning still fires
  });

  it('launch() returns exactly launchCore().client (public surface unchanged)', () => {
    const carrier = {};
    const client = launch('tok', baseOptions({ carrier, captureStore: memStore() }));
    clients.push(client);
    expect(launchCore('tok', baseOptions({ carrier, captureStore: memStore() })).client).toBe(
      client,
    );
  });
});

describe('launch — incoming-server instrumentation wiring', () => {
  const mk = (name: string, order: string[]) => ({
    install: vi.fn(() => {
      order.push(`install:${name}`);
    }),
    uninstall: vi.fn(() => {
      order.push(`uninstall:${name}`);
    }),
  });
  // These tests use BARE launch (untracked) + REAL prototype patching. detectHangs:false avoids spawning
  // a real ANR worker per launch; the afterEach is a defense-in-depth net so a patched global never leaks
  // to another test even if a stop() rejected.
  const opts = (over: Partial<BugseeLaunchOptions> = {}) =>
    baseOptions({ detectHangs: false, ...over });
  afterEach(() => {
    for (const proto of [http.Server.prototype, https.Server.prototype]) {
      if (Object.hasOwn(proto, 'emit')) {
        delete (proto as { emit?: unknown }).emit;
      }
    }
  });

  it('default (no flag): installs server instrumentation (ON BY DEFAULT)', async () => {
    const order: string[] = [];
    const httpIc = mk('http', order);
    const native = mk('native', order);
    const client = launch(
      'tok',
      opts({ serverInterceptor: httpIc, serverInstrumentations: [native] }),
    );
    // Default-on: the node:http interceptor + the injected instrumentations install without any flag.
    expect(httpIc.install).toHaveBeenCalledTimes(1);
    expect(native.install).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['install:http', 'install:native']);
    await client.stop();
    expect(order).toEqual(['install:http', 'install:native', 'uninstall:http', 'uninstall:native']);
  });

  it('escape hatch (instrumentIncomingRequests: false): installs no server instrumentation', async () => {
    const order: string[] = [];
    const httpIc = mk('http', order);
    const native = mk('native', order);
    const client = launch(
      'tok',
      opts({
        instrumentIncomingRequests: false,
        serverInterceptor: httpIc,
        serverInstrumentations: [native],
      }),
    );
    expect(httpIc.install).not.toHaveBeenCalled();
    expect(native.install).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    await client.stop();
  });

  it('flag on: installs the node:http interceptor then the injected serverInstrumentations; stop uninstalls all', async () => {
    const order: string[] = [];
    const httpIc = mk('http', order);
    const native = mk('native', order);
    const client = launch(
      'tok',
      opts({
        instrumentIncomingRequests: true,
        serverInterceptor: httpIc,
        serverInstrumentations: [native],
      }),
    );
    expect(httpIc.install).toHaveBeenCalledTimes(1);
    expect(native.install).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['install:http', 'install:native']); // node:http first, injected after (concatenated)
    await client.stop();
    expect(httpIc.uninstall).toHaveBeenCalledTimes(1);
    expect(native.uninstall).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['install:http', 'install:native', 'uninstall:http', 'uninstall:native']);
  });

  it('flag on with no serverInstrumentations: installs ONLY the node:http interceptor', async () => {
    const order: string[] = [];
    const httpIc = mk('http', order);
    const client = launch(
      'tok',
      opts({ instrumentIncomingRequests: true, serverInterceptor: httpIc }),
    );
    expect(httpIc.install).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['install:http']); // the `?? []` fallback adds nothing
    await client.stop();
    expect(httpIc.uninstall).toHaveBeenCalledTimes(1);
  });

  it('an install failure undoes the partial install, reports via onError, and does NOT break launch', async () => {
    const order: string[] = [];
    const onError = vi.fn();
    const good = mk('good', order);
    const bad = {
      install: vi.fn(() => {
        order.push('install:bad');
        throw new Error('install blew up');
      }),
      uninstall: vi.fn(() => {
        order.push('uninstall:bad');
      }),
    };
    const client = launch(
      'tok',
      opts({
        instrumentIncomingRequests: true,
        serverInterceptor: good,
        serverInstrumentations: [bad],
        onError,
      }),
    );
    expect(client.isLaunched()).toBe(true); // launch still succeeded
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(good.uninstall).toHaveBeenCalledTimes(1); // the partially-installed one was undone
    expect(bad.uninstall).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['install:good', 'install:bad', 'uninstall:good', 'uninstall:bad']);
    await client.stop();
  });

  it('flag on with the REAL interceptor patches + restores http(s).Server.prototype (idempotent stop)', async () => {
    expect(Object.hasOwn(http.Server.prototype, 'emit')).toBe(false);
    expect(Object.hasOwn(https.Server.prototype, 'emit')).toBe(false);
    const client = launch('tok', opts({ instrumentIncomingRequests: true }));
    try {
      expect(Object.hasOwn(http.Server.prototype, 'emit')).toBe(true); // http patched
      expect(Object.hasOwn(https.Server.prototype, 'emit')).toBe(true); // https patched too
    } finally {
      await client.stop();
    }
    expect(Object.hasOwn(http.Server.prototype, 'emit')).toBe(false); // http restored
    expect(Object.hasOwn(https.Server.prototype, 'emit')).toBe(false); // https restored
    await client.stop(); // idempotent — a second stop does not throw or re-corrupt the prototypes
    expect(Object.hasOwn(http.Server.prototype, 'emit')).toBe(false);
  });

  it('flag on (real interceptor): a real request opens a context — the lazy getClient resolves the carrier client', async () => {
    const client = launch('tok', opts({ instrumentIncomingRequests: true }));
    const store = client.getService(RequestContextStoreToken);
    let ctxDuring: string | undefined;
    const server = createServer((_req, res) => {
      ctxDuring = store.getCurrent()?.contextId;
      res.end('ok');
    });
    try {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/p' }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          })
          .on('error', reject);
      });
      expect(ctxDuring).toBeDefined(); // context active in the handler → getClient resolved the carrier client
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await client.stop();
    }
    expect(Object.hasOwn(http.Server.prototype, 'emit')).toBe(false); // restored
  });
});
