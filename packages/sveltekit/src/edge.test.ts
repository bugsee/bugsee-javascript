import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the edge SDK + the carrier accessor.
const { launchEdge, runInEdgeContext } = vi.hoisted(() => ({
  launchEdge: vi.fn(),
  // Invoke fn (the wrapped resolve) synchronously + return its result, like the real wrap would.
  runInEdgeContext: vi.fn((_client: unknown, _opts: unknown, fn: () => unknown) => fn()),
}));
vi.mock('@bugsee/vercel-edge', () => ({ launchEdge, runInEdgeContext }));
const { getCarrierClient } = vi.hoisted(() => ({ getCarrierClient: vi.fn() }));
vi.mock('@bugsee/core', () => ({ getCarrierClient }));

import { createEdgeHandle, registerServerEdge } from './edge';

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
});
