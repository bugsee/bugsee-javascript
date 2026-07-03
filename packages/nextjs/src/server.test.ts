import {
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import type { NodeRuntime } from '@bugsee/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServer } from './server';

// --- harness -----------------------------------------------------------------------------------

/** JSON body as bytes (mirrors the node launch-test harness). */
function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A fake NodeRuntime (process lifecycle) — records nothing but a working on/off/exit surface. */
function fakeProcess() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const proc: NodeRuntime = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return proc;
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return proc;
    },
    exit: vi.fn(),
  };
  return proc;
}

/** A transport that satisfies the session→issue→S3 upload handshake and records every request. */
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

const started: Array<{ stop: (timeout?: number) => Promise<boolean> }> = [];
afterEach(async () => {
  for (const c of started.splice(0)) {
    await c.stop();
  }
});

/** Launch through registerServer with the injected fakes + memory capture (no disk in unit tests).
 * A fresh `carrier: {}` per call makes each test's launch hermetic (isolation does not rely on the
 * afterEach `stop()` clearing the shared process-global carrier — a failed teardown can't leak a
 * client into the next test). Pass a shared `carrier` via `extra` to exercise the singleton. */
function register(appToken: string, transport: HttpTransport, extra: Record<string, unknown> = {}) {
  const client = registerServer(appToken, {
    transport,
    process: fakeProcess(),
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    recover: false,
    carrier: {},
    ...extra,
  });
  started.push(client);
  return client;
}

// --- tests -------------------------------------------------------------------------------------

describe('registerServer', () => {
  it('returns a started Bugsee client with the report surface', () => {
    const { fn } = recordingTransport();
    const client = register('tok', fn);
    expect(typeof client.logException).toBe('function');
    expect(typeof client.flush).toBe('function');
    expect(typeof client.stop).toBe('function');
  });

  it('forwards the appToken to the wire (x-app-token header + session app_token)', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('my-app-token', fn);
    await client.logException(new Error('boom'));
    await client.flush();

    // The session handshake carries the app token both as a header and in the body.
    const session = calls.find((c) => c.url.endsWith('/v2/sessions'));
    expect(session).toBeDefined();
    expect(session?.options.headers?.['x-app-token']).toBe('my-app-token');
    const raw = session?.options.body;
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
    const body = JSON.parse(text);
    expect(body.app_token).toBe('my-app-token');
  });

  it('forwards launch options (endpoint) to the node composition', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('tok', fn, { endpoint: 'https://custom.test' });
    await client.logException(new Error('boom'));
    await client.flush();

    // Every Bugsee-API request must target the forwarded endpoint (proves options pass-through).
    const apiCalls = calls.filter((c) => c.url.includes('/v2/'));
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const c of apiCalls) {
      expect(c.url.startsWith('https://custom.test/')).toBe(true);
    }
  });

  it('uploads an issue for a reported exception (the composition actually captures)', async () => {
    const { fn, calls } = recordingTransport();
    const client = register('tok', fn);
    await client.logException(new Error('boom'));
    await client.flush();
    expect(calls.some((c) => c.url.endsWith('/v2/issues'))).toBe(true);
  });

  it('is a per-process singleton — a repeat call returns the existing client (dev HMR)', () => {
    // Next re-runs register() on dev HMR; the composition must not build a second client. A SHARED
    // carrier stands in for the process-global that a real repeat register() would share.
    const { fn } = recordingTransport();
    const carrier = {};
    const onError = vi.fn();
    const first = register('tok', fn, { carrier, onError });
    const second = registerServer('tok', {
      transport: fn,
      process: fakeProcess(),
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      recover: false,
      carrier,
      onError,
    });

    expect(second).toBe(first); // same instance — no second client built
    // The ignored repeat is surfaced via onError (not silently dropped).
    const warned = onError.mock.calls.some(
      ([e]) => e instanceof Error && /more than once/.test(e.message),
    );
    expect(warned).toBe(true);
  });
});
