// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// Mobile-parity launch options (T6), end to end through the real browser composition root: the friendly
// name resolves to the canonical key, reaches `sdk.options` on the wire, and changes what the uploaded
// bundle contains.

const probe: BrowserProbe = {
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

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const transport = (): ReturnType<typeof vi.fn<HttpTransport>> =>
  vi.fn<HttpTransport>(async (url: string): Promise<HttpResponse> => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: json({ access_token: 'access' }) };
    }
    if (url.endsWith('/v2/issues')) {
      return {
        status: 200,
        headers: {},
        body: json({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
      };
    }
    return { status: 200, headers: {}, body: new Uint8Array() };
  });

const clients: Bugsee[] = [];
const realFetch = globalThis.fetch;
const start = async (over: Partial<BugseeLaunchOptions> = {}) => {
  const http = transport();
  const client = await launch('tok', {
    window,
    document,
    transport: http,
    systemProbe: probe,
    systemMetricsSampler: () => [],
    captureNetwork: false,
    replay: false,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    deviceIdEnv: {
      localStorage: {
        getItem: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
        setItem() {},
        removeItem() {},
      },
      randomUUID: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
    },
    ...over,
  });
  clients.push(client);
  return { client, http };
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  globalThis.fetch = realFetch;
  resetBrowserDeviceIdCache();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const uploads = (http: ReturnType<typeof transport>) =>
  http.mock.calls
    .filter(([url]) => url === 'https://s3.test/put')
    .map(([, options]) => unzipSync((options as HttpRequestOptions).body as Uint8Array));
const read = (files: Record<string, Uint8Array>, name: string): unknown =>
  files[name] === undefined ? undefined : JSON.parse(strFromU8(files[name]));
const requestOf = (files: Record<string, Uint8Array>) =>
  read(files, 'request.json') as {
    severity: number;
    source: { type: string; mechanism?: string };
    summary?: string;
    environment: { sdk: { options: Record<string, unknown> } };
  };
const fileNames = (files: Record<string, Uint8Array>) => Object.keys(files);

describe('mobile-parity options reach sdk.options', () => {
  it('sends the defaults dots-to-colons', async () => {
    const { client, http } = await start();
    await client.upload({ summary: 'x' });
    const options = requestOf(uploads(http)[0] as Record<string, Uint8Array>).environment.sdk
      .options;
    expect(options).toMatchObject({
      'com:bugsee:option:capture:logs:level': 'verbose',
      'com:bugsee:option:capture:breadcrumbs': true,
      'com:bugsee:option:detect:http-errors': false,
      'com:bugsee:option:capture:network:default-sanitizer': true,
      'com:bugsee:option:reporting:defaults:crash-priority': 'blocker',
      'com:bugsee:option:reporting:defaults:error-priority': 'high',
    });
  });

  it('sends the values the app launched with', async () => {
    const { client, http } = await start({
      captureLogsLevel: 'warning',
      captureBreadcrumbs: false,
      detectHttpErrors: true,
      captureNetworkDefaultSanitizer: false,
      reportDefaultCrashPriority: 'critical',
      reportDefaultErrorPriority: 'low',
    });
    await client.upload({ summary: 'x' });
    const options = requestOf(uploads(http)[0] as Record<string, Uint8Array>).environment.sdk
      .options;
    expect(options).toMatchObject({
      'com:bugsee:option:capture:logs:level': 'warning',
      'com:bugsee:option:capture:breadcrumbs': false,
      'com:bugsee:option:detect:http-errors': true,
      'com:bugsee:option:capture:network:default-sanitizer': false,
      'com:bugsee:option:reporting:defaults:crash-priority': 'critical',
      'com:bugsee:option:reporting:defaults:error-priority': 'low',
    });
  });
});

describe('captureBreadcrumbs', () => {
  it('records breadcrumbs by default', async () => {
    const { client, http } = await start();
    client.addBreadcrumb({ message: 'kept' });
    await client.upload({ summary: 'x' });
    expect(fileNames(uploads(http)[0] as Record<string, Uint8Array>)).toContain('breadcrumbs');
  });

  it('records none when switched off', async () => {
    const { client, http } = await start({ captureBreadcrumbs: false });
    client.addBreadcrumb({ message: 'dropped' });
    await client.upload({ summary: 'x' });
    expect(fileNames(uploads(http)[0] as Record<string, Uint8Array>)).not.toContain('breadcrumbs');
  });
});

describe('captureLogsLevel', () => {
  it('captures console records at or above the level only', async () => {
    const { client, http } = await start({ captureLogsLevel: 'warning' });
    console.info('chatty-info-line');
    console.error('important-error-line');
    await client.upload({ summary: 'x' });
    const files = uploads(http)[0] as Record<string, Uint8Array>;
    const logText = Object.entries(files)
      .filter(([name]) => name.startsWith('log'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');
    expect(logText).toContain('important-error-line');
    expect(logText).not.toContain('chatty-info-line');
  });
});

describe('reportDefault{Crash,Error}Priority', () => {
  const fireWindowError = () =>
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));

  it('gives a detected crash the configured severity', async () => {
    const { client, http } = await start({ reportDefaultCrashPriority: 'low' });
    fireWindowError();
    await client.flush(2000);
    expect(requestOf(uploads(http)[0] as Record<string, Uint8Array>).severity).toBe(1); // low
  });

  it('keeps blocker for a crash by default', async () => {
    const { client, http } = await start();
    fireWindowError();
    await client.flush(2000);
    expect(requestOf(uploads(http)[0] as Record<string, Uint8Array>).severity).toBe(5);
  });

  it('gives logException the configured error severity, and an explicit severity still wins', async () => {
    const { client, http } = await start({ reportDefaultErrorPriority: 'critical' });
    await client.logException(new Error('a'));
    await client.logException(new Error('b'), { severity: 'low' });
    const [first, second] = uploads(http).map((f) => requestOf(f).severity);
    expect([first, second]).toEqual([4, 1]); // critical, then the explicit low
  });
});

describe('detectHttpErrors', () => {
  const stubFetch = (status: number) => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status })) as typeof fetch;
  };

  it('reports a failed fetch as an http-error error report', async () => {
    stubFetch(503);
    const { client, http } = await start({ detectHttpErrors: true });
    await fetch('https://api.example.com/orders?token=SECRET');
    await client.flush(2000);
    const request = requestOf(uploads(http)[0] as Record<string, Uint8Array>);
    expect(request.source).toMatchObject({ type: 'error', mechanism: 'http-error' });
    expect(request.summary).toBe('HTTP 503 GET https://api.example.com/orders');
    expect(JSON.stringify(request)).not.toContain('SECRET');
  });

  it('is off by default: a failed fetch files nothing', async () => {
    stubFetch(503);
    const { client, http } = await start();
    await fetch('https://api.example.com/orders');
    await client.flush(2000);
    expect(uploads(http)).toHaveLength(0);
  });

  it('does not report a successful fetch', async () => {
    stubFetch(200);
    const { client, http } = await start({ detectHttpErrors: true });
    await fetch('https://api.example.com/orders');
    await client.flush(2000);
    expect(uploads(http)).toHaveLength(0);
  });
});

describe('captureNetworkDefaultSanitizer', () => {
  const networkText = async (over: Partial<BugseeLaunchOptions>) => {
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as typeof fetch;
    const { client, http } = await start({ captureNetwork: true, ...over });
    await fetch('https://api.example.com/orders?token=SECRETVALUE');
    await client.upload({ summary: 'x' });
    const files = uploads(http)[0] as Record<string, Uint8Array>;
    return Object.entries(files)
      .filter(([name]) => name.startsWith('network'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');
  };

  it('redacts secrets in captured URLs by default', async () => {
    const text = await networkText({});
    expect(text).toContain('api.example.com/orders');
    expect(text).not.toContain('SECRETVALUE');
  });

  it('launch(token, { captureNetworkDefaultSanitizer: false }) leaves them raw', async () => {
    expect(await networkText({ captureNetworkDefaultSanitizer: false })).toContain('SECRETVALUE');
  });
});
