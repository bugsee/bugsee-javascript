import type { HttpRequestOptions, HttpResponse, HttpTransport, Scheduler } from '@bugsee/core';
import { setCarrierClient } from '@bugsee/core';
import { type Bugsee, launchEdge } from '@bugsee/vercel-edge';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy on requestAttributes while keeping launchEdge/runInEdgeContext REAL (importActual), so we can assert
// the wrapper stamps the invocation context with the request's attributes (route attribution on the report).
const { requestAttributesSpy } = vi.hoisted(() => ({ requestAttributesSpy: vi.fn() }));
vi.mock('@bugsee/vercel-edge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/vercel-edge')>();
  requestAttributesSpy.mockImplementation(actual.requestAttributes);
  return { ...actual, requestAttributes: requestAttributesSpy };
});

import { withBugseeMiddleware } from './middleware';

// --- harness (real edge client with injected fetch transport + inert scheduler) ----------------

const jsonBody = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

function recordingTransport() {
  const calls: Array<{ url: string }> = [];
  const fn = vi.fn<HttpTransport>(async (url: string, _o: HttpRequestOptions = {}) => {
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

const inertScheduler: Scheduler = {
  setInterval: () => 0 as unknown as ReturnType<Scheduler['setInterval']>,
  clearInterval: () => {},
};

const started: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

function edgeClient(transport: HttpTransport, carrier: object | undefined = {}) {
  const client = launchEdge('tok', {
    transport,
    scheduler: inertScheduler,
    captureNetwork: false,
    ...(carrier !== undefined ? { carrier } : {}),
  });
  started.push(client);
  return client;
}

const fakeEvent = () => ({ waitUntil: vi.fn<(p: Promise<unknown>) => void>() });
const req = (url = 'https://app.test/dash?secret=1') =>
  ({ method: 'GET', url }) as unknown as Request;

// --- tests -------------------------------------------------------------------------------------

describe('withBugseeMiddleware', () => {
  it('runs the middleware inside an edge context, returns its result, defers the flush', async () => {
    const { fn } = recordingTransport();
    const client = edgeClient(fn);
    const response = { status: 200 } as unknown as Response;
    const mw = vi.fn(() => response);
    const event = fakeEvent();

    const wrapped = withBugseeMiddleware(mw, { getClient: () => client });
    const request = req();
    const result = await wrapped(request, event as never);

    expect(mw).toHaveBeenCalledWith(request, event); // the user's middleware ran with its real args
    expect(result).toBe(response); // its result is returned unchanged
    expect(event.waitUntil).toHaveBeenCalled(); // flush deferred via waitUntil → the context wrapper ran
    expect(requestAttributesSpy).toHaveBeenCalledWith(request); // the invocation context is stamped w/ route attrs
  });

  it('reports a thrown middleware error and rethrows it (the onRequestError gap)', async () => {
    const { fn, calls } = recordingTransport();
    const client = edgeClient(fn);
    const boom = new Error('middleware boom');
    const event = fakeEvent();

    const wrapped = withBugseeMiddleware(
      () => {
        throw boom;
      },
      { getClient: () => client },
    );

    await expect(wrapped(req(), event as never)).rejects.toBe(boom); // rethrown, not swallowed
    // The incident upload is deferred to waitUntil — await it, then assert the issue uploaded.
    await Promise.all(event.waitUntil.mock.calls.map((c) => c[0]));
    expect(calls.some((c) => c.url.endsWith('/v2/issues'))).toBe(true);
  });

  it('captures + rethrows an ASYNC middleware throw (the common real-world case)', async () => {
    const { fn, calls } = recordingTransport();
    const client = edgeClient(fn);
    const boom = new Error('async middleware boom');
    const event = fakeEvent();

    const wrapped = withBugseeMiddleware(
      async () => {
        await Promise.resolve();
        throw boom;
      },
      { getClient: () => client },
    );

    await expect(wrapped(req(), event as never)).rejects.toBe(boom);
    await Promise.all(event.waitUntil.mock.calls.map((c) => c[0]));
    expect(calls.some((c) => c.url.endsWith('/v2/issues'))).toBe(true);
  });

  it('passes an undefined (continue) return through unchanged, still opening the context', async () => {
    const { fn } = recordingTransport();
    const client = edgeClient(fn);
    const event = fakeEvent();

    const wrapped = withBugseeMiddleware(() => undefined, { getClient: () => client });
    const result = await wrapped(req(), event as never);

    expect(result).toBeUndefined(); // "continue to the route" is preserved
    expect(event.waitUntil).toHaveBeenCalled(); // the context still ran (correlated capture)
  });

  it('accepts a middleware pre-typed with a WIDER fetch event (type-level guard, R1 fix)', () => {
    // Compiles only because `Ev` is generic — mirrors the real Next NextFetchEvent (members beyond waitUntil).
    interface WiderFetchEvent {
      waitUntil(promise: Promise<unknown>): void;
      sourcePage: string;
      passThroughOnException(): void;
    }
    const preTyped = (_req: Request, _ev: WiderFetchEvent): Response | undefined => undefined;
    const wrapped = withBugseeMiddleware(preTyped); // must typecheck (tsc --noEmit): Ev = WiderFetchEvent
    expect(typeof wrapped).toBe('function');
  });

  it('passes through transparently when Bugsee is not launched (no context, no flush)', async () => {
    const response = { status: 200 } as unknown as Response;
    const mw = vi.fn(() => response);
    const event = fakeEvent();

    const wrapped = withBugseeMiddleware(mw, { getClient: () => undefined });
    const result = await wrapped(req(), event as never);

    expect(mw).toHaveBeenCalled();
    expect(result).toBe(response);
    expect(event.waitUntil).not.toHaveBeenCalled(); // no client → no context opened, no flush
  });

  it('defaults to the carrier client when no getClient is provided', async () => {
    const { fn } = recordingTransport();
    const client = edgeClient(fn);
    setCarrierClient(client); // seed the process-global carrier the default resolver reads
    const response = { status: 200 } as unknown as Response;
    const mw = vi.fn(() => response);
    const event = fakeEvent();

    const wrapped = withBugseeMiddleware(mw); // default resolver → getCarrierClient
    await wrapped(req(), event as never);

    expect(mw).toHaveBeenCalled();
    expect(event.waitUntil).toHaveBeenCalled(); // found the carrier client → ran the context
  });
});
