import * as core from '@bugsee/core';
import {
  contributeServiceManifest,
  createSystemClock,
  getOrCreateInterceptor,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  type Scheduler,
} from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEdgeStore } from './edge-context';
import { type BugseeEdgeLaunchOptions, EdgeContextStoreToken, launchEdge } from './launch';

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

// A scheduler whose timers never auto-fire (deterministic — the capture-store tick is irrelevant here).
const inertScheduler: Scheduler = {
  setInterval: () => 0 as unknown as ReturnType<Scheduler['setInterval']>,
  clearInterval: () => {},
};

// A fake global event target for unhandledrejection detection.
function fakeTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const target = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    emit: (type: string, event: unknown) => {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

const clients: ReturnType<typeof launchEdge>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const baseOptions = (over: Partial<BugseeEdgeLaunchOptions> = {}): BugseeEdgeLaunchOptions => ({
  transport: uploadTransport(),
  scheduler: inertScheduler,
  captureNetwork: false, // don't patch the real fetch global in unit tests
  ...over,
});

const launchTracked = (token: string, options: BugseeEdgeLaunchOptions) => {
  const client = launchEdge(token, options);
  clients.push(client);
  return client;
};

const findPut = (transport: ReturnType<typeof uploadTransport>) =>
  transport.mock.calls.find(([url]) => url === 'https://s3.test/put');

// The /v2/issues request body (request.json) — sent as a JSON STRING (createIssue uses JSON.stringify).
const issueJson = (transport: ReturnType<typeof uploadTransport>) => {
  const call = transport.mock.calls.find(([url]) => url.endsWith('/v2/issues'));
  return JSON.parse((call?.[1] as HttpRequestOptions).body as string) as {
    summary?: string;
    description?: string;
    environment: {
      platform: { type: string; version: string };
      app?: { package_id: string; version: string; build: string };
    };
  };
};

describe('launchEdge', () => {
  it('uploads a bundle on logException through the full edge path (session→issue→PUT)', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport }));
    await client.logException(new Error('edge boom'));
    await client.flush();
    // the issue (request.json) carries the thrown error; a non-empty bundle zip is PUT to the signed URL
    expect(JSON.stringify(issueJson(transport))).toContain('edge boom');
    const put = findPut(transport);
    expect(put).toBeDefined();
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    expect(Object.keys(files).length).toBeGreaterThan(0); // a real bundle was assembled + uploaded
  });

  it('reports the edge platform type in the environment (default edge-light)', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.platform.type).toBe('edge-light');
  });

  it('honors an overridden platformType (workers)', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport, platformType: 'workers' }));
    await client.logException(new Error('x'));
    await client.flush();
    expect(issueJson(transport).environment.platform.type).toBe('workers');
  });

  it('tags every SDK request with x-bugsee-internal WITHOUT clobbering the upstream headers', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    // the PUT: the wrapper adds x-bugsee-internal AND the merge PRESERVES the uploader's signed-PUT header
    // (x-amz-checksum-sha256 comes only from bundle-uploader's options.headers — proves `...options.headers`).
    const put = findPut(transport);
    expect((put?.[1] as HttpRequestOptions).headers?.['x-bugsee-internal']).toBe('1');
    expect((put?.[1] as HttpRequestOptions).headers?.['x-amz-checksum-sha256']).toBeDefined();
    // the control-plane /v2/issues call: the merge also preserves the Bearer authorization header.
    const issues = transport.mock.calls.find(([url]) => url.endsWith('/v2/issues'));
    const issueHeaders = (issues?.[1] as HttpRequestOptions).headers;
    expect(issueHeaders?.['x-bugsee-internal']).toBe('1');
    expect(String(issueHeaders?.authorization)).toMatch(/^Bearer /);
  });

  it('captures console output as log entries (captureLogs default on)', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport }));
    console.log('hello-edge'); // captured by the console interceptor
    await client.logException(new Error('x'));
    await client.flush();
    const put = findPut(transport);
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    const logsFile = Object.keys(files).find((n) => n.includes('log'));
    expect(logsFile).toBeDefined();
    expect(strFromU8(files[logsFile as string] as Uint8Array)).toContain('hello-edge');
  });

  it('registers the edge context store under EdgeContextStoreToken (the wrapper opens contexts via run)', () => {
    const client = launchTracked('tok', baseOptions());
    const store = client.getService(EdgeContextStoreToken);
    expect(store).toBeDefined();
    expect(typeof store?.run).toBe('function');
    // stamps the active context for captures within run()
    const seen = store?.run({ contextId: 'req-1' }, () => store.getCurrent()?.contextId);
    expect(seen).toBe('req-1');
  });

  it('wires the edge context store as the core ContextProvider (captures inside run() carry context_id)', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport }));
    const store = client.getService(EdgeContextStoreToken);
    // a console log recorded INSIDE a per-request context must be stamped with that context's id in the bundle —
    // proves the store is passed as createClient({contextProvider}), not merely registered under the token.
    store?.run({ contextId: 'req-stamp' }, () => console.log('inside-the-context'));
    await client.logException(new Error('x'));
    await client.flush();
    const put = findPut(transport);
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    const logsFile = Object.keys(files).find((n) => n.includes('log'));
    const logs = strFromU8(files[logsFile as string] as Uint8Array);
    expect(logs).toContain('inside-the-context');
    expect(logs).toContain('req-stamp'); // the active context's id was stamped onto the entry
  });

  it('threads app + runtime identity options into the environment', async () => {
    const transport = uploadTransport();
    const client = launchTracked(
      'tok',
      baseOptions({
        transport,
        appId: 'com.acme.edge',
        appVersion: '2.0.0',
        appBuild: '99',
        runtimeVersion: 'edge-runtime/1.2',
      }),
    );
    await client.logException(new Error('x'));
    await client.flush();
    const env = issueJson(transport).environment;
    expect(env.platform.version).toBe('edge-runtime/1.2');
    expect(env.app).toMatchObject({ package_id: 'com.acme.edge', version: '2.0.0', build: '99' });
  });

  it('accepts an injected clock + logger and a DEFAULT scheduler (none injected)', async () => {
    const logger = { warnOnce: vi.fn() };
    const clock = createSystemClock();
    const storeSpy = vi.spyOn(core, 'createMemoryCaptureStore');
    // no `scheduler` here → exercises the default-scheduler path; clock + logger → their injected branches.
    const client = launchEdge('tok', {
      transport: uploadTransport(),
      captureNetwork: false,
      clock,
      logger,
      carrier: {},
    });
    clients.push(client);
    await client.logException(new Error('x'));
    await client.flush();
    // "accepts" has to mean USES: asserting only that launch returned something passes just as well when
    // both injected seams are dropped on the floor.
    expect(storeSpy.mock.calls[0]?.[0]?.clock).toBe(clock);
    expect(logger.warnOnce).toHaveBeenCalledTimes(1); // the ALS probe misses in node → warned through OUR logger
  });

  it('defaults to the WinterCG fetch transport when none is injected', () => {
    // no transport → exercises the `?? fetchTransport` default. Not invoked (that would hit the network);
    // what is asserted is that a callable transport really got registered under the token, rather than the
    // container holding `undefined` and the first upload failing at runtime.
    const client = launchEdge('tok', { captureNetwork: false, carrier: {} });
    clients.push(client);
    expect(typeof client.getService(core.TransportToken)).toBe('function');
  });

  it('runs contributed service manifests (extension wiring) at launch', () => {
    const carrier = {}; // a fresh carrier so the manifest is isolated to this launch
    const ran = vi.fn();
    contributeServiceManifest(() => ran(), carrier);
    launchTracked('tok', baseOptions({ carrier }));
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('detects a global unhandledrejection (via globalTarget) and uploads a report', async () => {
    const transport = uploadTransport();
    const t = fakeTarget();
    const client = launchTracked('tok', baseOptions({ transport, globalTarget: t.target }));
    expect(t.count('unhandledrejection')).toBe(1); // the detection provider registered (detectCrashes on)
    t.emit('unhandledrejection', { reason: new Error('floating-edge') });
    await client.flush();
    expect(JSON.stringify(issueJson(transport))).toContain('floating-edge');
  });

  it('does not wire unhandledrejection detection when detectCrashes is false', async () => {
    const transport = uploadTransport();
    const t = fakeTarget();
    launchTracked('tok', baseOptions({ transport, globalTarget: t.target, detectCrashes: false }));
    expect(t.count('unhandledrejection')).toBe(0); // the controllingOption gate kept the provider inert
    t.emit('unhandledrejection', { reason: new Error('ignored') });
    await new Promise((r) => setTimeout(r, 0));
    expect(transport).not.toHaveBeenCalledWith(
      expect.stringContaining('/v2/issues'),
      expect.anything(),
    );
  });

  it('threads a non-default maxRecordingTime + maxDataSize into the capture store (s→ms, MB→bytes)', () => {
    // Spy on createMemoryCaptureStore (call through) to assert the resolved options reach it with the right unit
    // math — otherwise a `*1000` / `*1024*1024` slip, or ignoring the resolved value, would ship undetected.
    const spy = vi.spyOn(core, 'createMemoryCaptureStore');
    const client = launchEdge('tok', {
      transport: uploadTransport(),
      captureNetwork: false,
      scheduler: inertScheduler,
      maxRecordingTime: 30, // non-default seconds
      maxDataSize: 5, // non-default MB
    });
    clients.push(client);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      maxRecordingTimeMs: 30_000, // 30 s → ms
      maxDataSizeBytes: 5 * 1024 * 1024, // 5 MB → bytes
    });
  });

  it('is a per-isolate singleton — a repeat launch is ignored (and onError-warned)', () => {
    const onError = vi.fn();
    const first = launchTracked('tok', baseOptions({ onError }));
    const second = launchEdge('tok', baseOptions({ onError }));
    expect(second).toBe(first); // same client
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/more than once/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Wave 0.1a (docs/review/REMEDIATION-PLAN.md): supplying AsyncLocalStorage explicitly.
//
// The adversarial review proved on real workerd 1.20260722.1 that `globalThis.AsyncLocalStorage` does NOT
// exist on Cloudflare under ANY compatibility flag — it is reachable only as an export of
// `node:async_hooks` (docs/review/cloudflare.md SEV1 #3). The probe therefore always misses there, so
// per-request context is permanently degraded to the single-slot fallback and reports carry no
// contextId. The edge tier cannot import `node:async_hooks` itself without breaking the bundle for
// deployments that lack the flag, so the store must be INJECTABLE: the user imports AsyncLocalStorage in
// their own worker (where their compat flags apply) and hands it to launch().
describe('launchEdge — asyncLocalStorage injection', () => {
  it('uses an explicitly supplied store instead of probing the global', async () => {
    const seen: string[] = [];
    // A minimal run()-scoped store standing in for a real AsyncLocalStorage.
    let slot: unknown;
    const injected = {
      getStore: () => slot,
      run: <R>(store: unknown, fn: () => R): R => {
        const prev = slot;
        slot = store;
        seen.push('run');
        try {
          return fn();
        } finally {
          slot = prev;
        }
      },
    };
    const client = launchEdge('token', {
      asyncLocalStorage: injected,
    } as Parameters<typeof launchEdge>[1]);
    // The decisive assertion: running a context goes through OUR store, not the probed global.
    const store = resolveEdgeStore(client);
    expect(store).toBeDefined();
    store?.run({ contextId: 'c1' }, () => {
      expect(store?.getCurrent()?.contextId).toBe('c1');
    });
    expect(seen).toContain('run');
    await client.stop?.();
  });
});

// S4.5 (docs/design/cloudflare-tenant-isolation.md): the partitioned store must actually be WIRED IN.
//
// S1-S4 built the owner key, the partitioned store, the scoped drain and the DO stamping — but nothing
// selected the partitioned store, so the whole chain was inert. This is the switch.
describe('launchEdge — partitionCaptureByTenant', () => {
  it('keeps tenants apart in the capture store when enabled', async () => {
    const client = launchEdge('tok', {
      partitionCaptureByTenant: true,
      carrier: {},
    } as Parameters<typeof launchEdge>[1]);
    const store = client.getService(
      (await import('@bugsee/core')).CaptureStoreToken,
    ) as unknown as {
      add: (r: { type: string; timestamp: number; serialized: string; owner?: string }) => void;
      snapshot: (o?: { owner?: string }) => {
        stream: () => AsyncIterableIterator<{ serialized: string }>;
      };
    };
    store.add({ type: 'log', timestamp: 1, serialized: 'SECRET-A', owner: 'A' });
    store.add({ type: 'log', timestamp: 2, serialized: 'SECRET-B', owner: 'B' });
    const seen: string[] = [];
    for await (const r of store.snapshot({ owner: 'B' }).stream()) seen.push(r.serialized);
    expect(seen).toEqual(['SECRET-B']);
    await client.stop?.();
  });

  it('uses the plain single-tenant store by default (unchanged for Vercel Edge)', async () => {
    const client = launchEdge('tok', { carrier: {} } as Parameters<typeof launchEdge>[1]);
    const store = client.getService(
      (await import('@bugsee/core')).CaptureStoreToken,
    ) as unknown as { owners?: () => string[] };
    expect(store.owners).toBeUndefined(); // not a PartitionedCaptureStore
    await client.stop?.();
  });
});

// Fixes for the adversarial review of this session's changes (docs/review/session-changes-review.md).
describe('launchEdge — tenant partitioning bounds + diagnostics', () => {
  it('divides the byte budget across partitions instead of replicating it', async () => {
    // SEV1 #2: giving each partition the full maxDataSize put 9 x 10 MB against a 128 MB isolate
    // (measured 116 MB heap). The total must stay within maxDataSize however many tenants appear.
    const sizes: Array<number | undefined> = [];
    const core = await import('@bugsee/core');
    const spy = vi.spyOn(core, 'createMemoryCaptureStore').mockImplementation((o) => {
      sizes.push(o?.maxDataSizeBytes);
      return {
        add: () => {},
        tick: () => {},
        clear: () => {},
        snapshot: () => ({
          stream: async function* () {},
          drainAll: async () => new Map(),
          release: () => {},
        }),
      };
    });
    launchTracked('tok', baseOptions({ partitionCaptureByTenant: true, maxTenantPartitions: 3 }));
    // Force partitions to be created.
    const store = clients.at(-1)?.getService(core.CaptureStoreToken) as unknown as {
      add: (r: unknown) => void;
    };
    store.add({ type: 'log', timestamp: 1, serialized: 'x', owner: 'a' });
    store.add({ type: 'log', timestamp: 1, serialized: 'y', owner: 'b' });
    const perPartition = sizes.filter((n): n is number => n !== undefined);
    expect(perPartition.length).toBeGreaterThan(0);
    // 10 MB default / (3 + 1) partitions.
    const expected = Math.floor((10 * 1024 * 1024) / 4);
    for (const size of perPartition) expect(size).toBe(expected);
    // And the total across the maximum number of rings stays within the configured budget.
    expect(expected * 4).toBeLessThanOrEqual(10 * 1024 * 1024);
    spy.mockRestore();
  });

  it('reports through onError when an explicit captureStore silently disables isolation', () => {
    // SEV2 #6: the override wins over the switch, reinstating the cross-tenant leak with no diagnostic.
    const errors: unknown[] = [];
    const inert = {
      add: () => {},
      tick: () => {},
      clear: () => {},
      snapshot: () => ({
        stream: async function* () {},
        drainAll: async () => new Map(),
        release: () => {},
      }),
    };
    launchTracked(
      'tok',
      baseOptions({
        partitionCaptureByTenant: true,
        captureStore: inert as never,
        onError: (e) => errors.push(e),
      }),
    );
    // The whole message, not a fragment: a diagnostic is only useful if it names the OPTION that was
    // ignored, the CONSEQUENCE, and what to do instead — each of those lives in a different line of the
    // string, and asserting one of them leaves the rest free to be deleted.
    const message = String(errors[0]);
    expect(message).toContain('partitionCaptureByTenant was requested');
    expect(message).toContain('an explicit captureStore was supplied');
    expect(message).toContain('per-tenant isolation is NOT active');
    expect(message).toContain("upload another tenant's capture");
    expect(message).toContain('Omit captureStore, or partition it yourself');
  });
});

describe('launchEdge — reused non-partitioned client diagnostic', () => {
  it('names the isolation loss when a partitioning launch reuses a non-partitioned client', () => {
    // Review pass 2 SEV3 #3: `launchEdge(token)` runs first (it is re-exported by @bugsee/cloudflare),
    // then a Durable Object's lazy launcher reuses that carrier client — which does not partition. The
    // only signal was the generic "called more than once", which does not mention the leak.
    const carrier = {};
    const errors: unknown[] = [];
    launchTracked('tok', baseOptions({ carrier })); // first: NOT partitioned
    launchTracked(
      'tok',
      baseOptions({ carrier, partitionCaptureByTenant: true, onError: (e) => errors.push(e) }),
    );
    const message = errors.map(String).join('\n');
    expect(message).toContain('per-tenant isolation');
    expect(message).toContain('created a NON-partitioned client, which is reused');
    expect(message).toContain("another tenant's capture");
    // …and the remedy, which is the only part the reader can act on.
    expect(message).toContain('Launch via @bugsee/cloudflare first');
    expect(message).toContain('or do not call launchEdge directly');
  });

  it('stays quiet when the reused client DOES partition', () => {
    const carrier = {};
    const errors: unknown[] = [];
    launchTracked('tok', baseOptions({ carrier, partitionCaptureByTenant: true }));
    launchTracked(
      'tok',
      baseOptions({ carrier, partitionCaptureByTenant: true, onError: (e) => errors.push(e) }),
    );
    expect(errors.map(String).join('\n')).not.toContain('per-tenant isolation');
  });
});

describe('launchEdge — the partition bound and the budget divisor cannot disagree', () => {
  // Review pass 2-fixes SEV2 #1: the store coerced maxPartitions but launchEdge's divisor used the RAW
  // value, so `0` restored a full budget per partition (the 90 MB blow-up) and `NaN` produced a NaN budget
  // that disabled the byte cap outright. Both now route through the one exported coercion.
  const budgetsFor = async (maxTenantPartitions: unknown): Promise<number[]> => {
    const sizes: number[] = [];
    const core = await import('@bugsee/core');
    const spy = vi.spyOn(core, 'createMemoryCaptureStore').mockImplementation((o) => {
      if (o?.maxDataSizeBytes !== undefined) sizes.push(o.maxDataSizeBytes);
      return {
        add: () => {},
        tick: () => {},
        clear: () => {},
        snapshot: () => ({
          stream: async function* () {},
          drainAll: async () => new Map(),
          release: () => {},
        }),
      };
    });
    launchTracked(
      'tok',
      baseOptions({
        partitionCaptureByTenant: true,
        maxTenantPartitions: maxTenantPartitions as number,
      }),
    );
    const store = clients.at(-1)?.getService(core.CaptureStoreToken) as unknown as {
      add: (r: unknown) => void;
    };
    store.add({ type: 'log', timestamp: 1, serialized: 'x', owner: 'a' });
    spy.mockRestore();
    return sizes;
  };

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.7, 'eight']) {
    it(`derives a finite, bounded per-partition budget for ${String(bad)}`, async () => {
      const sizes = await budgetsFor(bad);
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) {
        expect(Number.isFinite(size)).toBe(true);
        expect(size).toBeGreaterThan(0);
        // Never the whole budget: that is the blow-up the division exists to prevent.
        expect(size).toBeLessThan(10 * 1024 * 1024);
      }
    });
  }
});

describe('launchEdge — the reuse diagnostic never breaks launch()', () => {
  it('survives an already-launched client whose getService throws', () => {
    // Launch a REAL client onto the carrier first, so getCarrierClient actually returns something and the
    // diagnostic path is genuinely entered — then make its getService hostile. An earlier version of this
    // test used a hand-built carrier shape that getCarrierClient never resolved, so it passed while
    // exercising nothing.
    const carrier = {};
    const first = launchTracked('tok', baseOptions({ carrier }));
    (first as unknown as { getService: () => unknown }).getService = () => {
      throw new Error('hostile');
    };
    const errors: unknown[] = [];
    expect(() =>
      launchEdge(
        'tok',
        baseOptions({ carrier, partitionCaptureByTenant: true, onError: (e) => errors.push(e) }),
      ),
    ).not.toThrow();
    // And it still warns — a store it cannot inspect is treated as "not partitioning", the safe direction.
    expect(errors.map(String).join('\n')).toContain('per-tenant isolation');
  });
});

// ---------------------------------------------------------------------------------------------------
// The collector coordinates: WHERE the SDK uploads and WHO it says it is.
//
// `endpoint`, `appToken` and `sdkVersion` are read once at launch and handed to `createBugseeApi`; nothing
// downstream re-derives them. Nothing asserted them either, so `?? DEFAULT` degrading to a constant, or the
// options object never reaching the API factory, was invisible: the SDK would keep working in tests while
// uploading a real deployment's incidents to the wrong host under the wrong identity.
describe('launchEdge — collector endpoint + SDK identity', () => {
  const controlPlaneUrls = (transport: ReturnType<typeof uploadTransport>): string[] =>
    transport.mock.calls.map(([url]) => url).filter((url) => !url.startsWith('https://s3.test'));

  const headersOf = (transport: ReturnType<typeof uploadTransport>, path: string) =>
    (
      transport.mock.calls.find(([url]) => url.endsWith(path))?.[1] as
        | HttpRequestOptions
        | undefined
    )?.headers;

  const upload = async (options: Partial<BugseeEdgeLaunchOptions>, token = 'tok') => {
    const transport = uploadTransport();
    const client = launchTracked(token, baseOptions({ transport, ...options }));
    await client.logException(new Error('x'));
    await client.flush();
    return transport;
  };

  it('posts to https://api.bugsee.com by default', async () => {
    const transport = await upload({});
    expect(controlPlaneUrls(transport).length).toBeGreaterThan(0);
    for (const url of controlPlaneUrls(transport)) {
      expect(url.startsWith('https://api.bugsee.com/')).toBe(true);
    }
    expect(controlPlaneUrls(transport)).toContain('https://api.bugsee.com/v2/sessions');
  });

  it('posts to an overridden endpoint — and NOT to the default', async () => {
    const transport = await upload({ endpoint: 'https://collector.acme.test' });
    expect(controlPlaneUrls(transport)).toContain('https://collector.acme.test/v2/sessions');
    for (const url of controlPlaneUrls(transport)) {
      expect(url.startsWith('https://api.bugsee.com')).toBe(false);
    }
  });

  it('authenticates with the app token passed to launch()', async () => {
    const transport = await upload({}, 'app-token-abc');
    expect(headersOf(transport, '/v2/sessions')?.['x-app-token']).toBe('app-token-abc');
  });

  it('identifies itself with the default SDK version, and with an override when given', async () => {
    const byDefault = await upload({});
    expect(headersOf(byDefault, '/v2/sessions')?.['user-agent']).toBe('BugseeJS/0.0.0');
    const overridden = await upload({ sdkVersion: '4.5.6', carrier: {} });
    expect(headersOf(overridden, '/v2/sessions')?.['user-agent']).toBe('BugseeJS/4.5.6');
    // …and the same version reaches the environment envelope, not just the header.
    expect(
      (issueJson(overridden).environment as unknown as { sdk: { version: string } }).sdk.version,
    ).toBe('4.5.6');
  });
});

// stop() must release the per-isolate carrier slot.
//
// The slot is what makes launch() a singleton, so a stop() that does not clear it leaves the isolate
// permanently holding a STOPPED client: every later launch() is ignored and returns the dead one, and the
// SDK is silently off for the rest of the isolate's life.
describe('launchEdge — stop() releases the isolate slot', () => {
  it('lets a later launch() start a FRESH client', async () => {
    const carrier = {};
    const onError = vi.fn();
    const first = launchEdge('tok', baseOptions({ carrier, onError }));
    await first.stop();
    const second = launchEdge('tok', baseOptions({ carrier, onError }));
    clients.push(second);
    expect(second).not.toBe(first); // a genuinely new client, not the stopped one handed back
    expect(onError).not.toHaveBeenCalled(); // and no "called more than once" — the slot was free
  });

  it('delegates to the underlying client.stop and reports its result', async () => {
    const client = launchEdge('tok', baseOptions({ carrier: {} }));
    await expect(client.stop()).resolves.toBe(true); // the core stop's value, not `undefined`
  });
});

// The diagnostics must never become the failure they are reporting.
//
// Every one of these warnings goes through `options.onError?.(…)`, and `onError` is an OPTIONAL launch
// option. Dropping the optional call turns each diagnostic into a TypeError thrown out of launch() — the
// SDK crashing the host application at startup, precisely on the paths that exist to warn about a
// misconfiguration.
describe('launchEdge — the diagnostics are safe without an onError sink', () => {
  it('a repeat launch without onError returns the first client instead of throwing', () => {
    const carrier = {};
    const first = launchTracked('tok', baseOptions({ carrier }));
    let second: ReturnType<typeof launchEdge> | undefined;
    expect(() => {
      second = launchEdge('tok', baseOptions({ carrier }));
    }).not.toThrow();
    expect(second).toBe(first);
  });

  it('the reused-non-partitioned-client warning without onError does not throw', () => {
    const carrier = {};
    launchTracked('tok', baseOptions({ carrier })); // first: NOT partitioned
    expect(() =>
      launchEdge('tok', baseOptions({ carrier, partitionCaptureByTenant: true })),
    ).not.toThrow();
  });

  it('the explicit-captureStore warning without onError does not throw', () => {
    const inert = {
      add: () => {},
      tick: () => {},
      clear: () => {},
      snapshot: () => ({
        stream: async function* () {},
        drainAll: async () => new Map(),
        release: () => {},
      }),
    };
    expect(() =>
      launchTracked(
        'tok',
        baseOptions({ partitionCaptureByTenant: true, captureStore: inert as never }),
      ),
    ).not.toThrow();
  });
});

// The explicit-captureStore warning fires on the CONJUNCTION, not on either half.
describe('launchEdge — the captureStore diagnostic is not over-eager', () => {
  const inertStore = () => ({
    add: () => {},
    tick: () => {},
    clear: () => {},
    snapshot: () => ({
      stream: async function* () {},
      drainAll: async () => new Map(),
      release: () => {},
    }),
  });

  it('stays quiet for an explicit captureStore when partitioning was NOT requested', () => {
    const errors: unknown[] = [];
    launchTracked(
      'tok',
      baseOptions({ captureStore: inertStore() as never, onError: (e) => errors.push(e) }),
    );
    // Supplying your own store is a supported, ordinary thing to do — warning about it every time would
    // train users to ignore the one message that reports a real cross-tenant leak.
    expect(errors.map(String).join('\n')).not.toContain('captureStore');
  });

  it('stays quiet for partitioning WITHOUT an explicit captureStore (the store we built does isolate)', () => {
    const errors: unknown[] = [];
    launchTracked(
      'tok',
      baseOptions({ partitionCaptureByTenant: true, onError: (e) => errors.push(e) }),
    );
    expect(errors.map(String).join('\n')).not.toContain('captureStore');
  });
});

// The injectable seams must actually be INJECTED.
//
// `clock`, `scheduler`, `onError` and `logger` are conditionally spread into the objects they configure. A
// spread that never fires leaves the SDK silently running on the real system clock, real global timers and
// no error sink — indistinguishable from a correct launch in any test that merely passes the option in and
// checks that launch() returned something. Each assertion below reads the value back out at its destination.
describe('launchEdge — injected seams reach their destination', () => {
  it('hands the injected clock to BOTH the capture store and the client', async () => {
    const clock = createSystemClock();
    const storeSpy = vi.spyOn(core, 'createMemoryCaptureStore');
    const clientSpy = vi.spyOn(core, 'createClient');
    launchTracked('tok', baseOptions({ clock }));
    expect(storeSpy.mock.calls[0]?.[0]?.clock).toBe(clock);
    expect(clientSpy.mock.calls[0]?.[0]?.clock).toBe(clock);
  });

  it('hands the injected scheduler and onError sink to the client', () => {
    const onError = vi.fn();
    const clientSpy = vi.spyOn(core, 'createClient');
    launchTracked('tok', baseOptions({ scheduler: inertScheduler, onError }));
    expect(clientSpy.mock.calls[0]?.[0]?.scheduler).toBe(inertScheduler);
    expect(clientSpy.mock.calls[0]?.[0]?.onError).toBe(onError);
  });

  it('omits the seams entirely when they are not supplied (core keeps its own defaults)', () => {
    const clientSpy = vi.spyOn(core, 'createClient');
    // No clock / scheduler / onError. Passing the keys as present-but-undefined would be a different
    // contract for anything that checks `in` — and `false ?` (never spreading) would be indistinguishable
    // from the injected case without the assertions above.
    clients.push(
      launchEdge('tok', { transport: uploadTransport(), captureNetwork: false, carrier: {} }),
    );
    const args = clientSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('clock' in args).toBe(false);
    expect('scheduler' in args).toBe(false);
    expect('onError' in args).toBe(false);
  });

  it('hands onError to the PARTITIONED store so a partition failure is reported, not swallowed', () => {
    const onError = vi.fn();
    const spy = vi.spyOn(core, 'createPartitionedCaptureStore');
    launchTracked('tok', baseOptions({ partitionCaptureByTenant: true, onError }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.onError).toBe(onError);
  });

  it('warns THROUGH the injected logger when AsyncLocalStorage cannot be probed', () => {
    // node has no `globalThis.AsyncLocalStorage`, so this is the degraded path — the same one every
    // Cloudflare deployment without `nodejs_compat` takes. If the logger never reaches the context store,
    // that degradation is completely silent and reports simply arrive with no contextId.
    const logger = { warnOnce: vi.fn() };
    launchTracked('tok', baseOptions({ logger }));
    expect(logger.warnOnce).toHaveBeenCalledTimes(1);
    const message = String(logger.warnOnce.mock.calls[0]?.[0]);
    // The message has to be actionable: what broke, what it costs, and the exact fix.
    expect(message).toContain('AsyncLocalStorage unavailable');
    expect(message).toContain('per-request context isolation');
    expect(message).toContain('asyncLocalStorage: new AsyncLocalStorage()');
    expect(message).toContain('node:async_hooks');
    expect(message).toContain('nodejs_compat');
    // The correction that took a real workerd investigation to establish (SEV1 #3) — losing it sends the
    // reader back to probing a global that will never be there.
    expect(message).toContain('NOT exist on workerd under any flag');
  });

  it('does NOT warn when a store was supplied explicitly', () => {
    const logger = { warnOnce: vi.fn() };
    let slot: unknown;
    launchTracked(
      'tok',
      baseOptions({
        logger,
        asyncLocalStorage: {
          getStore: () => slot as never,
          run: <R>(store: unknown, fn: () => R): R => {
            const prev = slot;
            slot = store;
            try {
              return fn();
            } finally {
              slot = prev;
            }
          },
        },
      }),
    );
    expect(logger.warnOnce).not.toHaveBeenCalled();
  });
});

// Network capture configuration.
describe('launchEdge — network capture wiring', () => {
  it('captures bodies by default, on the launch carrier, at the documented size limit', async () => {
    const capture = await import('@bugsee/capture');
    const spy = vi.spyOn(capture, 'installNetworkCapture');
    const carrier = {};
    launchTracked('tok', baseOptions({ carrier, captureNetwork: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual({
      carrier,
      captureBodies: true, // default ON — turning it off by default silently drops payload capture
      maxBodyBytes: 20480,
    });
  });

  it('threads captureNetworkBodies:false and a custom maxNetworkBodySize through', async () => {
    const capture = await import('@bugsee/capture');
    const spy = vi.spyOn(capture, 'installNetworkCapture');
    launchTracked(
      'tok',
      baseOptions({
        captureNetwork: true,
        captureNetworkBodies: false,
        maxNetworkBodySize: 4096,
      }),
    );
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ captureBodies: false, maxBodyBytes: 4096 });
  });

  it('REUSES a console interceptor already on the carrier rather than patching console twice', async () => {
    const capture = await import('@bugsee/capture');
    const carrier = {};
    const existing = capture.createConsoleInterceptor();
    getOrCreateInterceptor('console', () => existing, carrier);
    launchTracked('tok', baseOptions({ carrier }));
    // If launch had registered its interceptor under a DIFFERENT key, the 'console' slot would still hold
    // only ours — and a second copy of the console patch would be live. Probing a fresh key proves launch
    // did not create a slot of its own.
    const probe = capture.createConsoleInterceptor();
    expect(getOrCreateInterceptor('', () => probe, carrier)).toBe(probe);
    expect(getOrCreateInterceptor('console', () => probe, carrier)).toBe(existing);
  });
});

describe('EdgeContextStoreToken', () => {
  it('has a distinct, non-empty name — the container is keyed BY NAME', () => {
    // `serviceToken(name)` is just `{ name }`, and ServiceContainer stores/looks services up by that
    // string. An empty or duplicated name makes two unrelated contracts resolve to each other's service.
    expect(EdgeContextStoreToken.name).not.toBe('');
    expect(EdgeContextStoreToken.name).not.toBe(core.TransportToken.name);
    expect(EdgeContextStoreToken.name).not.toBe(core.CaptureStoreToken.name);
  });
});
