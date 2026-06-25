import type { RequestContext } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEdgeRequestContextStore, type RunScopedStore } from './request-context-store';

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ contextId: 'c1', ...over });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEdgeRequestContextStore', () => {
  it('reads the active context via getCurrent + runs work within a context', () => {
    const store = createEdgeRequestContextStore({ storage: makeSingleSlot() });
    expect(store.getCurrent()).toBeUndefined();
    const seen = store.run(ctx({ contextId: 'r1' }), () => store.getCurrent()?.contextId);
    expect(seen).toBe('r1');
    expect(store.getCurrent()).toBeUndefined(); // restored after run
  });

  it('sets user / attribute / trace on the ACTIVE context only', () => {
    const store = createEdgeRequestContextStore({ storage: makeSingleSlot() });
    const c = ctx();
    store.run(c, () => {
      store.setUser('alice@example.com');
      store.setAttribute('plan', 'pro');
      store.setTrace({ traceId: 't', spanId: 's', sampled: true });
    });
    expect(c.user).toBe('alice@example.com');
    expect(c.attributes).toEqual({ plan: 'pro' });
    expect(c.trace).toEqual({ traceId: 't', spanId: 's', sampled: true });
  });

  it('mutators are no-ops when no context is open', () => {
    const store = createEdgeRequestContextStore({ storage: makeSingleSlot() });
    expect(() => {
      store.setUser('x');
      store.setAttribute('k', 1);
      store.setTrace({ traceId: 't', spanId: 's', sampled: false });
    }).not.toThrow();
    expect(store.getCurrent()).toBeUndefined();
  });

  it('accumulates multiple attributes on the active context', () => {
    const store = createEdgeRequestContextStore({ storage: makeSingleSlot() });
    const c = ctx();
    store.run(c, () => {
      store.setAttribute('a', 1);
      store.setAttribute('b', 2);
    });
    expect(c.attributes).toEqual({ a: 1, b: 2 });
  });

  it("the impl's single-slot fallback save/restores across NESTED runs (and clears after)", () => {
    vi.stubGlobal('AsyncLocalStorage', undefined); // force the impl's createSingleSlotStore (the real path)
    const store = createEdgeRequestContextStore({ logger: { warnOnce: vi.fn() } });
    const outer = ctx({ contextId: 'outer' });
    const inner = ctx({ contextId: 'inner' });
    const trail: (string | undefined)[] = [];
    store.run(outer, () => {
      trail.push(store.getCurrent()?.contextId); // outer
      store.run(inner, () => trail.push(store.getCurrent()?.contextId)); // inner
      trail.push(store.getCurrent()?.contextId); // outer again (restored, not 'inner')
    });
    expect(trail).toEqual(['outer', 'inner', 'outer']);
    expect(store.getCurrent()).toBeUndefined(); // restored to nothing after the outer run
  });

  it('uses globalThis.AsyncLocalStorage when present (run()-only — never enterWith)', () => {
    // a fake ALS exposing only the WinterCG subset: run + getStore (NO enterWith).
    const calls: string[] = [];
    class FakeALS {
      #slot: RequestContext | undefined;
      getStore() {
        return this.#slot;
      }
      run<R>(store: RequestContext, fn: () => R): R {
        calls.push('run');
        const prev = this.#slot;
        this.#slot = store;
        try {
          return fn();
        } finally {
          this.#slot = prev;
        }
      }
    }
    vi.stubGlobal('AsyncLocalStorage', FakeALS);
    const store = createEdgeRequestContextStore();
    const seen = store.run(ctx({ contextId: 'als' }), () => store.getCurrent()?.contextId);
    expect(seen).toBe('als');
    expect(calls).toEqual(['run']); // went through the real ALS, not the fallback
  });

  it('falls back to the single-slot store + warns ONCE when AsyncLocalStorage is absent', () => {
    vi.stubGlobal('AsyncLocalStorage', undefined);
    const warnOnce = vi.fn();
    const store = createEdgeRequestContextStore({ logger: { warnOnce } });
    expect(warnOnce).toHaveBeenCalledTimes(1);
    expect(warnOnce.mock.calls[0]?.[0]).toMatch(/AsyncLocalStorage/);
    // still functional via the fallback
    expect(store.run(ctx({ contextId: 'fb' }), () => store.getCurrent()?.contextId)).toBe('fb');
  });

  it('never throws at construction when the AsyncLocalStorage constructor throws', () => {
    class HostileALS {
      constructor() {
        throw new Error('no compat flag');
      }
    }
    vi.stubGlobal('AsyncLocalStorage', HostileALS);
    const warnOnce = vi.fn();
    let store: ReturnType<typeof createEdgeRequestContextStore> | undefined;
    expect(() => {
      store = createEdgeRequestContextStore({ logger: { warnOnce } });
    }).not.toThrow();
    expect(warnOnce).toHaveBeenCalledTimes(1); // degraded to the fallback
    expect(store?.run(ctx({ contextId: 'z' }), () => store?.getCurrent()?.contextId)).toBe('z');
  });
});

// A local single-slot RunScopedStore for the store-logic tests (independent of the probe).
function makeSingleSlot(): RunScopedStore<RequestContext> {
  let slot: RequestContext | undefined;
  return {
    getStore: () => slot,
    run(store, fn) {
      const prev = slot;
      slot = store;
      try {
        return fn();
      } finally {
        slot = prev;
      }
    },
  };
}
