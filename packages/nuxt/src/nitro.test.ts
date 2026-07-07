import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub the shared kit's traceMetaTag so we control what render:html injects; keep reportServerError REAL
// (the error-path tests assert on the client directly through it).
const { traceMetaTag } = vi.hoisted(() => ({
  traceMetaTag: vi.fn<(options?: { getClient?: () => unknown }) => string>(() => ''),
}));
vi.mock('@bugsee/adapter-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bugsee/adapter-kit')>()),
  traceMetaTag,
}));

import { installBugseeNitro, type NitroAppLike, type NitroRenderHtmlContext } from './nitro';

/** A fake Nitro app that captures the registered `error` + `render:html` hook handlers. */
function fakeNitro() {
  let errorHandler: ((error: unknown, context?: unknown) => void) | undefined;
  let renderHandler: ((html: NitroRenderHtmlContext) => void) | undefined;
  const nitroApp: NitroAppLike = {
    hooks: {
      hook(event, handler) {
        if (event === 'error') errorHandler = handler as typeof errorHandler;
        if (event === 'render:html') renderHandler = handler as typeof renderHandler;
      },
    },
  };
  return {
    nitroApp,
    fireError: (e: unknown, ctx?: unknown) => errorHandler?.(e, ctx),
    hasRenderHook: () => renderHandler !== undefined,
    fireRender: (html: NitroRenderHtmlContext) => renderHandler?.(html),
  };
}

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn(async () => ({ ok: true }) as const),
  };
}

describe('installBugseeNitro', () => {
  afterEach(() => {
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
    traceMetaTag.mockReset();
    traceMetaTag.mockReturnValue('');
  });

  it('launches the node SDK with the appToken + forwarded options, returns the client', () => {
    const client = fakeClient();
    const launch = vi.fn(() => client as never);
    const { nitroApp } = fakeNitro();

    const result = installBugseeNitro(nitroApp, {
      appToken: 'tok',
      captureNetwork: false,
      launch,
    });

    expect(launch).toHaveBeenCalledWith('tok', { captureNetwork: false }); // appToken + launch opts, no appToken/launch leaked
    expect(result).toBe(client);
  });

  it('reports a server error (5xx / non-H3) via the Nitro error hook, with route attribution', () => {
    const client = fakeClient();
    const { nitroApp, fireError } = fakeNitro();
    installBugseeNitro(nitroApp, { appToken: 'tok', launch: () => client as never });

    const err = new Error('nitro boom');
    fireError(err, { event: { method: 'POST', path: '/api/x' }, tags: ['request'] });

    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'nuxt.request-error',
      expect.objectContaining({ method: 'POST', path: '/api/x', tags: ['request'] }),
    );
  });

  it('does NOT report an expected H3 client error (statusCode < 500, e.g. 404/422)', () => {
    const client = fakeClient();
    const { nitroApp, fireError } = fakeNitro();
    installBugseeNitro(nitroApp, { appToken: 'tok', launch: () => client as never });

    fireError({ statusCode: 404, message: 'Not Found' });
    fireError({ statusCode: 422, message: 'Unprocessable' });

    expect(client.logException).not.toHaveBeenCalled();
    expect(client.event).not.toHaveBeenCalled();
  });

  it('DOES report a 5xx H3 error (statusCode >= 500 is a real crash)', () => {
    const client = fakeClient();
    const { nitroApp, fireError } = fakeNitro();
    installBugseeNitro(nitroApp, { appToken: 'tok', launch: () => client as never });

    fireError({ statusCode: 500, message: 'boom' });
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('reports with minimal attribution when the error context is absent', () => {
    const client = fakeClient();
    const { nitroApp, fireError } = fakeNitro();
    installBugseeNitro(nitroApp, { appToken: 'tok', launch: () => client as never });

    fireError(new Error('x')); // no context
    const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params).toEqual({}); // no method/path/tags
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('injects the trace <meta> into the SSR <head> (render:html), reading the launched client', () => {
    const client = fakeClient();
    const { nitroApp, fireRender } = fakeNitro();
    traceMetaTag.mockReturnValue('<meta name="traceparent" content="00-t-s-01">');
    installBugseeNitro(nitroApp, { appToken: 'tok', launch: () => client as never });

    const html: NitroRenderHtmlContext = { head: ['<title>x</title>'] };
    fireRender(html);

    expect(html.head).toContain('<meta name="traceparent" content="00-t-s-01">');
    // reads the trace through the launched client (so the tag is THIS instance's active request trace)
    const getClient = traceMetaTag.mock.calls[0]?.[0]?.getClient;
    expect(getClient?.()).toBe(client);
  });

  it('injects NOTHING when no server trace is active (traceMetaTag → "")', () => {
    const { nitroApp, fireRender } = fakeNitro();
    traceMetaTag.mockReturnValue('');
    installBugseeNitro(nitroApp, { appToken: 'tok', launch: () => fakeClient() as never });

    const html: NitroRenderHtmlContext = { head: [] };
    fireRender(html);

    expect(html.head).toEqual([]); // no empty/garbage tag pushed
  });

  it('never breaks SSR rendering if the head injection throws (best-effort)', () => {
    const { nitroApp, fireRender } = fakeNitro();
    traceMetaTag.mockReturnValue('<meta name="traceparent" content="00-t-s-01">');
    installBugseeNitro(nitroApp, { appToken: 'tok', launch: () => fakeClient() as never });

    // A non-conformant host whose head.push throws must not break the render.
    const hostileHtml = {
      head: {
        push() {
          throw new Error('frozen head');
        },
      },
    } as unknown as NitroRenderHtmlContext;
    expect(() => fireRender(hostileHtml)).not.toThrow();
  });

  it('does NOT register the render:html hook when injectTraceMeta is false', () => {
    const { nitroApp, hasRenderHook } = fakeNitro();
    installBugseeNitro(nitroApp, {
      appToken: 'tok',
      injectTraceMeta: false,
      launch: () => fakeClient() as never,
    });
    expect(hasRenderHook()).toBe(false);
  });
});
