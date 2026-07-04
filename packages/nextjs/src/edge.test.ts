import type { HttpRequestOptions, HttpResponse, HttpTransport, Scheduler } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, registerEdge } from './edge';

// --- harness (mirrors @bugsee/vercel-edge launch.test: fetch transport + inert scheduler) ------------

const jsonBody = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

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

// The capture-store tick is irrelevant to these assertions — never auto-fire.
const inertScheduler: Scheduler = {
  setInterval: () => 0 as unknown as ReturnType<Scheduler['setInterval']>,
  clearInterval: () => {},
};

const started: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

function register(appToken: string, transport: HttpTransport, extra: Record<string, unknown> = {}) {
  const client = registerEdge(appToken, {
    transport,
    scheduler: inertScheduler,
    captureNetwork: false, // don't patch the real fetch global in unit tests
    carrier: {},
    ...extra,
  });
  started.push(client);
  return client;
}

// --- tests -------------------------------------------------------------------------------------

describe('registerEdge', () => {
  it('returns a started edge client with the report surface', () => {
    const { fn } = recordingTransport();
    const client = register('tok', fn);
    expect(typeof client.logException).toBe('function');
    expect(typeof client.flush).toBe('function');
    expect(typeof client.stop).toBe('function');
  });

  it('forwards the appToken to the wire (x-app-token header)', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('my-edge-token', fn);
    await client.logException(new Error('edge boom'));
    await client.flush();
    const session = calls.find((c) => c.url.endsWith('/v2/sessions'));
    expect(session?.options.headers?.['x-app-token']).toBe('my-edge-token');
  });

  it('forwards launch options (endpoint) to the edge composition', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('tok', fn, { endpoint: 'https://edge.test' });
    await client.logException(new Error('edge boom'));
    await client.flush();
    const apiCalls = calls.filter((c) => c.url.includes('/v2/'));
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const c of apiCalls) {
      expect(c.url.startsWith('https://edge.test/')).toBe(true);
    }
  });

  it('uploads an issue for a reported exception (the edge composition captures)', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('tok', fn);
    await client.logException(new Error('edge boom'));
    await client.flush();
    expect(calls.some((c) => c.url.endsWith('/v2/issues'))).toBe(true);
  });
});
