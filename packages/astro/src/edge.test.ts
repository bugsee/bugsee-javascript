import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchEdge, runInEdgeContext } = vi.hoisted(() => ({
  launchEdge: vi.fn(),
  runInEdgeContext: vi.fn((_client: unknown, _opts: unknown, fn: () => unknown) => fn()),
}));
vi.mock('@bugsee/vercel-edge', () => ({ launchEdge, runInEdgeContext }));
const { getCarrierClient } = vi.hoisted(() => ({ getCarrierClient: vi.fn() }));
// Partial mock: keep the real @bugsee/core (so traceMetaTag's ContextProviderToken stays valid), override
// only getCarrierClient.
vi.mock('@bugsee/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bugsee/core')>()),
  getCarrierClient,
}));

import { createEdgeMiddleware, registerServerEdge } from './edge';

function req(over: { method?: string; url?: string } = {}) {
  return {
    request: new Request(over.url ?? 'https://x.test/p', { method: over.method ?? 'GET' }),
  };
}

describe('registerServerEdge', () => {
  afterEach(() => {
    launchEdge.mockReset();
    getCarrierClient.mockReset();
  });

  it('launches the edge SDK with the appToken + options, returns the client', () => {
    const client = { id: 'edge' };
    launchEdge.mockReturnValue(client);
    expect(registerServerEdge('tok', { platformType: 'workers' })).toBe(client);
    expect(launchEdge).toHaveBeenCalledWith('tok', { platformType: 'workers' });
  });

  it('accepts a test launch seam (appToken + launch stripped)', () => {
    const client = { id: 'e' };
    const launch = vi.fn(() => client as never);
    expect(registerServerEdge('tok', { launch })).toBe(client);
    expect(launch).toHaveBeenCalledWith('tok', {});
    expect(launchEdge).not.toHaveBeenCalled();
  });
});

describe('createEdgeMiddleware', () => {
  afterEach(() => {
    runInEdgeContext.mockClear();
    getCarrierClient.mockReset();
  });

  it('runs next() INSIDE runInEdgeContext with ctx + attributes, injects trace on success', async () => {
    const client = { id: 'c' };
    const cfCtx = { waitUntil: vi.fn() };
    const context = {
      ...req({ method: 'POST', url: 'https://x.test/api' }),
      locals: { runtime: { ctx: cfCtx } },
    };
    // An HTML response so the trace-injection path runs (reads the client); no active trace here → unchanged.
    const next = vi.fn(
      async () => new Response('<head></head>', { headers: { 'content-type': 'text/html' } }),
    );

    const res = await createEdgeMiddleware({ getClient: () => client as never })(context, next);

    expect(runInEdgeContext).toHaveBeenCalledTimes(1);
    const [passedClient, opts] = runInEdgeContext.mock.calls[0] as [
      unknown,
      { ctx: unknown; attributes: unknown },
      unknown,
    ];
    expect(passedClient).toBe(client);
    expect(opts.ctx).toBe(cfCtx); // Cloudflare ctx from locals.runtime.ctx
    expect(opts.attributes).toEqual({ 'http.method': 'POST', 'http.url': 'https://x.test/api' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe('<head></head>'); // no active trace → not rewritten
  });

  it('injects the trace <meta> into an HTML response on success (inside the edge context)', async () => {
    // A client that yields an active trace so the reused injectTraceIntoResponse actually splices.
    const tracing = {
      getServiceProvider: () => ({
        getImmediate: () => ({
          getCurrent: () => ({ trace: { traceId: 't', spanId: 's', sampled: true } }),
        }),
      }),
    };
    const next = vi.fn(
      async () => new Response('<head></head>', { headers: { 'content-type': 'text/html' } }),
    );
    const res = await createEdgeMiddleware({ getClient: () => tracing as never })(req(), next);
    expect(await res.text()).toBe('<head><meta name="traceparent" content="00-t-s-01"></head>');
  });

  // `toStrictEqual`, not `toEqual`: `{ 'http.method': undefined }` passes `toEqual({})` while still putting
  // an undefined-valued attribute onto the edge context — the span carries a key with no value.
  it.each([
    ['a request object with no method/url', { request: {} as Request }],
    ['no request at all', {}],
    // `locals` exists on EVERY Astro context; only the Cloudflare adapter fills in `locals.runtime`. On
    // Vercel Edge / node adapters the walk must stop at each missing level.
    ['locals with no runtime bag (any non-Cloudflare adapter)', { locals: {} }],
    ['a runtime bag with no ctx', { locals: { runtime: {} } }],
    ['a null context', null],
    ['an undefined context', undefined],
  ])('stamps NO attributes, and never throws, for %s (defensive)', async (_label, context) => {
    const next = vi.fn(async () => new Response('x'));
    await expect(
      createEdgeMiddleware({ getClient: () => ({ id: 'c' }) as never })(context as never, next),
    ).resolves.toBeDefined();
    expect(
      (runInEdgeContext.mock.calls[0]?.[1] as { attributes: unknown }).attributes,
    ).toStrictEqual({});
    expect((runInEdgeContext.mock.calls[0]?.[1] as { ctx: unknown }).ctx).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1); // the route still ran
  });

  it('redacts secrets in the request URL before they reach http.url (Wave 1.1)', async () => {
    // Astro hands us the FULL request URL, query included — unlike vercel-edge, which reduces it to a
    // pathname. So this is the one edge adapter where a `?token=` reaches the attribute intact.
    await createEdgeMiddleware({ getClient: () => ({ id: 'c' }) as never })(
      req({ url: 'https://x.test/cb?code=A&id_token=SECRET' }),
      vi.fn(async () => new Response('x')),
    );
    expect(
      (runInEdgeContext.mock.calls[0]?.[1] as { attributes: Record<string, string> }).attributes[
        'http.url'
      ],
    ).toBe('https://x.test/cb?code=A&id_token=%3Credacted%3E');
  });

  it('passes ctx undefined on Vercel Edge (no locals.runtime)', async () => {
    await createEdgeMiddleware({ getClient: () => ({ id: 'c' }) as never })(
      req(),
      vi.fn(async () => new Response('x')),
    );
    expect((runInEdgeContext.mock.calls[0]?.[1] as { ctx: unknown }).ctx).toBeUndefined();
  });

  it('degrades to a plain next() when no client is launched', async () => {
    getCarrierClient.mockReturnValue(undefined);
    const next = vi.fn(async () => new Response('x'));
    const res = await createEdgeMiddleware()(req(), next);
    expect(runInEdgeContext).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe('x');
  });

  it('defaults to the carrier client', async () => {
    const client = { id: 'carrier' };
    getCarrierClient.mockReturnValue(client);
    await createEdgeMiddleware()(
      req(),
      vi.fn(async () => new Response('x')),
    );
    expect(runInEdgeContext.mock.calls[0]?.[0]).toBe(client);
  });
});
