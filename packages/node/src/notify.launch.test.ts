import {
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';

// `notify()` (T7) end to end through the real Node composition root: POST /v2/notifications over the same
// transport as the session/issue calls, authenticated by the app token in the body.

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
const transport = () =>
  vi.fn<HttpTransport>(async (url: string, _options: HttpRequestOptions = {}) => {
    if (url.endsWith('/v2/notifications')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ ok: true, result: { notifications: {} } }),
      } satisfies HttpResponse;
    }
    return { status: 200, headers: {}, body: jsonBody({ access_token: 'access' }) };
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
  };
  return proc as unknown as NodeRuntime;
};

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const start = (over: Partial<BugseeLaunchOptions> = {}) => {
  const http = transport();
  const client = launch('tok', {
    process: fakeProcess(),
    transport: http,
    systemProbe: probe,
    systemMetricsSampler: () => [],
    captureNetwork: false,
    exitOnUncaught: false,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    ...over,
  });
  clients.push(client);
  return { client, http };
};

const notifications = (http: ReturnType<typeof transport>) =>
  http.mock.calls.filter(([url]) => url.endsWith('/v2/notifications')) as Array<
    [string, HttpRequestOptions]
  >;

describe('node notify()', () => {
  it('POSTs the message to /v2/notifications with the app token, without opening a session', async () => {
    const { client, http } = start();
    client.notify('Job failed', 'nightly export', 'critical', { job: 'export' }, true);
    await vi.waitFor(() => expect(notifications(http)).toHaveLength(1));

    const [url, options] = notifications(http)[0] as [string, HttpRequestOptions];
    expect(url).toMatch(/\/v2\/notifications$/);
    const body = JSON.parse(options.body as string) as {
      app_token: string;
      notifications: Array<Record<string, unknown>>;
    };
    expect(body.app_token).toBe('tok');
    expect(body.notifications[0]).toMatchObject({
      title: 'Job failed',
      body: 'nightly export',
      severity: 4,
      fields: { job: 'export' },
      urgent: true,
      delivery: 'immediate',
    });
    expect((options.headers as Record<string, string>)['x-app-token']).toBe('tok');
    expect(http.mock.calls.some(([u]) => u.endsWith('/v2/sessions'))).toBe(false);
  });

  it('honours notifyFlushDelay and delivers on stop()', async () => {
    const { client, http } = start({ notifyFlushDelay: 60_000 });
    client.notify('later');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifications(http)).toHaveLength(0);
    await client.stop();
    expect(notifications(http)).toHaveLength(1);
  });

  it('reports the delay among the launch options', () => {
    const { client } = start({ notifyFlushDelay: 250 });
    expect(client.getLaunchOptions()['com.bugsee.option.config.notify-flush-delay']).toBe(250);
  });
});
