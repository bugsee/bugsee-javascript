import type { Clock, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { NodeRuntime, SystemProbe } from '@bugsee/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, registerServer } from './server';

const jsonBody = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

function fakeProcess(): NodeRuntime {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const proc: NodeRuntime = {
    on(event, listener) {
      (listeners.get(event) ?? listeners.set(event, []).get(event))?.push(listener);
      return proc;
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return proc;
    },
    exit: () => {},
  };
  return proc;
}

const probe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => '20.1.2',
  osType: () => 'Linux',
  osRelease: () => '6.0',
  machine: () => 'x86_64',
  cpuCount: () => 8,
  totalMemory: () => 16_000,
  freeMemory: () => 4_000,
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};
const fixedClock: Clock = { wallNow: () => 5000, monotonicNow: () => 0 };

function recordingTransport() {
  const calls: Array<{ url: string; options: HttpRequestOptions }> = [];
  const fn = vi.fn<HttpTransport>(async (url: string, options: HttpRequestOptions = {}) => {
    calls.push({ url, options });
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
  return { fn, calls };
}

const started: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

function register(appToken: string, transport: HttpTransport, extra: Record<string, unknown> = {}) {
  const client = registerServer(appToken, {
    transport,
    process: fakeProcess(),
    systemProbe: probe,
    captureNetwork: false,
    capturedDataStore: 'memory',
    clock: fixedClock,
    recover: false,
    carrier: {},
    ...extra,
  });
  started.push(client);
  return client;
}

describe('registerServer', () => {
  it('returns a started Bugsee client with the report surface', () => {
    const { fn } = recordingTransport();
    const client = register('tok', fn);
    expect(typeof client.logException).toBe('function');
    expect(typeof client.flush).toBe('function');
    expect(typeof client.stop).toBe('function');
  });

  it('forwards the appToken to the wire and uploads a reported exception', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('remix-token', fn);
    await client.logException(new Error('boom'));
    await client.flush();

    const session = calls.find((c) => c.url.endsWith('/v2/sessions'));
    expect(session?.options.headers?.['x-app-token']).toBe('remix-token');
    expect(calls.some((c) => c.url.endsWith('/v2/issues'))).toBe(true);
  });

  it('forwards launch options (endpoint) to the node composition', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('tok', fn, { endpoint: 'https://eu.test' });
    await client.logException(new Error('boom'));
    await client.flush();
    const apiCalls = calls.filter((c) => c.url.includes('/v2/'));
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const c of apiCalls) {
      expect(c.url.startsWith('https://eu.test/')).toBe(true);
    }
  });
});
