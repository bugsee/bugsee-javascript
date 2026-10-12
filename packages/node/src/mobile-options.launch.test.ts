import {
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';

// Mobile-parity launch options (T6), end to end through the real Node composition root: the friendly name
// resolves to the canonical key, reaches `sdk.options` on the wire, and changes what is uploaded.

const probe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => '20.1.2',
  osType: () => 'Linux',
  osPlatform: () => 'darwin',
  osRelease: () => '6.0',
  osArch: () => 'arm64',
  machine: () => 'x86_64',
  cpuCount: () => 8,
  totalMemory: () => 16_000,
  freeMemory: () => 4_000,
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};

const jsonBody = (obj: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(obj)));
const uploadTransport = () =>
  vi.fn<HttpTransport>(async (url: string, _options: HttpRequestOptions = {}) => {
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

const fakeProcess = (): NodeRuntime => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const proc = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return proc;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return proc;
    },
    listeners: (event: string) => [...(listeners.get(event) ?? [])],
    stderr: { write: () => true },
    exit: vi.fn(),
    kill: vi.fn(),
    pid: process.pid,
    fire: (event: string, ...args: unknown[]) => {
      for (const l of listeners.get(event) ?? []) {
        l(...args);
      }
    },
  };
  return proc as unknown as NodeRuntime;
};

const clients: ReturnType<typeof launch>[] = [];
const realFetch = globalThis.fetch;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const start = (over: Partial<BugseeLaunchOptions> = {}) => {
  const transport = uploadTransport();
  const proc = fakeProcess();
  const client = launch('tok', {
    process: proc,
    transport,
    systemProbe: probe,
    systemMetricsSampler: () => [],
    captureNetwork: false,
    exitOnUncaught: false,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    ...over,
  });
  clients.push(client);
  return {
    client,
    transport,
    proc: proc as unknown as { fire: (e: string, ...a: unknown[]) => void },
  };
};

const uploads = (transport: ReturnType<typeof uploadTransport>) =>
  transport.mock.calls
    .filter(([url]) => url === 'https://s3.test/put')
    .map(([, options]) => unzipSync((options as HttpRequestOptions).body as Uint8Array));
type Files = Record<string, Uint8Array>;
const requestOf = (files: Files) =>
  JSON.parse(strFromU8(files['request.json'] as Uint8Array)) as {
    severity: number;
    source: { type: string; mechanism?: string };
    summary?: string;
    environment: { sdk: { options: Record<string, unknown> } };
  };

describe('mobile-parity options reach sdk.options', () => {
  it('sends the defaults and the launched values dots-to-colons', async () => {
    const a = start();
    await a.client.upload({ summary: 'x' });
    expect(requestOf(uploads(a.transport)[0] as Files).environment.sdk.options).toMatchObject({
      'com:bugsee:option:capture:logs:level': 'verbose',
      'com:bugsee:option:capture:breadcrumbs': true,
      'com:bugsee:option:detect:http-errors': false,
      'com:bugsee:option:capture:network:default-sanitizer': true,
      'com:bugsee:option:reporting:defaults:crash-priority': 'blocker',
      'com:bugsee:option:reporting:defaults:error-priority': 'high',
    });
  });

  it('sends the values the app launched with', async () => {
    const b = start({
      captureLogsLevel: 'error',
      captureBreadcrumbs: false,
      detectHttpErrors: true,
      captureNetworkDefaultSanitizer: false,
      reportDefaultCrashPriority: 'critical',
      reportDefaultErrorPriority: 'low',
    });
    await b.client.upload({ summary: 'x' });
    expect(requestOf(uploads(b.transport)[0] as Files).environment.sdk.options).toMatchObject({
      'com:bugsee:option:capture:logs:level': 'error',
      'com:bugsee:option:capture:breadcrumbs': false,
      'com:bugsee:option:detect:http-errors': true,
      'com:bugsee:option:capture:network:default-sanitizer': false,
      'com:bugsee:option:reporting:defaults:crash-priority': 'critical',
      'com:bugsee:option:reporting:defaults:error-priority': 'low',
    });
  });
});

describe('captureBreadcrumbs / captureLogsLevel', () => {
  it('drops breadcrumbs when switched off and keeps them by default', async () => {
    const off = start({ captureBreadcrumbs: false });
    off.client.addBreadcrumb({ message: 'dropped' });
    await off.client.upload({ summary: 'x' });
    expect(Object.keys(uploads(off.transport)[0] as Files)).not.toContain('breadcrumbs');
  });

  it('keeps breadcrumbs by default', async () => {
    const on = start();
    on.client.addBreadcrumb({ message: 'kept' });
    await on.client.upload({ summary: 'x' });
    expect(Object.keys(uploads(on.transport)[0] as Files)).toContain('breadcrumbs');
  });

  it('captures console records at or above the level only', async () => {
    const { client, transport } = start({ captureLogsLevel: 'warning' });
    console.info('chatty-info-line');
    console.error('important-error-line');
    await client.upload({ summary: 'x' });
    const files = uploads(transport)[0] as Files;
    const logText = Object.entries(files)
      .filter(([name]) => name.startsWith('log'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');
    expect(logText).toContain('important-error-line');
    expect(logText).not.toContain('chatty-info-line');
  });
});

describe('captureLogs gates automatic capture, not explicit client.log()', () => {
  const logTextOf = (files: Files): string =>
    Object.entries(files)
      .filter(([name]) => name.startsWith('log'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');

  it('records client.log() lines and no console output with captureLogs off', async () => {
    const { client, transport } = start({ captureLogs: false });
    console.error('auto-captured-console-line');
    client.log('explicit-app-line', 'info');
    await client.upload({ summary: 'x' });
    const text = logTextOf(uploads(transport)[0] as Files);
    expect(text).toContain('explicit-app-line');
    expect(text).not.toContain('auto-captured-console-line');
  });

  it('with captureLogs off and nothing logged explicitly there is no log file', async () => {
    const { client, transport } = start({ captureLogs: false });
    console.error('auto-captured-console-line');
    await client.upload({ summary: 'x' });
    expect(Object.keys(uploads(transport)[0] as Files).some((n) => n.startsWith('log'))).toBe(
      false,
    );
  });
});

describe('reportDefault{Crash,Error}Priority', () => {
  it('gives a detected crash the configured severity (low = 1), and blocker (5) by default', async () => {
    const low = start({ reportDefaultCrashPriority: 'low' });
    low.proc.fire('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(uploads(low.transport)).toHaveLength(1));
    expect(requestOf(uploads(low.transport)[0] as Files).severity).toBe(1);
  });

  it('keeps blocker for a crash by default', async () => {
    const dflt = start();
    dflt.proc.fire('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(uploads(dflt.transport)).toHaveLength(1));
    expect(requestOf(uploads(dflt.transport)[0] as Files).severity).toBe(5);
  });

  it('gives logException the configured error severity; an explicit severity still wins', async () => {
    const { client, transport } = start({ reportDefaultErrorPriority: 'critical' });
    await client.logException(new Error('a'));
    await client.logException(new Error('b'), { severity: 'low' });
    expect(uploads(transport).map((f) => requestOf(f).severity)).toEqual([4, 1]);
  });
});

describe('detectHttpErrors', () => {
  const stubFetch = (status: number) => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status })) as typeof fetch;
  };

  it('reports a failed outbound fetch as an http-error error report, without the query string', async () => {
    stubFetch(502);
    const { client, transport } = start({ detectHttpErrors: true });
    await fetch('https://api.example.com/orders?token=SECRET');
    await client.flush(2000);
    const request = requestOf(uploads(transport)[0] as Files);
    expect(request.source).toMatchObject({ type: 'error', mechanism: 'http-error' });
    expect(request.summary).toBe('HTTP 502');
    expect(JSON.stringify(request)).not.toContain('SECRET');
  });

  it('does not report a 4xx (mobile parity: server errors only)', async () => {
    stubFetch(404);
    const { client, transport } = start({ detectHttpErrors: true });
    await fetch('https://api.example.com/orders');
    await client.flush(2000);
    expect(uploads(transport)).toHaveLength(0);
  });

  it('treats detectHttpErrors: undefined as not supplied (stays off)', async () => {
    stubFetch(502);
    const { client, transport } = start({ detectHttpErrors: undefined });
    await fetch('https://api.example.com/orders');
    await client.flush(2000);
    expect(uploads(transport)).toHaveLength(0);
  });

  it('is off by default', async () => {
    stubFetch(502);
    const { client, transport } = start();
    await fetch('https://api.example.com/orders');
    await client.flush(2000);
    expect(uploads(transport)).toHaveLength(0);
  });
});
