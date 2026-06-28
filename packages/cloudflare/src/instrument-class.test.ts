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
