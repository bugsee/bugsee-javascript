import type { Bugsee, RequestContextStore } from '@bugsee/node';
import { describe, expect, it, vi } from 'vitest';
import { createBugseeMiddleware } from './middleware';
import type { NestHttpRequest } from './shared';

const fakeStore = (): RequestContextStore & { enterWith: ReturnType<typeof vi.fn> } =>
  ({
    getCurrent: vi.fn(),
    run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    enterWith: vi.fn(),
    setAttribute: vi.fn(),
    setTrace: vi.fn(),
  }) as unknown as RequestContextStore & { enterWith: ReturnType<typeof vi.fn> };

const fakeClient = (store?: RequestContextStore): Bugsee =>
  ({
    getServiceProvider: () => ({ getImmediate: () => store ?? undefined }),
    ext: () => {
      throw new Error('no ext');
    },
    logException: vi.fn(() => Promise.resolve()),
  }) as unknown as Bugsee;

const req = (over: Partial<NestHttpRequest> = {}): NestHttpRequest => ({
  method: 'GET',
  url: '/',
  headers: {},
  ...over,
});

describe('createBugseeMiddleware', () => {
  it('passes through (next once, no context opened) when no client is launched', () => {
    const next = vi.fn();
    createBugseeMiddleware({ getClient: () => undefined })(req(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('defaults to the carrier client (no options) — pass-through when none is launched', () => {
    const next = vi.fn();
    // exercises the `options.getClient ?? defaultGetClient` fallback + the `options = {}` default
    createBugseeMiddleware()(req(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes through when a client is present but no context store is registered', () => {
    const next = vi.fn();
    const user = vi.fn(() => 'x');
    const newContextId = vi.fn(() => 'cid');
    createBugseeMiddleware({ getClient: () => fakeClient(undefined), user, newContextId })(
      req(),
      {},
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    // no store → no context is built: the user getter / id minter must NOT run (no wasted work)
    expect(user).not.toHaveBeenCalled();
    expect(newContextId).not.toHaveBeenCalled();
  });

  it('opens the context (store.enterWith) then calls next', () => {
    const store = fakeStore();
    const next = vi.fn();
    createBugseeMiddleware({
      getClient: () => fakeClient(store),
      newContextId: () => 'cid-42',
    })(req({ method: 'POST', originalUrl: '/orders' }), {}, next);

    expect(store.enterWith).toHaveBeenCalledTimes(1);
    const [ctx] = store.enterWith.mock.calls[0] as [{ contextId: string }];
    expect(ctx.contextId).toBe('cid-42');
    // enterWith binds the context on the ambient async context; next() then continues the request
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('resolves the user via the getter and stamps it on the context', () => {
    const store = fakeStore();
    const user = vi.fn(() => 'bob@example.com');
    const r = req();
    createBugseeMiddleware({ getClient: () => fakeClient(store), user })(r, {}, vi.fn());
    expect(user).toHaveBeenCalledWith(r);
    const [ctx] = store.enterWith.mock.calls[0] as [{ user?: string }];
    expect(ctx.user).toBe('bob@example.com');
  });

  it('passes through (never throws) when getClient throws', () => {
    const next = vi.fn();
    createBugseeMiddleware({
      getClient: () => {
        throw new Error('resolve failed');
      },
    })(req(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('skips opening a context when one is ALREADY active (node:http re-entrancy)', () => {
    // The node:http auto-instrument has already run-scoped this request's context: getCurrent() returns it.
    const store = fakeStore();
    store.getCurrent = vi.fn(() => ({ contextId: 'owner', attributes: {} })) as never;
    const next = vi.fn();
    const user = vi.fn(() => 'x');
    const newContextId = vi.fn(() => 'cid');
    createBugseeMiddleware({ getClient: () => fakeClient(store), user, newContextId })(
      req(),
      {},
      next,
    );
    // A second enterWith would OVERWRITE the owner's context → must NOT happen; the request still flows.
    expect(store.enterWith).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled(); // short-circuit: no wasted work
    expect(newContextId).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes through when the user getter throws (setup failure is swallowed)', () => {
    const store = fakeStore();
    const next = vi.fn();
    createBugseeMiddleware({
      getClient: () => fakeClient(store),
      user: () => {
        throw new Error('user getter blew up');
      },
    })(req(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(store.enterWith).not.toHaveBeenCalled();
  });
});
