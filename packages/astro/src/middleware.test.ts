import { type BugseeClient, setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AstroMiddlewareContext,
  createBugseeMiddleware,
  injectTraceIntoResponse,
} from './middleware';

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn(async () => ({ ok: true }) as const),
    // getServiceProvider is read by traceMetaTag → return a provider yielding an active trace.
    getServiceProvider: vi.fn(() => ({
      getImmediate: () => ({
        getCurrent: () => ({
          contextId: 'c1',
          trace: { traceId: 't', spanId: 's', sampled: true },
        }),
      }),
    })),
  } as unknown as BugseeClient & {
    event: ReturnType<typeof vi.fn>;
    logException: ReturnType<typeof vi.fn>;
  };
}

function ctx(over: Partial<AstroMiddlewareContext> = {}): AstroMiddlewareContext {
  return {
    request: new Request('https://x.test/users/42?token=secret', { method: 'POST' }),
    ...over,
  };
}

const htmlResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

describe('createBugseeMiddleware — error capture', () => {
  afterEach(() => setCarrierClient(undefined));

  it('reports a thrown route error (method + query-stripped path), then RETHROWS', async () => {
    const client = fakeClient();
    const err = new Error('astro boom');
    const next = vi.fn(async () => {
      throw err;
    });
    const mw = createBugseeMiddleware({ getClient: () => client });

    await expect(mw(ctx(), next)).rejects.toBe(err); // rethrown so Astro renders its error page
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'astro.request-error',
      expect.objectContaining({ method: 'POST', path: '/users/42' }), // NO ?token=secret
    );
  });

  it('does not report on a successful response', async () => {
    const client = fakeClient();
    const next = vi.fn(async () => htmlResponse('<html><head></head><body>ok</body></html>'));
    await createBugseeMiddleware({ getClient: () => client })(ctx(), next);
    expect(client.logException).not.toHaveBeenCalled();
  });

  it('reports defensively (carrier client, unparseable url, no method → empty attribution)', async () => {
    const client = fakeClient();
    setCarrierClient(client); // exercises the no-getClient (carrier) path in the error branch
    const err = new Error('x');
    const badContext = { request: { url: 'not-a-url' } as unknown as Request };
    await expect(
      createBugseeMiddleware()(badContext, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith('astro.request-error', {}); // safePath caught, no method/path
  });
});

describe('createBugseeMiddleware — trace injection', () => {
  afterEach(() => setCarrierClient(undefined));

  it('splices the trace <meta> before </head> in an HTML response (drops the stale content-length)', async () => {
    const client = fakeClient();
    // The original carries a content-length; after the rewrite the body length changed, so it MUST be dropped.
    const next = vi.fn(
      async () =>
        new Response('<html><head><title>x</title></head><body>hi</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': '55' },
        }),
    );
    const res = await createBugseeMiddleware({ getClient: () => client })(ctx(), next);

    const body = await res.text();
    expect(body).toBe(
      '<html><head><title>x</title><meta name="traceparent" content="00-t-s-01"></head><body>hi</body></html>',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-length')).toBeNull(); // stale length dropped after rewrite
  });

  it('leaves a non-HTML response untouched (same object, body not consumed)', async () => {
    const client = fakeClient();
    const json = new Response('{"a":1}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await createBugseeMiddleware({ getClient: () => client })(
      ctx(),
      vi.fn(async () => json),
    );
    expect(res).toBe(json); // untouched
    expect(await res.text()).toBe('{"a":1}');
  });

  it('leaves a response with NO content-type header untouched (nullish content-type)', async () => {
    const client = fakeClient();
    const res = new Response(null, { status: 204 }); // no content-type
    const out = await createBugseeMiddleware({ getClient: () => client })(
      ctx(),
      vi.fn(async () => res),
    );
    expect(out).toBe(res);
  });

  it('leaves an HTML response untouched when no trace is active', async () => {
    const client = fakeClient();
    (client.getServiceProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      getImmediate: () => ({ getCurrent: () => undefined }),
    });
    const html = htmlResponse('<html><head></head></html>');
    const res = await createBugseeMiddleware({ getClient: () => client })(
      ctx(),
      vi.fn(async () => html),
    );
    expect(res).toBe(html); // not reconstructed — original returned
  });

  it('leaves an HTML response without </head> untouched even with a trace', async () => {
    const client = fakeClient();
    const html = htmlResponse('<div>no head</div>');
    const res = await createBugseeMiddleware({ getClient: () => client })(
      ctx(),
      vi.fn(async () => html),
    );
    expect(await res.text()).toBe('<div>no head</div>');
  });

  it('defaults to the carrier client', async () => {
    const client = fakeClient();
    setCarrierClient(client);
    const next = vi.fn(async () => htmlResponse('<head></head>'));
    const res = await createBugseeMiddleware()(ctx(), next);
    expect(await res.text()).toBe('<head><meta name="traceparent" content="00-t-s-01"></head>');
  });
});

// WAVE 4.5 — a cached page must not become a 500 because Bugsee is installed.
//
// `injectTraceIntoResponse` reconstructs the response to insert the trace <meta>. The fetch spec forbids a
// body on a NULL-BODY status (101/204/205/304), so `new Response('', { status: 304 })` throws TypeError —
// measured, not assumed. A 304 legally echoes the cached entity's `Content-Type: text/html`, so an ordinary
// conditional GET reached the reconstruct, threw out of the middleware, and Astro rendered its 500 page.
// The browser's cached-page path is about as hot as a route gets.
describe('null-body responses survive trace injection (Wave 4.5)', () => {
  // A client whose context provider reports an ACTIVE trace, so `traceMetaTag` really produces a tag.
  // Without this every case takes the `tag === ''` early return and the whole block passes vacuously —
  // which is exactly what my first fixture did, caught by the 200 canary below.
  const traced = {
    getClient: () => ({
      getServiceProvider: () => ({
        getImmediate: () => ({
          getCurrent: () => ({
            trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true },
          }),
        }),
      }),
    }),
  };

  it.each([204, 205, 304])('returns a %d untouched instead of throwing', async (status) => {
    const response = new Response(null, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const out = await injectTraceIntoResponse(response, traced as never);
    expect(out.status).toBe(status);
  });

  it('still injects into a 200 HTML response — the guard must not disable injection', async () => {
    const response = new Response('<html><head></head><body>hi</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const out = await injectTraceIntoResponse(response, traced as never);
    expect(await out.text()).toContain('<meta');
  });
});
