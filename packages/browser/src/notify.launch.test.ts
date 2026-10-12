// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// `notify()` (T7) end to end through the real browser composition root: it reaches the collector's
// POST /v2/notifications through the SAME transport as the session and issue calls, authenticated by the
// app token in the body (no session), and the friendly `notifyFlushDelay` option reaches the relay.

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
const transport = () =>
  vi.fn<HttpTransport>(async (url: string): Promise<HttpResponse> => {
    if (url.endsWith('/v2/notifications')) {
      return {
        status: 200,
        headers: {},
        body: json({ ok: true, result: { notifications: {} } }),
      };
    }
    return { status: 200, headers: {}, body: json({ access_token: 'access' }) };
  });

const clients: Bugsee[] = [];
const start = async (over: Partial<BugseeLaunchOptions> = {}, http = transport()) => {
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
  resetBrowserDeviceIdCache();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const notifications = (http: ReturnType<typeof transport>) =>
  http.mock.calls.filter(([url]) => url.endsWith('/v2/notifications')) as Array<
    [string, HttpRequestOptions]
  >;

describe('browser notify()', () => {
  it('POSTs the message to /v2/notifications with the app token, without opening a session', async () => {
    const { client, http } = await start();
    client.notify('Deploy finished', 'v1.2 is live', 'high', { env: 'prod' });
    await vi.waitFor(() => expect(notifications(http)).toHaveLength(1));

    const [url, options] = notifications(http)[0] as [string, HttpRequestOptions];
    expect(url).toMatch(/\/v2\/notifications$/);
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string) as {
      app_token: string;
      notifications: Array<Record<string, unknown>>;
    };
    expect(body.app_token).toBe('tok');
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      title: 'Deploy finished',
      body: 'v1.2 is live',
      severity: 3,
      fields: { env: 'prod' },
      delivery: 'immediate',
    });
    expect(body.notifications[0]?.environment).toMatchObject({ sdk: { type: 'javascript' } });
    const headers = options.headers as Record<string, string>;
    expect(headers['x-app-token']).toBe('tok');
    expect(headers['x-client-type']).toBe('javascript');
    expect(headers.authorization).toBeUndefined();
    expect(headers['user-agent']).toBeUndefined(); // a script-set UA turns the call into a preflight
    expect(http.mock.calls.some(([u]) => u.endsWith('/v2/sessions'))).toBe(false);
  });

  it('batches a burst into one request', async () => {
    const { client, http } = await start();
    client.notify('a');
    client.notify('b');
    await vi.waitFor(() => expect(notifications(http)).toHaveLength(1));
    const body = JSON.parse(notifications(http)[0]?.[1].body as string) as {
      notifications: unknown[];
    };
    expect(body.notifications).toHaveLength(2);
  });

  it('honours notifyFlushDelay: nothing leaves until flush() or the window ends', async () => {
    const { client, http } = await start({ notifyFlushDelay: 60_000 });
    client.notify('later');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifications(http)).toHaveLength(0);
    await client.flush();
    expect(notifications(http)).toHaveLength(1);
    const item = (
      JSON.parse(notifications(http)[0]?.[1].body as string) as {
        notifications: Array<{ delivery: string }>;
      }
    ).notifications[0];
    expect(item?.delivery).toBe('deferred');
  });

  it('sends the delay on the wire as the canonical option', async () => {
    const { client } = await start({ notifyFlushDelay: 250 });
    expect(client.getLaunchOptions()['com.bugsee.option.config.notify-flush-delay']).toBe(250);
  });

  it('does nothing before launch has finished or after stop()', async () => {
    const { client, http } = await start();
    await client.stop();
    client.notify('after stop');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifications(http)).toHaveLength(0);
  });
});
