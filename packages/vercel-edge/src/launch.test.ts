import {
  contributeServiceManifest,
  createSystemClock,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  type Scheduler,
} from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('tags every SDK request with x-bugsee-internal (the network capture self-skips its own traffic)', async () => {
    const transport = uploadTransport();
    const client = launchTracked('tok', baseOptions({ transport }));
    await client.logException(new Error('x'));
    await client.flush();
    const put = findPut(transport);
    expect((put?.[1] as HttpRequestOptions).headers?.['x-bugsee-internal']).toBe('1');
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
    // no `scheduler` here → exercises the default-scheduler path; clock + logger → their injected branches.
    const client = launchEdge('tok', {
      transport: uploadTransport(),
      captureNetwork: false,
      clock: createSystemClock(),
      logger,
    });
    clients.push(client);
    await client.logException(new Error('x'));
    await client.flush();
    expect(client).toBeDefined();
  });

  it('defaults to the WinterCG fetch transport when none is injected', () => {
    // no transport → exercises the `?? fetchTransport` default (not exercised: it's only used on upload).
    const client = launchEdge('tok', { captureNetwork: false });
    clients.push(client);
    expect(client).toBeDefined();
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

  it('is a per-isolate singleton — a repeat launch is ignored (and onError-warned)', () => {
    const onError = vi.fn();
    const first = launchTracked('tok', baseOptions({ onError }));
    const second = launchEdge('tok', baseOptions({ onError }));
    expect(second).toBe(first); // same client
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/more than once/);
  });
});
