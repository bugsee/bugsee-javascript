import type { ContextProvider, RequestContext } from '@bugsee/core';
import { createTransaction, type Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import { createRequestScopedActiveSpanStore } from './active-span-store';
import { createNodeRequestContextStore } from './request-context-store';

const txn = (name: string): Transaction =>
  createTransaction(
    { name, operation: 'http.server' },
    { clock: { wallNow: () => 1000, monotonicNow: () => 0 } },
  );

const context = (id: string): RequestContext => ({ contextId: id });

describe('createRequestScopedActiveSpanStore', () => {
  it('with no current context it behaves as an ambient single slot', () => {
    const source: ContextProvider = { getCurrent: () => undefined };
    const store = createRequestScopedActiveSpanStore(source);
    expect(store.get()).toBeUndefined();
    const ambient = txn('ambient');
    store.set(ambient);
    expect(store.get()).toBe(ambient);
    store.clear(ambient);
    expect(store.get()).toBeUndefined();
  });

  it('the ambient leg filters finished transactions even when never cleared', () => {
    // Defense-in-depth for the "NEVER returns a finished transaction" contract: the controller always
    // clears on finish, but a direct store user may not — the read must still not resurrect it.
    const source: ContextProvider = { getCurrent: () => undefined };
    const store = createRequestScopedActiveSpanStore(source);
    const ambient = txn('ambient');
    store.set(ambient);
    ambient.finish(); // finished with no clear() — e.g. a code path that bypasses the controller
    expect(store.get()).toBeUndefined();
  });

  it('a null current context reads as absent — never a crash', () => {
    // A custom binding may return null (the idiomatic absent value) instead of undefined. Every
    // op must treat it as "no active request": the property read and the defineProperty below both
    // assume an object-or-undefined.
    const source: ContextProvider = { getCurrent: () => null as unknown as RequestContext };
    const store = createRequestScopedActiveSpanStore(source);
    const ambient = txn('ambient');
    expect(() => store.set(ambient)).not.toThrow();
    expect(store.get()).toBe(ambient); // null reads as absent → the ambient slot
    expect(() => store.clear(ambient)).not.toThrow();
    expect(store.get()).toBeUndefined();
  });

  it('a non-object current context reads as absent — never a crash', () => {
    // A request-id string (or any primitive) where a context object belongs: reads/writes must
    // degrade, and defineProperty (which throws on a primitive) must never be reached with one.
    const source: ContextProvider = { getCurrent: () => 'req-1' as unknown as RequestContext };
    const store = createRequestScopedActiveSpanStore(source);
    const ambient = txn('ambient');
    expect(() => store.set(ambient)).not.toThrow();
    expect(store.get()).toBe(ambient);
    expect(() => store.clear(ambient)).not.toThrow();
    expect(store.get()).toBeUndefined();
  });

  it('clear() on an empty store is a no-op', () => {
    const source: ContextProvider = { getCurrent: () => undefined };
    const store = createRequestScopedActiveSpanStore(source);
    expect(() => store.clear(txn('ghost'))).not.toThrow();
    expect(store.get()).toBeUndefined();
  });

  it('a scoped write SHADOWS the ambient slot — both present reads the scoped one', () => {
    // The documented precedence (and its inversion, `ambient ?? stashed`, is exactly the D2 hazard).
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    const scoped = txn('scoped');
    store.set(ambient);
    als.run(context('S'), () => {
      store.set(scoped);
      expect(store.get()).toBe(scoped); // the request's own transaction, not the ambient one
    });
    expect(store.get()).toBe(ambient);
  });

  it('a finished scoped transaction does NOT reveal ambient — the slot stays private to the request', () => {
    // F1 (round 6): after this request's own transaction finished and cleared, a read here must NOT
    // fall back to ambient — otherwise a post-finish setRouteName() would rename a FOREIGN live
    // transaction. The fallback is only for contexts that never held a transaction (the still-open
    // outer-scope case); once a context owned one, its slot is private: its own live stash or nothing.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    const scoped = txn('scoped');
    store.set(ambient);
    als.run(context('S'), () => {
      store.set(scoped);
      expect(store.get()).toBe(scoped); // the request's own transaction, not the ambient one
      store.clear(scoped);
      expect(store.get()).toBeUndefined(); // …so nothing is active here — NOT the live ambient one
      const second = txn('second'); // …while a fresh start in the same request still works
      store.set(second);
      expect(store.get()).toBe(second);
      store.clear(second);
      expect(store.get()).toBeUndefined(); // …and clearing it reveals nothing either (R-1)
    });
    expect(store.get()).toBe(ambient); // ambient itself untouched throughout
  });

  it('clearing an ambient transaction from inside a context clears the ambient slot', () => {
    // SEV2-#1: clear lands where the transaction LIVES (ambient) — not by deleting a nonexistent
    // context stash while the finished transaction stays readable everywhere. (Under R-1 the
    // in-context read below is private-empty — this request never stashed — which is exactly why
    // the clear must not depend on observing the transaction first.)
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    store.set(ambient);
    als.run(context('B'), () => {
      expect(store.get()).toBeUndefined(); // this request stashed nothing: private-empty
      store.clear(ambient); // what the controller does on finish — on a LIVE transaction
    });
    // The discriminating assertion, and the reason this test does NOT finish the transaction first:
    // `get()` hides a finished transaction whether or not the slot still holds it, so a pre-emptive
    // finish() would make this pass with clear() deleted outright. Clearing a LIVE transaction from
    // inside a context can only read undefined here if the clear actually reached the ambient slot.
    expect(store.get()).toBeUndefined();
  });

  it('a finished scoped transaction is never read — and never reveals ambient either', () => {
    // SEV2-#2 readability + round-6 F1 narrowing: a transaction finished outside its originating
    // context (e.g. a response `close` firing after the ALS context exited) leaves a stale stash
    // the store cannot reach to delete — but no read may resurface it, and the owning context's
    // slot stays private afterward (no fallback to ambient, where a rename would mistarget).
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    store.set(ambient);
    const ctx = context('L');
    als.run(ctx, () => store.set(txn('scoped')));
    als.run(ctx, () => {
      // Finish from the same context object (reachable stash), then prove the read skips it…
      store.get()?.finish();
      expect(store.get()).toBeUndefined();
    });
    expect(store.get()).toBe(ambient); // …while ambient itself is undisturbed throughout
  });

  it('overwriting the stash on one context works (writable, still non-enumerable)', () => {
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ctx = context('W');
    const first = txn('first');
    const second = txn('second');
    als.run(ctx, () => {
      store.set(first);
      store.set(second); // a second start in the same request replaces the first
      expect(store.get()).toBe(second);
      expect(Object.keys(ctx)).toEqual(['contextId']);
    });
  });

  it('concurrent enterWith handlers isolate per context (hook-adapter entry)', async () => {
    // R-14: every other concurrency proof uses run(), but the hook adapters (fastify/nestjs/hapi)
    // open contexts via enterWith. Two interleaved handlers, each binding its own context object,
    // must still isolate — probed shape, passes.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const seen: Record<string, string | undefined> = {};
    const handler = async (id: string, delayMs: number): Promise<void> => {
      als.enterWith(context(id));
      store.set(txn(id));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      seen[id] = store.get()?.getName();
    };
    await Promise.all([handler('A', 20), handler('B', 5)]);
    expect(seen).toEqual({ A: 'A', B: 'B' });
  });

  it('a nested run() inside an enterWith context reads private-empty (known limitation)', () => {
    // R-14/R-1: the inner context is a fresh object that never stashed, and reads are strictly
    // private — so it does NOT inherit the outer request's live stash (there is no parent handle
    // to inherit through). The outer transaction's lifecycle is unaffected: its own finish still
    // clears its own stash. Pinned to document the limitation honestly, not to bless it.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const outer = txn('outer');
    als.enterWith(context('outer'));
    store.set(outer);
    expect(store.get()).toBe(outer);
    als.run(context('inner'), () => {
      expect(store.get()).toBeUndefined(); // private-empty, not the outer request's live stash
    });
    expect(store.get()).toBe(outer); // the outer slot itself undisturbed
    store.clear(outer);
    expect(store.get()).toBeUndefined();
  });

  it('keying is by context identity, not by contextId', () => {
    // Two distinct context objects sharing one id (two run() calls — two requests) stay isolated,
    // mirroring server-instrument's object-keyed stash.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    als.run({ contextId: 'same' }, () => store.set(txn('one')));
    expect(als.run({ contextId: 'same' }, () => store.get())).toBeUndefined();
  });

  it('stashes the transaction on the current context — isolated per context', () => {
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ctxA = context('A');
    const ctxB = context('B');
    const txnA = txn('A');
    als.run(ctxA, () => store.set(txnA));
    // B never saw A's transaction: per-request isolation (D2 part 2).
    expect(als.run(ctxB, () => store.get())).toBeUndefined();
    expect(als.run(ctxA, () => store.get())).toBe(txnA);
    // Outside every context the ambient slot is untouched by the stashed write.
    expect(store.get()).toBeUndefined();
  });

  it('concurrent run()-scoped requests never see each other’s transaction', async () => {
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const seen: Record<string, string | undefined> = {};
    const request = async (id: string, delayMs: number): Promise<void> => {
      await als.run(context(id), async () => {
        store.set(txn(id));
        // Interleave: yield so the other request's run() starts before reading back.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen[id] = store.get()?.getName();
      });
    };
    await Promise.all([request('A', 20), request('B', 5)]);
    expect(seen).toEqual({ A: 'A', B: 'B' });
  });

  it('clear() inside a context removes the stash — the slot goes empty, not ambient', () => {
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    store.set(ambient);
    const ctx = context('C');
    const scoped = txn('scoped');
    als.run(ctx, () => {
      store.set(scoped);
      store.clear(scoped); // e.g. the scoped transaction finished
      expect(store.get()).toBeUndefined(); // private slot: empty, NOT the live ambient one (F1)
    });
    expect(store.get()).toBe(ambient); // the ambient write survived the scoped clear
  });

  it('clear() drops only the matching transaction — a scoped clear keeps a live ambient one', () => {
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    const scoped = txn('scoped');
    const other = txn('other');
    store.set(ambient);
    als.run(context('K'), () => {
      store.set(scoped);
      store.clear(other); // finishing some unrelated transaction clears nothing here…
      expect(store.get()).toBe(scoped);
      store.clear(ambient); // …while the ambient one clears independently of the live stash
      expect(store.get()).toBe(scoped);
    });
    expect(store.get()).toBeUndefined(); // the ambient clear landed where the transaction lived
  });

  it('a context without a stash reads nothing — never another execution’s transaction', () => {
    // R-1: context-bearing reads are strictly private. Even with a live ambient transaction present,
    // a request that never stashed its own sees nothing here — the old fallback (which handed over
    // the ambient transaction, and let a naming call rename it) had no producer and every such read
    // is the D2 hazard direction. Ambient serves context-less executions only (pinned below).
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    store.set(ambient);
    expect(als.run(context('D'), () => store.get())).toBeUndefined();
    expect(store.get()).toBe(ambient); // …while context-less reads still see it
  });

  it('the stash never leaks into context enumeration (report assembly / capture stamping)', () => {
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ctx = context('E');
    als.run(ctx, () => store.set(txn('hidden')));
    expect(Object.keys(ctx)).toEqual(['contextId']);
    expect({ ...ctx }).toEqual({ contextId: 'E' });
    expect(JSON.stringify(ctx)).toBe('{"contextId":"E"}');
  });

  it('a throwing context source degrades to the ambient slot instead of breaking the request', () => {
    const failing: ContextProvider = {
      getCurrent: () => {
        throw new Error('host ALS broken');
      },
    };
    const store = createRequestScopedActiveSpanStore(failing);
    const ambient = txn('ambient');
    expect(() => store.set(ambient)).not.toThrow();
    expect(store.get()).toBe(ambient);
    expect(() => store.clear(ambient)).not.toThrow();
    expect(store.get()).toBeUndefined();
  });

  it('a context that cannot carry a stash reads nothing — never another execution’s transaction', () => {
    // F1, now structural (R-1): context-bearing reads are strictly private, so a dropped write
    // leaves reads empty by construction — with a live ambient transaction present, get() still
    // returns nothing here, and a setRouteName() in the frozen request no-ops instead of renaming
    // a FOREIGN transaction.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ambient = txn('ambient');
    store.set(ambient);
    const frozen = Object.freeze(context('F'));
    als.run(frozen, () => {
      store.set(txn('dropped'));
      expect(store.get()).toBeUndefined(); // NOT the live ambient transaction
    });
    expect(store.get()).toBe(ambient); // ambient itself untouched
  });

  it('each cause warns once — a throwing source and a later drop report separately', () => {
    // One latch per cause-site, not one latch total: a transient ALS breakage must not consume the
    // warning owed to a later frozen-context drop (or vice versa) — different root causes, both
    // worth exactly one report.
    const als = createNodeRequestContextStore();
    const thrown = new Error('host ALS broken');
    let throwing = true;
    const source: ContextProvider = {
      getCurrent: () => {
        if (throwing) throw thrown;
        return als.getCurrent();
      },
    };
    const onError = vi.fn();
    const store = createRequestScopedActiveSpanStore(source, { onError });
    store.get(); // the throwing source warns…
    expect(onError).toHaveBeenCalledTimes(1);
    throwing = false;
    const frozen = Object.freeze(context('F'));
    als.run(frozen, () => store.set(txn('dropped'))); // …then a drop warns again, once…
    expect(onError).toHaveBeenCalledTimes(2);
    als.run(frozen, () => store.set(txn('dropped-again'))); // …and never a third time
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('each store warns once — a module-hoisted latch would silence the second store', () => {
    // Two stores off one throwing source (e.g. two launches in tests) must EACH report once: the
    // latch is per store instance, not shared module state.
    const thrown = new Error('host ALS broken');
    const failing: ContextProvider = {
      getCurrent: () => {
        throw thrown;
      },
    };
    const first = vi.fn();
    const second = vi.fn();
    const a = createRequestScopedActiveSpanStore(failing, { onError: first });
    const b = createRequestScopedActiveSpanStore(failing, { onError: second });
    a.get();
    b.get();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a throwing onError sink never escapes into the request path', () => {
    // The sink is host-supplied (server-instrument.ts precedent: "a broken sink must never become
    // the request's outcome"). The latch must still hold, so the breakage throws exactly once.
    const failing: ContextProvider = {
      getCurrent: () => {
        throw new Error('host ALS broken');
      },
    };
    const store = createRequestScopedActiveSpanStore(failing, {
      onError: () => {
        throw new Error('sink broken');
      },
    });
    expect(() => store.get()).not.toThrow();
    expect(() => store.get()).not.toThrow(); // latched — the sink is not retried
  });

  it('a sealed-after-stash context keeps reading its own live transaction', () => {
    // The first write succeeded (live T1 stashed), the context sealed after, and only the SECOND
    // write fails (dropped + warned). Reads still return the request's own live T1 — the failed
    // write changes nothing about what is already stashed.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ctx = context('S8');
    const first = txn('first');
    als.run(ctx, () => {
      store.set(first);
      Object.seal(ctx); // sealed AFTER the stash: the next write throws…
      store.set(txn('second')); // …dropped, but must NOT contain the live first stash
      expect(store.get()).toBe(first);
      first.finish();
      expect(store.get()).toBeUndefined();
    });
  });

  it('clear() blanks the stash without a map transition — even on a sealed context', () => {
    // R-19: clearing by assignment (the descriptor is already `writable: true`) instead of `delete`
    // avoids forcing V8 dictionary mode. Seal AFTER the stash lands: a sealed object preserves
    // writability, so the blanking write still lands and the slot empties immediately.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ctx = context('SEALED');
    const scoped = txn('scoped');
    als.run(ctx, () => {
      store.set(scoped);
      Object.seal(ctx);
      expect(() => store.clear(scoped)).not.toThrow();
      expect(store.get()).toBeUndefined(); // blanked, not retained
    });
  });

  it('clear() on a frozen context never throws — the finished stash stays hidden by the read filter', () => {
    // Freeze AFTER the stash lands (set succeeded while extensible): the object is now
    // non-writable, so the blanking assignment throws and is absorbed — teardown never breaks the
    // request path. The live stash stays readable (it was never removed), but once finished the
    // read filter hides it, so no dead transaction ever resurfaces. Storage is retained with the
    // lingering context — the same accepted shape as server-instrument's never-removed stash.
    const als = createNodeRequestContextStore();
    const store = createRequestScopedActiveSpanStore(als);
    const ctx = context('FROZEN');
    const scoped = txn('scoped');
    als.run(ctx, () => {
      store.set(scoped);
      Object.freeze(ctx); // frozen after the stash: the blanking write now throws
      expect(() => store.clear(scoped)).not.toThrow();
      expect(store.get()).toBe(scoped); // still live → still readable (blanking failed)
      scoped.finish();
      expect(store.get()).toBeUndefined(); // finished → the read filter hides it
    });
  });

  it('a non-extensible context drops the write instead of poisoning the ambient slot', () => {
    // An integrator may run() a frozen/sealed context object; defineProperty would throw out of
    // startTransaction and into the request path. Redirecting the write to ambient would be worse
    // than dropping it: one pathological request would overwrite the shared slot every other
    // execution reads (and a later context-less set would orphan the pathological request's own
    // transaction). So the write is dropped — that request loses its slot, nobody else does.
    const als = createNodeRequestContextStore();
    const onError = vi.fn();
    const store = createRequestScopedActiveSpanStore(als, { onError });
    const ambient = txn('ambient');
    store.set(ambient); // a live ambient transaction other executions rely on
    const frozen = Object.freeze(context('F'));
    const scoped = txn('scoped');
    expect(() => als.run(frozen, () => store.set(scoped))).not.toThrow();
    expect(store.get()).toBe(ambient); // untouched — the dropped write poisoned nothing
    expect(onError).toHaveBeenCalledTimes(1); // …but the drop is surfaced once, not silent
    als.run(frozen, () => store.set(txn('again')));
    expect(onError).toHaveBeenCalledTimes(1); // still once, not per request — the latch, not the call count
    scoped.finish(); // finishing the dropped transaction disturbs nothing…
    expect(() => als.run(frozen, () => store.clear(scoped))).not.toThrow();
    expect(store.get()).toBe(ambient); // …it was held nowhere, and ambient survives
  });

  it('a throwing context source warns once through onError, then degrades silently', () => {
    // A broken host ALS binding is indistinguishable from "no request active" by shape (both read
    // as no-context), so silence is the safe default — but when a sink is provided, the FIRST throw
    // is surfaced exactly once (not once per request) so the breakage is discoverable.
    const thrown = new Error('host ALS broken');
    const failing: ContextProvider = {
      getCurrent: () => {
        throw thrown;
      },
    };
    const onError = vi.fn();
    const store = createRequestScopedActiveSpanStore(failing, { onError });
    const ambient = txn('ambient');
    expect(() => store.set(ambient)).not.toThrow();
    expect(store.get()).toBe(ambient);
    expect(() => store.clear(ambient)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1); // once across get/set/clear, not per call
    expect(onError).toHaveBeenCalledWith(thrown);
  });
});
