import { mkdtempSync, readdirSync } from 'node:fs';
import http, { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BundleStore,
  BundleStoreToken,
  CaptureStoreToken,
  type Clock,
  contributeServiceManifest,
  createCaptureExporter,
  createMemoryCaptureStore,
  defineService,
  FileStorageAdapterToken,
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SystemProbe, SystemProbeToken } from './environment';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';

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
  nodeVersion: () => '20.1.2',
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

  it('registers bundleStore + fileStorageAdapter as services in file-backed (dataDir) mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-di-'));
    const client = launchTracked('tok', baseOptions({ dataDir: dir }));
    expect(typeof client.getService(BundleStoreToken).put).toBe('function');
    expect(typeof client.getService(FileStorageAdapterToken).append).toBe('function');
  });

  it('registers an injected bundleStore as the resolvable service (by identity)', () => {
    const { store } = bundleMemStore();
    const client = launchTracked(
      'tok',
      baseOptions({ bundleStore: store, captureStore: memStore() }),
    );
    expect(client.getService(BundleStoreToken)).toBe(store); // the exact instance the durable queue uses
  });

  it('does not register bundleStore/fileStorageAdapter in in-memory mode', () => {
    const client = launchTracked('tok', baseOptions({ captureStore: memStore() }));
    expect(() => client.getService(BundleStoreToken)).toThrow();
    expect(() => client.getService(FileStorageAdapterToken)).toThrow();
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

  it('persists capture to a file-backed store when dataDir is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-launch-'));
    launchTracked('tok', baseOptions({ dataDir: dir })); // no clock → default system clock
    console.log('to-disk-from-launch-test');
    // The file store writes per-part capture files (generation__part__type).
    expect(readdirSync(dir).some((name) => /^\d{13}__\d{12}__/.test(name))).toBe(true);
  });

  it('uses the injected clock for the file-backed generation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-launch-clk-'));
    launchTracked('tok', baseOptions({ dataDir: dir, clock: fixedClock }));
    console.log('to-disk-with-clock');
    // generation = clock.wallNow() = 1000, zero-padded to 13 digits.
    expect(readdirSync(dir).some((name) => name.startsWith('0000000001000__'))).toBe(true);
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
