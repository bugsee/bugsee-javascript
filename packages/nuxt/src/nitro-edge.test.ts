import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the edge SDK: control the launched client + capture the promise handed to waitUntil.
const { launchEdge, resolveWaitUntil } = vi.hoisted(() => ({
  launchEdge: vi.fn(),
  resolveWaitUntil: vi.fn(),
}));
vi.mock('@bugsee/vercel-edge', () => ({
  launchEdge,
  resolveWaitUntil,
  DEFERRED_FLUSH_TIMEOUT_MS: 10_000, // the real value; this module shares the edge tier's deadline
}));

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

  // The ExecutionContext lives five levels deep in a structure Nitro owns, and which level exists depends on
  // the preset AND the Nitro version. Every partial shape must degrade to "no ctx" — a throw here happens
  // inside Nitro's own error handling, i.e. Bugsee replacing the app's error with its own.
  it.each([
    ['an empty context', {}],
    ['no event', { tags: ['request'] }],
    ['an event with no context bag', { event: { path: '/p' } }],
    ['an event context with no cloudflare', { event: { context: {} } }],
    ['a cloudflare bag with no ctx', { event: { context: { cloudflare: {} } } }],
  ])('degrades to no ctx (and never throws) for %s', (_label, context) => {
    const { nitroApp, fireError } = fakeNitro();
    captureWaitUntil();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', launch: () => fakeClient() as never });

    expect(() => fireError(new Error('x'), context as never)).not.toThrow();
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

describe('installBugseeNitroEdge — the flush deadline', () => {
  it('BOUNDS the flush, so a stuck upload cannot outlive the platform budget', async () => {
    // Held past the Response by waitUntil, which is finite: a bundle's retry ladder is 10s + 20s + 40s in
    // createIssue and again in the signed PUT, so an unbounded flush asks the isolate to stay alive ~140 s
    // and is killed mid-flight instead. The fake resolves unconditionally and the assertion does the
    // work, so a bare `flush()` fails in milliseconds rather than by a 30s test timeout.
    const client = {
      logException: vi.fn(async () => ({ ok: true }) as const),
      flush: vi.fn(async (_t?: number) => true),
    };
    launchEdge.mockReturnValue(client);
    const { drain } = captureWaitUntil();
    const { nitroApp, fireError } = fakeNitro();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok' });
    fireError(Object.assign(new Error('boom'), { statusCode: 500 }));
    await drain();
    expect(client.flush).toHaveBeenCalledWith(expect.any(Number));
  });

  it('REPORTS a flush that ran out of time rather than dropping it silently', async () => {
    const onError = vi.fn();
    const client = {
      logException: vi.fn(async () => ({ ok: true }) as const),
      flush: vi.fn(async () => false), // abandoned on the deadline
    };
    launchEdge.mockReturnValue(client);
    const { drain } = captureWaitUntil();
    const { nitroApp, fireError } = fakeNitro();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', onError });
    fireError(Object.assign(new Error('boom'), { statusCode: 500 }));
    await drain();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('lets the caller choose the deadline via flushTimeoutMs', async () => {
    const client = fakeClient();
    launchEdge.mockReturnValue(client);
    const { drain } = captureWaitUntil();
    const { nitroApp, fireError } = fakeNitro();
    installBugseeNitroEdge(nitroApp, { appToken: 'tok', flushTimeoutMs: 2222 });
    fireError(Object.assign(new Error('boom'), { statusCode: 500 }));
    await drain();
    expect(client.flush).toHaveBeenCalledWith(2222);
  });
});
