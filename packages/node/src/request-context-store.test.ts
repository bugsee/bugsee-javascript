import type { ContextProvider, RequestContext } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createNodeRequestContextStore, RequestContextStoreToken } from './request-context-store';

describe('createNodeRequestContextStore', () => {
  it('mints a stable RequestContextStoreToken', () => {
    expect(RequestContextStoreToken.name).toBe('node-request-context-store');
  });

  it('has no current context outside of run()', () => {
    const store = createNodeRequestContextStore();
    expect(store.getCurrent()).toBeUndefined();
  });

  it('exposes the context inside run() and restores undefined after it returns', () => {
    const store = createNodeRequestContextStore();
    const ctx: RequestContext = { contextId: 'c1' };
    const inside = store.run(ctx, () => store.getCurrent());
    expect(inside).toBe(ctx);
    expect(store.getCurrent()).toBeUndefined();
  });

  it('run() returns the callback result', () => {
    const store = createNodeRequestContextStore();
    expect(store.run({ contextId: 'c1' }, () => 42)).toBe(42);
  });

  it('setUser / setAttribute / setTrace mutate the current context', () => {
    const store = createNodeRequestContextStore();
    const ctx: RequestContext = { contextId: 'c1' };
    store.run(ctx, () => {
      store.setUser('alice@x.com');
      store.setAttribute('route', '/pay');
      store.setAttribute('retries', 2);
      store.setTrace({ traceId: 't1', spanId: 's1', sampled: true });
    });
    expect(ctx.user).toBe('alice@x.com');
    expect(ctx.attributes).toEqual({ route: '/pay', retries: 2 });
    expect(ctx.trace).toEqual({ traceId: 't1', spanId: 's1', sampled: true });
  });

  it('mutators are no-ops outside a context and never throw', () => {
    const store = createNodeRequestContextStore();
    expect(() => {
      store.setUser('x');
      store.setAttribute('k', 'v');
      store.setTrace({ traceId: 't', spanId: 's', sampled: true });
    }).not.toThrow();
    expect(store.getCurrent()).toBeUndefined();
  });

  it('isolates concurrent async contexts — each chain sees ONLY its own context', async () => {
    const store = createNodeRequestContextStore();
    const seen: Array<string | undefined> = [];
    const run = (id: string, delayMs: number) =>
      store.run({ contextId: id }, async () => {
        // Interleave: yield long enough for the other contexts' run() to start before reading back.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(store.getCurrent()?.contextId);
      });
    await Promise.all([run('A', 20), run('B', 5), run('C', 12)]);
    // Despite interleaving, every chain read back its OWN id (no bleed). Sorted to ignore finish order.
    expect([...seen].sort()).toEqual(['A', 'B', 'C']);
  });

  it('is usable as the core ContextProvider seam', () => {
    const store = createNodeRequestContextStore();
    const provider: ContextProvider = store;
    expect(provider.getCurrent()).toBeUndefined();
    expect(provider.getCurrent.call(store)).toBeUndefined();
  });

  it('enterWith binds the context for the current async execution (Fastify hook model)', () => {
    const store = createNodeRequestContextStore();
    const ctx: RequestContext = { contextId: 'e1' };
    expect(store.getCurrent()).toBeUndefined();
    store.enterWith(ctx);
    expect(store.getCurrent()).toBe(ctx);
  });

  it('isolates enterWith across separate async executions (no bleed)', async () => {
    const store = createNodeRequestContextStore();
    const seen: Array<string | undefined> = [];
    // Each branch runs in its OWN async context (a fresh setImmediate resource), like a per-request hook —
    // so enterWith in one does not leak into another despite interleaving.
    const branch = (id: string, delayMs: number) =>
      new Promise<void>((resolve) => {
        setImmediate(async () => {
          store.enterWith({ contextId: id });
          await new Promise((r) => setTimeout(r, delayMs));
          seen.push(store.getCurrent()?.contextId);
          resolve();
        });
      });
    await Promise.all([branch('A', 20), branch('B', 5), branch('C', 12)]);
    expect([...seen].sort()).toEqual(['A', 'B', 'C']);
  });
});
