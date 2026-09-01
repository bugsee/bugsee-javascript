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
  const flush = vi.fn((_timeoutMs?: number) => Promise.resolve(true));
  const client = {
    logException,
    flush,
    getService: (token: unknown) => (token === EdgeContextStoreToken ? store : undefined),
  } as unknown as Bugsee;
  return { client, store, logException, flush };
}

const ctxStub = () => ({ waitUntil: vi.fn() });

afterEach(() => vi.restoreAllMocks());

describe('instrumentDurableObject — the flush deadline', () => {
  // A DO's `ctx.waitUntil` is inert, so the flush is AWAITED in-request and defaults to a short 3 s.
  // That default was documented as overridable and was not: `DurableObjectInstrumentOptions` did not
  // carry `flushTimeoutMs` and `instrumentEdgeClass` never forwarded one, so the only path that uses
  // the aggressive deadline was the one path that could not change it.
  const runFetch = async (options?: { flushTimeoutMs?: number }) => {
    const { client, flush } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    class MyDO {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
    }
    const Instrumented = instrumentDurableObject('tok', MyDO, options);
    const instance = new Instrumented(ctxStub(), {}) as unknown as {
      fetch(r: Request): Promise<Response>;
    };
    await instance.fetch(new Request('https://x.test/'));
    return flush;
  };

  it('awaits the flush on the DEFAULT short deadline', async () => {
    expect(await runFetch()).toHaveBeenCalledWith(3_000);
  });

  it('forwards an explicit flushTimeoutMs all the way to the client', async () => {
    expect(await runFetch({ flushTimeoutMs: 25_000 })).toHaveBeenCalledWith(25_000);
  });
});

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

// S4: each Durable Object instance stamps its OWN id as the tenant owner.
//
// Different DO instances share one isolate, one client and one capture ring. The owner is what lets the
// partitioned store keep tenant C's incident bundle free of tenant A's and B's secrets — the leak proven
// on real workerd (docs/review/cloudflare.md SEV1 #2).
describe('instrumentDurableObject — tenant owner', () => {
  it('runs each instance in a context owned by that instance id', async () => {
    const owners: Array<string | undefined> = [];
    const edge = await import('@bugsee/vercel-edge');
    const spy = vi
      .spyOn(edge, 'runInEdgeContext')
      .mockImplementation(async (_c: unknown, options: { owner?: string }, fn: () => unknown) => {
        owners.push(options.owner);
        return fn();
      });

    class DO {
      // NOT a useless constructor, though biome reads it as one: `instrumentDurableObject`'s generic
      // propagates the class's constructor ARITY to the wrapper, so removing this makes every
      // `new Wrapped(state, env)` below a "Expected 0 arguments" type error. Verified by deleting it.
      // biome-ignore lint/complexity/noUselessConstructor: declares the DO constructor arity (see above)
      constructor(..._args: unknown[]) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
    }
    const Wrapped = instrumentDurableObject('tok', DO);
    const state = (id: string) => ({ id: { toString: () => id }, waitUntil: () => {} });

    await new Wrapped(state('tenant-A'), {}).fetch(new Request('https://x/'));
    await new Wrapped(state('tenant-B'), {}).fetch(new Request('https://x/'));

    expect(owners).toEqual(['tenant-A', 'tenant-B']);
    spy.mockRestore();
  });

  it('omits the owner when the state carries no id, rather than inventing one', async () => {
    const owners: Array<string | undefined> = [];
    const edge = await import('@bugsee/vercel-edge');
    const spy = vi
      .spyOn(edge, 'runInEdgeContext')
      .mockImplementation(async (_c: unknown, options: { owner?: string }, fn: () => unknown) => {
        owners.push(options.owner);
        return fn();
      });
    class DO {
      // NOT a useless constructor, though biome reads it as one: `instrumentDurableObject`'s generic
      // propagates the class's constructor ARITY to the wrapper, so removing this makes every
      // `new Wrapped(state, env)` below a "Expected 0 arguments" type error. Verified by deleting it.
      // biome-ignore lint/complexity/noUselessConstructor: declares the DO constructor arity (see above)
      constructor(..._args: unknown[]) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
    }
    const Wrapped = instrumentDurableObject('tok', DO);
    await new Wrapped({ waitUntil: () => {} }, {}).fetch(new Request('https://x/'));
    expect(owners).toEqual([undefined]);
    spy.mockRestore();
  });
});

// The owner probe must never break CONSTRUCTION.
//
// `durableObjectOwner` reads `ctx.id.toString()`, which is host-supplied: a Durable Object's state comes
// from workerd, and on a stub, a mock, or a future runtime shape that getter can throw. The catch there was
// the one uncovered line in this package — a guard nothing exercised, protecting the path where a throw
// would take down every DO construction rather than costing one capture partition.
describe('a hostile DurableObjectState', () => {
  it('yields no owner instead of throwing out of the constructor', async () => {
    const owners: Array<string | undefined> = [];
    const edge = await import('@bugsee/vercel-edge');
    const spy = vi
      .spyOn(edge, 'runInEdgeContext')
      .mockImplementation(async (_c: unknown, options: { owner?: string }, fn: () => unknown) => {
        owners.push(options.owner);
        return fn();
      });
    class DO {
      // NOT a useless constructor, though biome reads it as one: `instrumentDurableObject`'s generic
      // propagates the class's constructor ARITY to the wrapper, so removing this makes every
      // `new Wrapped(state, env)` below a "Expected 0 arguments" type error. Verified by deleting it.
      // biome-ignore lint/complexity/noUselessConstructor: declares the DO constructor arity (see above)
      constructor(..._args: unknown[]) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
    }
    const Wrapped = instrumentDurableObject('tok', DO);
    const hostile = {
      get id(): { toString(): string } {
        throw new Error('hostile DurableObjectState');
      },
      waitUntil: () => {},
    };
    let instance: InstanceType<typeof Wrapped> | undefined;
    expect(() => {
      instance = new Wrapped(hostile as never, {});
    }).not.toThrow();
    await (instance as unknown as DO).fetch(new Request('https://x/'));
    expect(owners).toEqual([undefined]); // no owner → no partitioning, but the DO still works
    spy.mockRestore();
  });
});

// The tenant key must be USABLE, not merely present.
//
// `durableObjectOwner` deliberately returns `undefined` rather than propagating a value that cannot serve as
// a partition key. An empty string is the dangerous one: it is falsy but `!== undefined`, so it WOULD be
// spread onto the invocation context as an owner — a "tenant" every id-less DO would share, quietly merging
// their capture back into one ring, which is the leak the owner exists to prevent.
describe('an unusable Durable Object id yields NO owner', () => {
  const ownerFor = async (id: unknown): Promise<string | undefined> => {
    const { client, store } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let owner: string | undefined;
    class DO {
      // biome-ignore lint/complexity/noUselessConstructor: declares the DO constructor arity (see above)
      constructor(..._args: unknown[]) {}
      async fetch(_request: Request): Promise<Response> {
        owner = store.getCurrent()?.owner;
        return new Response('ok');
      }
    }
    const Wrapped = instrumentDurableObject('tok', DO);
    const instance = new Wrapped({ id, waitUntil: () => {} } as never, {}) as unknown as DO;
    await instance.fetch(new Request('https://x.test/'));
    return owner;
  };

  it('drops an EMPTY-STRING id (a shared "" tenant is worse than none)', async () => {
    await expect(ownerFor({ toString: () => '' })).resolves.toBeUndefined();
  });

  it('drops a non-string toString() result rather than coercing it', async () => {
    await expect(ownerFor({ toString: () => 42 })).resolves.toBeUndefined();
    await expect(ownerFor({ toString: () => undefined })).resolves.toBeUndefined();
    await expect(ownerFor({ toString: () => ({ nested: true }) })).resolves.toBeUndefined();
  });

  it('still accepts an ordinary non-empty id (the canary — the guards did not reject everything)', async () => {
    await expect(ownerFor({ toString: () => 'room-17' })).resolves.toBe('room-17');
  });
});
