import type { Clock, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { NodeRuntime, SystemProbe } from '@bugsee/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOnRequestError,
  type NextRequestErrorContext,
  type NextRequestErrorRequest,
  onRequestError,
} from './on-request-error';
import { registerServer } from './server';

// --- unit: the bridge over a fake client -------------------------------------------------------

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn(async () => ({ ok: true }) as const),
  };
}

const request: NextRequestErrorRequest = { path: '/api/users', method: 'POST', headers: {} };
const context: NextRequestErrorContext = {
  routerKind: 'App Router',
  routePath: '/api/users/[id]',
  routeType: 'route',
};

describe('createOnRequestError', () => {
  it('reports the error (http-error mechanism) and captures the route attribution', () => {
    const client = fakeClient();
    const bridge = createOnRequestError({ getClient: () => client as never });
    const err = new Error('boom');

    bridge(err, request, context);

    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'next.request-error',
      expect.objectContaining({
        routerKind: 'App Router',
        routePath: '/api/users/[id]',
        routeType: 'route',
        method: 'POST',
        path: '/api/users',
      }),
    );
  });

  it('includes renderSource when present', () => {
    const client = fakeClient();
    const bridge = createOnRequestError({ getClient: () => client as never });
    bridge(new Error('x'), request, {
      ...context,
      routeType: 'render',
      renderSource: 'react-server-components',
    });
    expect(client.event).toHaveBeenCalledWith(
      'next.request-error',
      expect.objectContaining({ renderSource: 'react-server-components' }),
    );
  });

  it('omits renderSource when absent', () => {
    const client = fakeClient();
    const bridge = createOnRequestError({ getClient: () => client as never });
    bridge(new Error('x'), request, context);
    const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('renderSource' in params).toBe(false);
  });

  it('is a no-op when no client is active (consults the resolver, does not throw)', () => {
    const getClient = vi.fn<() => undefined>(() => undefined);
    const bridge = createOnRequestError({ getClient });
    expect(() => bridge(new Error('x'), request, context)).not.toThrow();
    expect(getClient).toHaveBeenCalledTimes(1); // the resolver IS consulted; there is simply nothing to report
  });

  it('never throws out of the hook when the client throws', () => {
    const client = {
      event: vi.fn(() => {
        throw new Error('capture failed');
      }),
      logException: vi.fn(),
    };
    const bridge = createOnRequestError({ getClient: () => client as never });
    expect(() => bridge(new Error('x'), request, context)).not.toThrow();
  });

  it('defaults to the carrier client when no getClient is provided', () => {
    // With no launched client on the carrier, the default resolver returns undefined → safe no-op.
    expect(() => onRequestError(new Error('x'), request, context)).not.toThrow();
  });
});

// --- integration: the default onRequestError over a real launched client -----------------------

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
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};

const fixedClock: Clock = { wallNow: () => 5000, monotonicNow: () => 0 };

function recordingTransport() {
  const calls: Array<{ url: string }> = [];
  const fn = vi.fn<HttpTransport>(async (url: string, _opts: HttpRequestOptions = {}) => {
    calls.push({ url });
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

describe('onRequestError (default carrier binding)', () => {
  const started: Array<{ stop: () => Promise<boolean> }> = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((c) => c.stop()));
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('reports a Next server error against the launched client (issue uploads)', async () => {
    const { fn, calls } = recordingTransport();
    // Register on the GLOBAL carrier (no `carrier: {}`) so the default onRequestError → getCarrierClient()
    // finds it; the afterEach stops it and clears __BUGSEE__ for isolation.
    const client = registerServer('tok', {
      transport: fn,
      process: fakeProcess(),
      systemProbe: probe,
      captureNetwork: false,
      capturedDataStore: 'memory',
      clock: fixedClock,
      recover: false,
    });
    started.push(client);

    onRequestError(new Error('RSC blew up'), request, context);
    await client.flush();

    expect(calls.some((c) => c.url.endsWith('/v2/issues'))).toBe(true);
  });
});
