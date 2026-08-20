import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the edge SDK + the carrier accessor.
const { launchEdge, runInEdgeContext } = vi.hoisted(() => ({
  launchEdge: vi.fn(),
  // Invoke fn (the wrapped resolve) synchronously + return its result, like the real wrap would.
  runInEdgeContext: vi.fn((_client: unknown, _opts: unknown, fn: () => unknown) => fn()),
}));
vi.mock('@bugsee/vercel-edge', () => ({ launchEdge, runInEdgeContext }));
const { getCarrierClient } = vi.hoisted(() => ({ getCarrierClient: vi.fn() }));
// `ContextProviderToken` is a real value import in @bugsee/adapter-kit's trace read, which this suite
// deliberately runs UNMOCKED (the <meta> injection is an integration seam, not a stub).
vi.mock('@bugsee/core', () => ({
  getCarrierClient,
  ContextProviderToken: Symbol.for('bugsee.context-provider'),
}));

import { createEdgeHandle, registerServerEdge } from './edge';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const META = `<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-01">`;

/** A client whose ContextProvider exposes an active server trace (what the SSR <meta> is built from). */
const tracedClient = () =>
  ({
    getServiceProvider: () => ({
      getImmediate: () => ({
        getCurrent: () => ({
          contextId: 'c1',
          trace: { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true },
        }),
      }),
    }),
  }) as never;

function fakeResolve() {
  const resolve = vi.fn(
    (_event: unknown, opts?: { transformPageChunk?: (i: { html: string }) => string }) => ({
      body: 'response',
      opts,
    }),
  );
  return { resolve };
}

describe('registerServerEdge', () => {
  afterEach(() => {
    launchEdge.mockReset();
    getCarrierClient.mockReset();
  });

  it('launches the edge SDK with the appToken + options, returns the client', () => {
    const client = { id: 'edge' };
    launchEdge.mockReturnValue(client);
    const result = registerServerEdge('tok', { platformType: 'workers' });
    expect(launchEdge).toHaveBeenCalledWith('tok', { platformType: 'workers' });
    expect(result).toBe(client);
  });

  it('accepts a test launch seam (appToken + launch stripped)', () => {
    const client = { id: 'e' };
    const launch = vi.fn(() => client as never);
    expect(registerServerEdge('tok', { launch })).toBe(client);
    expect(launch).toHaveBeenCalledWith('tok', {});
    expect(launchEdge).not.toHaveBeenCalled();
  });
});

describe('createEdgeHandle', () => {
  afterEach(() => {
    runInEdgeContext.mockClear();
    getCarrierClient.mockReset();
  });

  it('runs resolve INSIDE runInEdgeContext with the ctx + attributes, returns its result', async () => {
    const client = { id: 'edge-client' };
    const { resolve } = fakeResolve();
    const cfCtx = { waitUntil: vi.fn() };
    const event = {
      request: { method: 'POST' },
      url: { pathname: '/x' },
      route: { id: '/[slug]' },
      platform: { context: cfCtx },
    };

    const result = await createEdgeHandle({ getClient: () => client as never })({ event, resolve });

    expect(runInEdgeContext).toHaveBeenCalledTimes(1);
    const [passedClient, opts] = runInEdgeContext.mock.calls[0] as [
      unknown,
      { ctx: unknown; attributes: unknown },
      unknown,
    ];
    expect(passedClient).toBe(client);
    expect(opts.ctx).toBe(cfCtx); // Cloudflare ExecutionContext from event.platform.context
    expect(opts.attributes).toEqual({
      'http.method': 'POST',
      'http.target': '/x',
      'http.route': '/[slug]',
    });
    expect(resolve).toHaveBeenCalledTimes(1); // the wrapped fn ran resolve
    expect(result).toMatchObject({ body: 'response' });
  });

  it('passes ctx undefined on Vercel Edge (no event.platform) → resolveWaitUntil global fallback', async () => {
    const { resolve } = fakeResolve();
    await createEdgeHandle({ getClient: () => ({ id: 'c' }) as never })({
      event: { request: { method: 'GET' } },
      resolve,
    });
    const opts = runInEdgeContext.mock.calls[0]?.[1] as { ctx: unknown };
    expect(opts.ctx).toBeUndefined();
  });

  it('wraps resolve with a trace transformPageChunk (a no-op without an active trace)', async () => {
    const { resolve } = fakeResolve();
    await createEdgeHandle({ getClient: () => ({ id: 'c' }) as never })({ event: {}, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;
    expect(typeof transform).toBe('function');
    // Invoke it: with no active trace (the fake client can't resolve one) it leaves the chunk unchanged.
    expect(transform({ html: '<head></head>' })).toBe('<head></head>');
  });

  it('degrades to a plain resolve (no edge context) when no client is launched', async () => {
    const { resolve } = fakeResolve();
    getCarrierClient.mockReturnValue(undefined); // default resolver, no client
    const result = await createEdgeHandle()({ event: {}, resolve });

    expect(runInEdgeContext).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ body: 'response' });
  });

  it('defaults to the carrier client', async () => {
    const client = { id: 'carrier' };
    getCarrierClient.mockReturnValue(client);
    const { resolve } = fakeResolve();
    await createEdgeHandle()({ event: {}, resolve });
    expect(runInEdgeContext.mock.calls[0]?.[0]).toBe(client);
  });

  it('injects the trace <meta> using the RESOLVED client, not the (absent) carrier one', async () => {
    // The FE↔BE join is the differentiator: `transformPageChunk` must read the trace through the SAME
    // client the handle resolved. On edge `getCarrierClient()` commonly returns nothing, so a dropped
    // getClient silently degrades to "no <meta>" — an omission no shape assertion can see.
    getCarrierClient.mockReturnValue(undefined);
    const client = tracedClient();
    const { resolve } = fakeResolve();
    await createEdgeHandle({ getClient: () => client })({ event: {}, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;
    expect(transform({ html: '<head></head>' })).toBe(`<head>${META}</head>`);
  });

  it('does not throw out of the hook when the app-supplied getClient throws', async () => {
    // `getClient` is APPLICATION code (a TDZ'd module binding, a lazy import, a throwing getter). A throw
    // here would 500 every SSR request — the SDK breaking the app it is meant to observe.
    const { resolve } = fakeResolve();
    const boom = () => {
      throw new Error('getClient exploded');
    };
    let result: unknown;
    expect(() => {
      result = createEdgeHandle({ getClient: boom })({ event: {}, resolve });
    }).not.toThrow();
    expect(resolve).toHaveBeenCalledTimes(1); // the request still resolved…
    expect(runInEdgeContext).not.toHaveBeenCalled(); // …just without a Bugsee context
    expect(result).toMatchObject({ body: 'response' });
  });

  it('still renders the page when the app-supplied getClient throws during transformPageChunk', async () => {
    const { resolve } = fakeResolve();
    createEdgeHandle({
      getClient: () => {
        throw new Error('boom');
      },
    })({ event: {}, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;
    expect(transform({ html: '<head></head>' })).toBe('<head></head>');
  });

  it('survives an event with no request / url / route (stamps no attributes)', async () => {
    const { resolve } = fakeResolve();
    await createEdgeHandle({ getClient: () => ({ id: 'c' }) as never })({ event: {}, resolve });
    const opts = runInEdgeContext.mock.calls[0]?.[1] as { attributes: object; ctx: unknown };
    expect(opts.attributes).toEqual({});
    expect(opts.ctx).toBeUndefined();
  });

  it('survives a null/undefined event entirely (no context probe throws)', async () => {
    for (const event of [null, undefined]) {
      runInEdgeContext.mockClear();
      const { resolve } = fakeResolve();
      const result = await createEdgeHandle({ getClient: () => ({ id: 'c' }) as never })({
        event,
        resolve,
      });
      const opts = runInEdgeContext.mock.calls[0]?.[1] as { attributes: object; ctx: unknown };
      expect(opts.attributes).toEqual({});
      expect(opts.ctx).toBeUndefined();
      expect(result).toMatchObject({ body: 'response' });
    }
  });

  it('omits http.route for an unmatched / blank route id', async () => {
    for (const id of [null, '']) {
      runInEdgeContext.mockClear();
      const { resolve } = fakeResolve();
      await createEdgeHandle({ getClient: () => ({ id: 'c' }) as never })({
        event: { route: { id }, request: { method: 'GET' } },
        resolve,
      });
      const opts = runInEdgeContext.mock.calls[0]?.[1] as { attributes: Record<string, unknown> };
      expect('http.route' in opts.attributes).toBe(false);
      expect(opts.attributes['http.method']).toBe('GET');
    }
  });
});
