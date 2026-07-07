import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the edge SDK: control the launched client + capture the promise handed to waitUntil.
const { launchEdge, resolveWaitUntil } = vi.hoisted(() => ({
  launchEdge: vi.fn(),
  resolveWaitUntil: vi.fn(),
}));
vi.mock('@bugsee/vercel-edge', () => ({ launchEdge, resolveWaitUntil }));

import {
  type EdgeNitroAppLike,
  type EdgeNitroErrorContext,
  installBugseeNitroEdge,
} from './nitro-edge';

function fakeNitro() {
  let errorHandler: ((error: unknown, context?: EdgeNitroErrorContext) => void) | undefined;
  const nitroApp: EdgeNitroAppLike = {
    hooks: {
      hook(event, handler) {
        if (event === 'error') errorHandler = handler;
      },
    },
  };
  return {
    nitroApp,
    fireError: (e: unknown, ctx?: EdgeNitroErrorContext) => errorHandler?.(e, ctx),
  };
}

function fakeClient() {
  return {
    logException: vi.fn(async () => ({ ok: true }) as const),
    flush: vi.fn(async () => {}),
  };
}

/** Capture the promise passed to the (mocked) waitUntil, so a test can await the incident work. */
function captureWaitUntil() {
  let captured: Promise<unknown> | undefined;
  const waitUntil = vi.fn((p: Promise<unknown>) => {
    captured = p;
  });
  resolveWaitUntil.mockReturnValue(waitUntil);
  return { waitUntil, drain: () => captured };
}

describe('installBugseeNitroEdge', () => {
  afterEach(() => {
    launchEdge.mockReset();
    resolveWaitUntil.mockReset();
  });

  it('launches the edge SDK with the appToken + forwarded options, returns the client', () => {
    const client = fakeClient();
    const launch = vi.fn(() => client as never);
    const { nitroApp } = fakeNitro();

    const result = installBugseeNitroEdge(nitroApp, {
      appToken: 'tok',
      platformType: 'workers',
      launch,
    });

    expect(launch).toHaveBeenCalledWith('tok', { platformType: 'workers' }); // appToken/launch stripped
    expect(result).toBe(client);
  });

  it('reports a 5xx error via logException + flush, held past the Response by waitUntil', async () => {
    const client = fakeClient();
    const { nitroApp, fireError } = fakeNitro();
    const wu = captureWaitUntil();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', launch: () => client as never });

    const err = new Error('edge boom');
    fireError(err);

    expect(wu.waitUntil).toHaveBeenCalledTimes(1);
    await wu.drain(); // run the incident work the isolate was kept alive for
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.flush).toHaveBeenCalledTimes(1);
  });

  it('resolves waitUntil from the Cloudflare ExecutionContext on the event', () => {
    const { nitroApp, fireError } = fakeNitro();
    captureWaitUntil();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', launch: () => fakeClient() as never });

    const cfCtx = { waitUntil: vi.fn() };
    fireError(new Error('x'), { event: { context: { cloudflare: { context: cfCtx } } } });

    expect(resolveWaitUntil).toHaveBeenCalledWith(cfCtx); // Cloudflare path
  });

  it('resolves waitUntil with no ctx on Vercel Edge (falls back to the global symbol)', () => {
    const { nitroApp, fireError } = fakeNitro();
    captureWaitUntil();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', launch: () => fakeClient() as never });

    fireError(new Error('x')); // no cloudflare on the event
    expect(resolveWaitUntil).toHaveBeenCalledWith(undefined);
  });

  it('does NOT report an expected H3 client error (statusCode < 500)', () => {
    const client = fakeClient();
    const { nitroApp, fireError } = fakeNitro();
    captureWaitUntil();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', launch: () => client as never });

    fireError({ statusCode: 404, message: 'Not Found' });

    expect(resolveWaitUntil).not.toHaveBeenCalled();
    expect(client.logException).not.toHaveBeenCalled();
  });

  it('DOES report a 5xx H3 error (statusCode >= 500 is a real crash)', async () => {
    const client = fakeClient();
    const { nitroApp, fireError } = fakeNitro();
    const wu = captureWaitUntil();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', launch: () => client as never });

    fireError({ statusCode: 500, message: 'boom' }); // exercises the < 500 boundary (500 is NOT skipped)

    expect(wu.waitUntil).toHaveBeenCalledTimes(1);
    await wu.drain();
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('is best-effort — a failing logException never breaks the edge response', async () => {
    const client = fakeClient();
    client.logException.mockRejectedValueOnce(new Error('report failed'));
    const { nitroApp, fireError } = fakeNitro();
    const wu = captureWaitUntil();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', launch: () => client as never });

    fireError(new Error('boom'));
    await expect(wu.drain()).resolves.toBeUndefined(); // the incident promise swallows the failure
  });
});
