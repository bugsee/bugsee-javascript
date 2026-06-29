import type { WindowEvents } from '@bugsee/browser';
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
import { type BugseeWorkerLaunchOptions, launch } from './launch';

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

  it('is a per-worker singleton — a repeat launch is ignored (and onError-warned)', () => {
    const onError = vi.fn();
    const first = track('tok', baseOptions({ onError }));
    const second = launch('tok', baseOptions({ onError }));
    expect(second).toBe(first);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/more than once/);
  });
});
