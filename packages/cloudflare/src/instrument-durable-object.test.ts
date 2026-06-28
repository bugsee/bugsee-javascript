import {
  type Bugsee,
  createEdgeRequestContextStore,
  EdgeContextStoreToken,
} from '@bugsee/vercel-edge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instrumentDurableObject } from './instrument-durable-object';
import * as cfLaunch from './launch';

function fakeClient() {
  const store = createEdgeRequestContextStore();
  const logException = vi.fn((_e: unknown, _o?: unknown) => Promise.resolve({ ok: true }));
  const flush = vi.fn(() => Promise.resolve(true));
  const client = {
    logException,
    flush,
    getService: (token: unknown) => (token === EdgeContextStoreToken ? store : undefined),
  } as unknown as Bugsee;
  return { client, store, logException, flush };
}

const ctxStub = () => ({ waitUntil: vi.fn() });

afterEach(() => vi.restoreAllMocks());

describe('instrumentDurableObject', () => {
  it('instruments DO fetch with http + request.cf attributes and flushes via the DO ctx', async () => {
    const { client, store, flush } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        attrs = store.getCurrent()?.attributes;
        return new Response('do-ok');
      }
    }
    const Instrumented = instrumentDurableObject('tok', MyDO);
    const request = new Request('https://x.test/items/3');
    Object.defineProperty(request, 'cf', { value: { colo: 'SJC' }, configurable: true });
    const ctx = ctxStub();
    const res = await new Instrumented(ctx, {}).fetch(request);
    expect(await res.text()).toBe('do-ok');
    expect(attrs).toMatchObject({ 'http.url': '/items/3', 'cf.colo': 'SJC' });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil).not.toHaveBeenCalled(); // a DO AWAITS the flush — DurableObjectState.waitUntil is inert
  });

  it('AWAITS the flush inside the DO request (DurableObjectState.waitUntil is a no-op → no orphaned upload)', async () => {
    const { client, flush } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let releaseFlush: (value: boolean) => void = () => {};
    flush.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseFlush = resolve;
      }),
    );
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
    }
    const Instrumented = instrumentDurableObject('tok', MyDO);
    let settled = false;
    const call = new Instrumented(ctxStub(), {}).fetch(new Request('https://x.test/')).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // the DO method has NOT resolved — it is awaiting the flush (keeps the DO alive)
    releaseFlush(true);
    await call;
    expect(settled).toBe(true); // resolves only once the flush completes
  });

  it('instruments the WebSocket Hibernation handlers (message / close / error)', async () => {
    const { client, store } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    const seen: Record<string, Record<string, unknown> | undefined> = {};
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
      async webSocketMessage(_ws: unknown, _message: unknown): Promise<void> {
        seen.message = store.getCurrent()?.attributes;
      }
      async webSocketClose(_ws: unknown): Promise<void> {
        seen.close = store.getCurrent()?.attributes;
      }
      async webSocketError(_ws: unknown, _error: unknown): Promise<void> {
        seen.error = store.getCurrent()?.attributes;
      }
    }
    const Instrumented = instrumentDurableObject('tok', MyDO);
    const instance = new Instrumented(ctxStub(), {});
    await instance.webSocketMessage({}, 'hi');
    await instance.webSocketClose({});
    await instance.webSocketError({}, new Error('ws'));
    expect(seen.message).toEqual({ 'cloudflare.handler': 'durable_object.websocket_message' });
    expect(seen.close).toEqual({ 'cloudflare.handler': 'durable_object.websocket_close' });
    expect(seen.error).toEqual({ 'cloudflare.handler': 'durable_object.websocket_error' });
  });

  it('instruments DO alarm with the alarm attributes', async () => {
    const { client, store } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
      async alarm(): Promise<void> {
        attrs = store.getCurrent()?.attributes;
      }
    }
    const Instrumented = instrumentDurableObject('tok', MyDO);
    await new Instrumented(ctxStub(), {}).alarm();
    expect(attrs).toEqual({
      'faas.trigger': 'timer',
      'cloudflare.handler': 'durable_object.alarm',
    });
  });

  it('does NOT instrument arbitrary RPC methods by default', async () => {
    const { client, store } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let sawContext = true;
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
      async compute(n: number): Promise<number> {
        sawContext = store.getCurrent() !== undefined; // raw method → no Bugsee context
        return n + 1;
      }
    }
    const Instrumented = instrumentDurableObject('tok', MyDO);
    expect(await new Instrumented(ctxStub(), {}).compute(41)).toBe(42);
    expect(sawContext).toBe(false); // compute ran raw (not wrapped) — no context opened
  });

  it('opt-in instrumentRpcMethods wraps an arbitrary method (rpc.method attribute)', async () => {
    const { client, store, flush } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
      async compute(n: number): Promise<number> {
        attrs = store.getCurrent()?.attributes;
        return n + 1;
      }
    }
    const Instrumented = instrumentDurableObject('tok', MyDO, { instrumentRpcMethods: true });
    expect(await new Instrumented(ctxStub(), {}).compute(41)).toBe(42); // non-Response return preserved
    expect(attrs).toEqual({ 'cloudflare.handler': 'rpc', 'rpc.method': 'compute' });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('launches lazily from the constructor env callback + caches across DO instances', () => {
    const { client } = fakeClient();
    const launchSpy = vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
    }
    const Instrumented = instrumentDurableObject(
      (env: unknown) => (env as { TOKEN: string }).TOKEN,
      MyDO,
    );
    new Instrumented(ctxStub(), { TOKEN: 'from-env' });
    new Instrumented(ctxStub(), { TOKEN: 'from-env' });
    expect(launchSpy).toHaveBeenCalledTimes(1); // lazy + cached per isolate
    expect(launchSpy).toHaveBeenCalledWith('from-env', {});
  });
});
