import {
  type Bugsee,
  createEdgeRequestContextStore,
  EdgeContextStoreToken,
} from '@bugsee/vercel-edge';
import { describe, expect, it, vi } from 'vitest';
import { instrumentEdgeClass } from './instrument-class';

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

// A class-based handler (Durable-Object-shaped) with a PRIVATE field + an RPC method (non-Response return).
class FakeObject {
  #base = 10;
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response(String(this.#base)); // reads a private field through the wrapper
  }
  async doubler(n: number): Promise<number> {
    return n * 2 + this.#base; // RPC: non-Response return + private field
  }
  async boom(): Promise<never> {
    throw new Error('rpc-boom');
  }
}

describe('instrumentEdgeClass', () => {
  it('wraps a lifecycle method: runs the original in a context + flushes via the constructor ctx', async () => {
    const { client, store, flush } = fakeClient();
    let attrsDuring: Record<string, unknown> | undefined;
    class DO {
      #secret = 42;
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        attrsDuring = store.getCurrent()?.attributes;
        return new Response(String(this.#secret));
      }
    }
    const Instrumented = instrumentEdgeClass(() => client, DO, [
      { name: 'fetch', attributes: () => ({ 'cloudflare.handler': 'durable_object.fetch' }) },
    ]);
    const ctx = ctxStub();
    const instance = new Instrumented(ctx, {});
    const res = await instance.fetch(new Request('https://x.test/'));
    expect(await res.text()).toBe('42'); // private (#) field worked → `this` is the REAL instance, not a Proxy
    expect(attrsDuring).toEqual({ 'cloudflare.handler': 'durable_object.fetch' });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('launches the client lazily from the constructor env (arg 1)', () => {
    const { client } = fakeClient();
    const ensureClient = vi.fn(() => client);
    const Instrumented = instrumentEdgeClass(ensureClient, FakeObject, [
      { name: 'fetch', attributes: () => ({}) },
    ]);
    const env = { TOKEN: 'secret' };
    new Instrumented(ctxStub(), env);
    expect(ensureClient).toHaveBeenCalledWith(env);
  });

  it('skips a configured method that the class does not define (no throw)', () => {
    const { client } = fakeClient();
    const Instrumented = instrumentEdgeClass(() => client, FakeObject, [
      { name: 'fetch', attributes: () => ({}) },
      { name: 'alarm', attributes: () => ({}) }, // FakeObject has no `alarm` → skipped
    ]);
    const instance = new Instrumented(ctxStub(), {});
    expect((instance as { alarm?: unknown }).alarm).toBeUndefined();
    expect(typeof instance.fetch).toBe('function');
  });

  it('opt-in rpc=true wraps arbitrary methods, preserving a non-Response return value', async () => {
    const { client, flush } = fakeClient();
    const Instrumented = instrumentEdgeClass(
      () => client,
      FakeObject,
      [{ name: 'fetch', attributes: () => ({}) }],
      true,
    );
    const instance = new Instrumented(ctxStub(), {});
    expect(await instance.doubler(5)).toBe(20); // 5*2 + #base(10): non-Response return + private field preserved
    expect(flush).toHaveBeenCalledTimes(1); // ran through runInEdgeContext (flushed)
  });

  it('opt-in rpc=[names] wraps ONLY the named methods (others left raw)', async () => {
    const { client, logException, flush } = fakeClient();
    const Instrumented = instrumentEdgeClass(
      () => client,
      FakeObject,
      [{ name: 'fetch', attributes: () => ({}) }],
      ['doubler'], // wrap doubler, NOT boom
    );
    const instance = new Instrumented(ctxStub(), {});
    expect(await instance.doubler(1)).toBe(12);
    expect(flush).toHaveBeenCalledTimes(1); // doubler was wrapped
    await expect(instance.boom()).rejects.toThrow('rpc-boom');
    expect(logException).not.toHaveBeenCalled(); // boom was NOT wrapped → no capture
  });

  it('does NOT wrap getters/setters under rpc=true (and never reads the getter at construction)', () => {
    const { client } = fakeClient();
    const getterRead = vi.fn();
    class WithGetter {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
      get computed(): number {
        getterRead();
        return 7;
      }
    }
    const Instrumented = instrumentEdgeClass(
      () => client,
      WithGetter,
      [{ name: 'fetch', attributes: () => ({}) }],
      true,
    );
    const instance = new Instrumented(ctxStub(), {});
    expect(getterRead).not.toHaveBeenCalled(); // not enumerated as RPC → not read during construction
    expect(instance.computed).toBe(7); // still a working getter (unwrapped)
    expect(getterRead).toHaveBeenCalledTimes(1);
  });

  it('wraps an INHERITED lifecycle method but enumerates ONLY own methods for rpc', () => {
    const { client } = fakeClient();
    class Base {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('base');
      } // inherited lifecycle
      async inheritedRpc(): Promise<string> {
        return 'base-rpc';
      }
    }
    class Sub extends Base {
      async ownRpc(): Promise<string> {
        return 'sub-rpc';
      }
    }
    const Instrumented = instrumentEdgeClass(
      () => client,
      Sub,
      [{ name: 'fetch', attributes: () => ({}) }],
      true,
    );
    const instance = new Instrumented(ctxStub(), {});
    // Wrapped on the SUBCLASS PROTOTYPE, never as an own property of the instance. These three lines used
    // to assert `Object.hasOwn(instance, …) === true`, i.e. they pinned the defect: an own property shadows
    // the prototype method out of Cloudflare's RPC surface, which made every instrumented method uncallable
    // over RPC (docs/review/cloudflare.md SEV1 #1, reproduced on real workerd).
    const proto = Object.getPrototypeOf(instance) as object;
    expect(Object.hasOwn(instance, 'fetch')).toBe(false); // NOT an own property…
    expect(Object.hasOwn(proto, 'fetch')).toBe(true); // …wrapped on the prototype instead
    expect(Object.hasOwn(proto, 'ownRpc')).toBe(true); // own RPC method enumerated + wrapped
    expect(Object.hasOwn(proto, 'inheritedRpc')).toBe(false); // inherited RPC NOT enumerated (own-prototype only)
  });

  it('does not wrap the reserved RPC names (dup / connect) under rpc=true', () => {
    const { client } = fakeClient();
    class WithReserved {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
      async connect(): Promise<string> {
        return 'c';
      }
      async dup(): Promise<string> {
        return 'd';
      }
      async real(): Promise<string> {
        return 'r';
      }
    }
    const Instrumented = instrumentEdgeClass(
      () => client,
      WithReserved,
      [{ name: 'fetch', attributes: () => ({}) }],
      true,
    );
    const instance = new Instrumented(ctxStub(), {});
    const proto = Object.getPrototypeOf(instance) as object;
    expect(Object.hasOwn(proto, 'real')).toBe(true); // a real RPC method is wrapped, on the prototype
    expect(Object.hasOwn(proto, 'connect')).toBe(false); // reserved (WorkerEntrypoint) → not wrapped
    expect(Object.hasOwn(proto, 'dup')).toBe(false); // reserved (all RPC) → not wrapped
  });

  it('captures + RETHROWS a thrown wrapped method (mechanism uncaught)', async () => {
    const { client, logException } = fakeClient();
    const Instrumented = instrumentEdgeClass(
      () => client,
      FakeObject,
      [{ name: 'fetch', attributes: () => ({}) }],
      true,
    );
    const instance = new Instrumented(ctxStub(), {});
    await expect(instance.boom()).rejects.toThrow('rpc-boom');
    expect(logException).toHaveBeenCalledTimes(1);
    expect((logException.mock.calls[0]?.[1] as { mechanism?: string })?.mechanism).toBe('uncaught');
  });
});

// The RPC surface (docs/review/cloudflare.md SEV1 #1), pinned structurally.
//
// `instrumentRpcMethods` is a documented opt-in that DELETED the customer's RPC surface: Cloudflare
// dispatches RPC by looking methods up on the PROTOTYPE, and the wrapper was assigned as an own property
// of the instance, shadowing the prototype method out of existence as far as RPC is concerned. Verified on
// real workerd in @bugsee/instrumentation-tests (`durable-object-rpc.e2e.ts`), with an uninstrumented
// method on the same instance as the control; these are the fast structural equivalents.
describe('instrumented methods stay on the prototype (Wave: cloudflare SEV1 #1)', () => {
  class Counter {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
    #count = 0;
    async fetch(_request: Request): Promise<Response> {
      return new Response('ok');
    }
    increment(by: number): number {
      this.#count += by;
      return this.#count;
    }
  }

  const build = () => {
    const { client } = fakeClient();
    const Instrumented = instrumentEdgeClass(
      () => client,
      Counter,
      [{ name: 'fetch', attributes: () => ({}) }],
      ['increment'],
    );
    return new Instrumented(ctxStub(), {});
  };

  it('adds NO own property to the instance', () => {
    const instance = build();
    expect(Object.getOwnPropertyNames(instance)).not.toContain('increment');
    expect(Object.getOwnPropertyNames(instance)).not.toContain('fetch');
  });

  it('the wrapped method is reachable through the prototype chain', () => {
    const instance = build();
    expect(typeof (instance as unknown as { increment: unknown }).increment).toBe('function');
    expect(Object.hasOwn(Object.getPrototypeOf(instance) as object, 'increment')).toBe(true);
  });

  it('keeps the wrapper NON-ENUMERABLE, like the class method it replaces', () => {
    // Class methods are non-enumerable by spec. An enumerable one changes the customer's object: it starts
    // appearing in `for…in` over instances, and in anything built on that.
    const instance = build();
    const keys: string[] = [];
    for (const key in instance) keys.push(key);
    expect(keys).not.toContain('increment');
    expect(keys).not.toContain('fetch');
  });

  it('runs an instance NOT constructed through us untouched, rather than throwing', () => {
    // The wrapper lives on the prototype, so it can be reached by an object that never went through our
    // constructor — `Object.create(proto)`, a deserialized instance, a subclass that skips `super()`. With
    // no per-instance state there is no client to open a context with; running the original is the only
    // answer that does not break the caller.
    // A class with no private fields, so `Object.create` yields an object the original method can actually
    // run on — otherwise the test would fail on the FIXTURE's `#count`, not on anything the SDK does.
    class Plain {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      double(n: number): number {
        return n * 2;
      }
    }
    const { client } = fakeClient();
    const Instrumented = instrumentEdgeClass(() => client, Plain, [], ['double']);
    const proto = Instrumented.prototype as object;
    const orphan = Object.create(proto) as { double: (n: number) => unknown };
    expect(orphan.double(4)).toBe(8); // the real method ran, synchronously — no context wrapper
  });

  it('still WRAPS — the method runs inside the edge context, not merely unchanged', async () => {
    // The canary. "No own property" is trivially satisfied by not instrumenting at all.
    //
    // The wrapper returns `runInEdgeContext(...)`, a promise, even for a synchronous method — unchanged by
    // this fix, and fine for RPC, which awaits whatever a method returns.
    const instance = build() as unknown as { increment: (by: number) => Promise<number> };
    expect(await instance.increment(2)).toBe(2);
    expect(await instance.increment(3)).toBe(5); // …and `this` (a private #field) still resolves
  });
});

// The RPC name-selection rules, pinned.
//
// `specs` is built by CONCATENATING the lifecycle methods with the derived RPC names, and each spec then
// `defineProperty`s over the last — so a name that appears in BOTH lists is instrumented twice, and the RPC
// wrapper (the last one installed) WINS. That silently replaces `fetch`'s route attributes with
// `{cloudflare.handler:'rpc'}`, which is exactly the enrichment an incident report exists to carry. The
// `alreadyInstrumented` set on both branches is what prevents it, and nothing exercised it.
describe('lifecycle methods are never re-instrumented as RPC', () => {
  it('rpc:true keeps the lifecycle attributes on fetch (not the rpc marker)', async () => {
    const { client, store } = fakeClient();
    class Handler {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        attrs = store.getCurrent()?.attributes;
        return new Response('ok');
      }
    }
    let attrs: Record<string, unknown> | undefined;
    const Instrumented = instrumentEdgeClass(
      () => client,
      Handler,
      [{ name: 'fetch', attributes: () => ({ 'http.url': '/route' }) }],
      true,
    );
    await new Instrumented(ctxStub(), {}).fetch(new Request('https://x.test/route'));
    expect(attrs).toEqual({ 'http.url': '/route' }); // NOT {cloudflare.handler:'rpc', rpc.method:'fetch'}
  });

  it('an explicit rpc NAME LIST that repeats a lifecycle method does not override it either', async () => {
    const { client, store } = fakeClient();
    let attrs: Record<string, unknown> | undefined;
    class Handler {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        attrs = store.getCurrent()?.attributes;
        return new Response('ok');
      }
      async other(): Promise<string> {
        return 'o';
      }
    }
    const Instrumented = instrumentEdgeClass(
      () => client,
      Handler,
      [{ name: 'fetch', attributes: () => ({ 'http.url': '/route' }) }],
      ['fetch', 'other'], // a caller naming fetch explicitly must not lose the route attributes
    );
    const instance = new Instrumented(ctxStub(), {});
    await instance.fetch(new Request('https://x.test/route'));
    expect(attrs).toEqual({ 'http.url': '/route' });
    // …and the genuinely-arbitrary name in the same list IS still instrumented.
    expect(Object.hasOwn(Object.getPrototypeOf(instance) as object, 'other')).toBe(true);
  });

  it('never instruments `constructor` under rpc:true (it is not an RPC method)', () => {
    const { client } = fakeClient();
    class Handler {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
    }
    const Instrumented = instrumentEdgeClass(
      () => client,
      Handler,
      [{ name: 'fetch', attributes: () => ({}) }],
      true,
    );
    const instance = new Instrumented(ctxStub(), {});
    // Wrapping `constructor` puts a wrapper on the prototype's `constructor` slot: `instance.constructor`
    // stops being the class, which breaks every `x.constructor === C` check the customer's code may do —
    // and exposes `constructor` on Cloudflare's RPC surface.
    // (`prototype.constructor` is an own property of ANY class prototype — what matters is that it still
    // points at the class rather than having been overwritten with an instrumented wrapper.)
    expect((instance as unknown as { constructor: unknown }).constructor).toBe(Instrumented);
    expect(Object.getPrototypeOf(instance)).toBe(Instrumented.prototype);
  });

  it('does NOT instrument arbitrary methods when the rpc argument is OMITTED (default off)', () => {
    const { client } = fakeClient();
    class Handler {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
      async fetch(_request: Request): Promise<Response> {
        return new Response('ok');
      }
      async secret(): Promise<string> {
        return 's';
      }
    }
    // No 4th argument → the `rpc = false` default. Defaulting the other way would instrument every method
    // of every instrumented class, which is the opt-in this parameter exists to gate.
    const Instrumented = instrumentEdgeClass(() => client, Handler, [
      { name: 'fetch', attributes: () => ({}) },
    ]);
    const proto = Instrumented.prototype as object;
    expect(Object.hasOwn(proto, 'fetch')).toBe(true);
    expect(Object.hasOwn(proto, 'secret')).toBe(false);
  });
});

// The wrapper's property DESCRIPTOR must match what a class method looks like.
//
// `writable`/`configurable` are not cosmetic here: a non-configurable, non-writable method cannot be
// replaced afterwards, so a second instrumentation pass (or the customer's own patch, or a test double)
// throws a TypeError on `defineProperty`/assignment instead of taking effect.
describe('the installed wrapper looks exactly like a class method', () => {
  it('is writable, configurable and non-enumerable', () => {
    const { client } = fakeClient();
    const Instrumented = instrumentEdgeClass(() => client, FakeObject, [
      { name: 'fetch', attributes: () => ({}) },
    ]);
    const descriptor = Object.getOwnPropertyDescriptor(Instrumented.prototype, 'fetch');
    expect(descriptor).toBeDefined();
    expect(descriptor?.writable).toBe(true);
    expect(descriptor?.configurable).toBe(true);
    expect(descriptor?.enumerable).toBe(false);
  });

  it('can still be re-defined afterwards (a frozen slot would throw here)', () => {
    const { client } = fakeClient();
    const Instrumented = instrumentEdgeClass(() => client, FakeObject, [
      { name: 'fetch', attributes: () => ({}) },
    ]);
    expect(() => {
      Object.defineProperty(Instrumented.prototype, 'fetch', {
        value: () => 'replaced',
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }).not.toThrow();
    // And plain assignment works too — that is what `writable: true` buys.
    const proto = Instrumented.prototype as unknown as { fetch: unknown };
    expect(() => {
      proto.fetch = () => 'assigned';
    }).not.toThrow();
  });
});
