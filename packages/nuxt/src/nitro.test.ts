import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBugseeNitro, type NitroAppLike } from './nitro';

/** A fake Nitro app that captures the registered `error` hook handler. */
function fakeNitro() {
  let errorHandler: ((error: unknown, context?: unknown) => void) | undefined;
  const nitroApp: NitroAppLike = {
    hooks: {
      hook(event, handler) {
        if (event === 'error') errorHandler = handler as typeof errorHandler;
      },
    },
  };
  return { nitroApp, fireError: (e: unknown, ctx?: unknown) => errorHandler?.(e, ctx) };
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
});
