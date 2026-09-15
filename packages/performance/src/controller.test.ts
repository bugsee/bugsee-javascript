import type { Clock } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { type ActiveSpanStore, createSingleSlotActiveSpanStore } from './active-span-store';
import { createPerformanceController } from './controller';
import {
  createTransaction,
  serializeTransaction,
  type Transaction,
  type TransactionWire,
} from './span';
import { createTransactionStore } from './transaction-store';

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

describe('createPerformanceController', () => {
  it('startTransaction returns a sampled transaction stamped with the app version/build', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      appVersion: '1.2.3',
      appBuild: '456',
    });
    const txn = api.startTransaction({
      name: 'Checkout',
      operation: 'ui.load',
      description: 'cart',
    });
    expect(txn.getName()).toBe('Checkout');
    expect(txn.getOperation()).toBe('ui.load');
    expect(txn.getDescription()).toBe('cart'); // a passed description is forwarded
    expect(txn.isSampled()).toBe(true);
  });

  it('continues an inbound trace — the transaction adopts the given trace id', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const inbound = '0123456789abcdef0123456789abcdef';
    const txn = api.startTransaction({
      name: 'GET /x',
      operation: 'http.server',
      continuation: { traceId: inbound },
    });
    expect(txn.getTraceId()).toBe(inbound);
  });

  it('continuation makes the root a CHILD of the inbound span and ADOPTS the upstream sampling (§12)', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      sampler: () => true, // local sampler says sample…
    });
    const txn = api.startTransaction({
      name: 'GET /x',
      operation: 'http.server',
      continuation: {
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        parentSpanId: 'bbbbbbbbbbbbbbbb',
        sampled: false,
      },
    });
    expect(txn.getTraceId()).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(serializeTransaction(txn).parentSpanId).toBe('bbbbbbbbbbbbbbbb'); // root is a child
    expect(txn.isSampled()).toBe(false); // …but the upstream UNSAMPLED decision wins
  });

  it('a traceId-only continuation (no sampled) falls back to the LOCAL sampler — not a hardcoded true', () => {
    const store = createTransactionStore();
    // The local sampler says DROP; the continuation supplies a trace id but no sampling decision, so the
    // local sampler must decide (controller.ts `continuation?.sampled ?? sampler()`).
    const api = createPerformanceController({ clock: fixedClock, store, sampler: () => false });
    const txn = api.startTransaction({
      name: 'GET /x',
      operation: 'http.server',
      continuation: { traceId: '0123456789abcdef0123456789abcdef' }, // traceId only, no `sampled`
    });
    expect(txn.getTraceId()).toBe('0123456789abcdef0123456789abcdef'); // trace id still adopted
    expect(txn.isSampled()).toBe(false); // the LOCAL sampler decided, not a hardcoded true
  });

  it('starts a fresh random trace id when there is no continuation', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const txn = api.startTransaction({ name: 'x', operation: 'op' });
    expect(txn.getTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('tracks the active span: the started transaction, cleared when it finishes', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    expect(api.getActiveSpan()).toBeUndefined();
    const txn = api.startTransaction({ name: 'N', operation: 'op' });
    expect(api.getActiveSpan()).toBe(txn);
    txn.finish();
    expect(api.getActiveSpan()).toBeUndefined();
  });

  it('the latest started transaction becomes active; finishing a non-active one leaves it', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const first = api.startTransaction({ name: 'first', operation: 'op' });
    const second = api.startTransaction({ name: 'second', operation: 'op' });
    expect(api.getActiveSpan()).toBe(second);
    first.finish(); // finishing the NON-active transaction must NOT clear the active one
    expect(api.getActiveSpan()).toBe(second);
    second.finish(); // finishing the active one clears it
    expect(api.getActiveSpan()).toBeUndefined();
  });

  it('buffers a finished (sampled) transaction into the store, stamped with the app info', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      appVersion: '9.9',
      appBuild: 'b1',
    });
    const txn = api.startTransaction({ name: 'T', operation: 'op' });
    expect(store.size()).toBe(0); // nothing until it finishes
    txn.finish('OK');
    const drained = store.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      name: 'T',
      operation: 'op',
      appVersion: '9.9',
      appBuild: 'b1',
    });
  });

  it('drops an UNSAMPLED transaction (head sampling): returned but never buffered', () => {
    const store = createTransactionStore();
    const finished: string[] = [];
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      sampler: () => false,
      onFinished: (wire) => finished.push(wire.name),
    });
    const txn = api.startTransaction({ name: 'T', operation: 'op' });
    expect(txn.isSampled()).toBe(false);
    txn.finish();
    expect(store.size()).toBe(0); // unsampled → not buffered
    expect(finished).toEqual([]); // …and not routed to the capture ring either
    expect(api.getActiveSpan()).toBeUndefined(); // still cleared as active
  });

  it('routes each SAMPLED finished transaction to onFinished (the capture ring), with the same wire', () => {
    const store = createTransactionStore();
    const finished: TransactionWire[] = [];
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      onFinished: (wire) => finished.push(wire),
    });
    api.startTransaction({ name: 'A', operation: 'op' }).finish('OK');
    api.startTransaction({ name: 'B', operation: 'op' }).finish('OK');
    // onFinished sees one wire per sampled finish, in order, identical to what the store buffered.
    expect(finished.map((w) => w.name)).toEqual(['A', 'B']);
    expect(store.drain()).toEqual(finished);
  });

  it('defaults to sampling everything when no sampler is injected', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    api.startTransaction({ name: 'T', operation: 'op' }).finish();
    expect(store.size()).toBe(1);
  });

  it('setActiveTransactionName refines the active transaction name + stamps the provenance (D5)', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const txn = api.startTransaction({ name: '/users/42', operation: 'navigation' }); // phase 1: raw URL
    api.setActiveTransactionName('/users/:id', { source: 'route' }); // phase 2: resolved route
    expect(txn.getName()).toBe('/users/:id');
    expect(txn.getAttributes()['bugsee.name_source']).toBe('route');
  });

  it('setActiveTransactionName defaults the provenance to custom when no source is given', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const txn = api.startTransaction({ name: 'x', operation: 'pageload' });
    api.setActiveTransactionName('Dashboard');
    expect(txn.getName()).toBe('Dashboard');
    expect(txn.getAttributes()['bugsee.name_source']).toBe('custom');
  });

  it('setRouteName is sugar for setActiveTransactionName(name, { source: route })', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const txn = api.startTransaction({ name: '/raw', operation: 'navigation' });
    api.setRouteName('/orders/:id');
    expect(txn.getName()).toBe('/orders/:id');
    expect(txn.getAttributes()['bugsee.name_source']).toBe('route');
  });

  it('the naming seam is a no-op when no transaction is active (nothing to name)', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    expect(api.getActiveSpan()).toBeUndefined();
    expect(() => api.setActiveTransactionName('x', { source: 'route' })).not.toThrow();
    expect(() => api.setRouteName('y')).not.toThrow();
    // after the active transaction finishes, the seam no longer touches it
    const txn = api.startTransaction({ name: 'orig', operation: 'navigation' });
    txn.finish();
    api.setRouteName('/late'); // active was cleared on finish → must NOT rename the finished txn
    expect(txn.getName()).toBe('orig');
  });

  it('the seam renames only the ACTIVE (latest) transaction, not a superseded one', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    const first = api.startTransaction({ name: 'first', operation: 'navigation' });
    const second = api.startTransaction({ name: 'second', operation: 'navigation' });
    api.setRouteName('/resolved');
    expect(second.getName()).toBe('/resolved'); // the active one is refined
    expect(first.getName()).toBe('first'); // the superseded one is untouched
  });
});

describe('createPerformanceController — the injectable active-span store (D2 part 2)', () => {
  it('startTransaction writes the new transaction into the injected store', () => {
    const store = createTransactionStore();
    const activeSpanStore = createSingleSlotActiveSpanStore();
    const set = vi.spyOn(activeSpanStore, 'set');
    const api = createPerformanceController({ clock: fixedClock, store, activeSpanStore });
    const txn = api.startTransaction({ name: 'T', operation: 'op' });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(txn);
    expect(activeSpanStore.get()).toBe(txn);
  });

  it('getActiveSpan reads LIVE from the injected store — a write after construction is visible', () => {
    // A snapshot-at-construction (`const cached = store.get()` in createPerformanceController) would
    // pass a pre-seeded read yet break the whole D2 premise (the request-scoped store changes value
    // per async context with no controller involvement). So the external write lands AFTER construction.
    const store = createTransactionStore();
    const activeSpanStore = createSingleSlotActiveSpanStore();
    const api = createPerformanceController({ clock: fixedClock, store, activeSpanStore });
    expect(api.getActiveSpan()).toBeUndefined();
    const own = api.startTransaction({ name: 'own', operation: 'op' });
    expect(api.getActiveSpan()).toBe(own);
    // Simulate another execution context's write arriving with no controller involvement.
    const foreign = createTransaction({ name: 'foreign', operation: 'op' }, { clock: fixedClock });
    activeSpanStore.set(foreign);
    expect(api.getActiveSpan()).toBe(foreign);
  });

  it('finishing clears through the store’s clear() — a non-held finish clears nothing', () => {
    const store = createTransactionStore();
    const activeSpanStore = createSingleSlotActiveSpanStore();
    const clear = vi.spyOn(activeSpanStore, 'clear');
    const api = createPerformanceController({ clock: fixedClock, store, activeSpanStore });
    const first = api.startTransaction({ name: 'first', operation: 'op' });
    const second = api.startTransaction({ name: 'second', operation: 'op' });
    first.finish(); // held nowhere (second overwrote it) → clear(first) must NOT drop second
    expect(clear).toHaveBeenCalledWith(first);
    expect(activeSpanStore.get()).toBe(second);
    second.finish(); // the held one → cleared through the store
    expect(clear).toHaveBeenCalledWith(second);
    expect(activeSpanStore.get()).toBeUndefined();
  });

  it('the naming seam renames the transaction the injected store holds, not a superseded one', () => {
    const store = createTransactionStore();
    const activeSpanStore = createSingleSlotActiveSpanStore();
    const api = createPerformanceController({ clock: fixedClock, store, activeSpanStore });
    const txn = api.startTransaction({ name: '/raw', operation: 'navigation' });
    // A stale-closure naming seam (renaming a captured variable instead of reading the store) would
    // rename `txn` here; the store holds the foreign transaction, so it must win.
    const foreign = createTransaction(
      { name: '/other', operation: 'navigation' },
      { clock: fixedClock },
    );
    activeSpanStore.set(foreign);
    api.setRouteName('/orders/:id');
    expect(foreign.getName()).toBe('/orders/:id');
    expect(txn.getName()).toBe('/raw');
    // setActiveTransactionName reads the same live slot (a stale-closure regression confined to it
    // would rename `txn` while setRouteName stays correct — so both seams are probed, not just one).
    const foreign2 = createTransaction(
      { name: '/third', operation: 'navigation' },
      { clock: fixedClock },
    );
    activeSpanStore.set(foreign2);
    api.setActiveTransactionName('/named', { source: 'route' });
    expect(foreign2.getName()).toBe('/named');
    expect(foreign2.getAttributes()['bugsee.name_source']).toBe('route');
    expect(txn.getName()).toBe('/raw');
  });

  it('a dropped transaction (unsampled, or filtered out) still clears the slot on finish', () => {
    // clear() must sit OUTSIDE the sampled/filtered branches: the slot holds the transaction from
    // start regardless of the sampling/filter verdict, so gating the clear on it would retain a
    // finished transaction (unreadable via get()'s filter, but retained). Pinned both ways.
    for (const deps of [{ sampler: () => false }, { filterTransaction: () => null }] as const) {
      const store = createTransactionStore();
      const activeSpanStore = createSingleSlotActiveSpanStore();
      const clear = vi.spyOn(activeSpanStore, 'clear');
      const api = createPerformanceController({
        clock: fixedClock,
        store,
        activeSpanStore,
        ...deps,
      });
      const dropped = api.startTransaction({ name: 'T', operation: 'op' });
      expect(activeSpanStore.get()).toBe(dropped); // …yet the slot still holds it while live
      dropped.finish();
      expect(store.size()).toBe(0); // the drop verdict landed, both ways (unsampled / filtered)
      expect(clear).toHaveBeenCalledWith(dropped);
      expect(activeSpanStore.get()).toBeUndefined();
    }
  });

  it('the default slot is per-controller — two default controllers do not share active state', () => {
    // A module-hoisted shared default (`?? sharedSlot`) would pass every single-controller test while
    // leaking one client/micro-frontend's active transaction into another's on the browser path.
    const store = createTransactionStore();
    const first = createPerformanceController({ clock: fixedClock, store });
    const second = createPerformanceController({ clock: fixedClock, store });
    const txn = first.startTransaction({ name: 'T', operation: 'op' });
    expect(first.getActiveSpan()).toBe(txn);
    expect(second.getActiveSpan()).toBeUndefined();
  });

  it('a throwing custom store never breaks the controller — tracking degrades, nothing throws', () => {
    // The seam is public, so any integrator implementation can break. The controller must degrade
    // to untracked (usable transactions, no active slot) rather than propagate into the caller —
    // startTransaction is called directly from user code.
    const broken = (): never => {
      throw new Error('custom store broken');
    };
    const hostileStore: ActiveSpanStore = { get: broken, set: broken, clear: broken };
    const store = createTransactionStore();
    const api = createPerformanceController({
      clock: fixedClock,
      store,
      activeSpanStore: hostileStore,
    });
    let txn!: ReturnType<typeof api.startTransaction>;
    expect(() => {
      txn = api.startTransaction({ name: 'T', operation: 'op' });
    }).not.toThrow();
    expect(api.getActiveSpan()).toBeUndefined(); // degraded read, not a throw
    expect(() => api.setRouteName('/x')).not.toThrow(); // degraded no-op…
    expect(txn.getName()).toBe('T'); // …that renamed nothing
    expect(() => txn.finish('OK')).not.toThrow(); // the finish-time clear is absorbed too…
    expect(store.drain()).toHaveLength(1); // …while the sinks still ran normally
  });

  it('a throwing store is SURFACED through onError — once per site, never once per call', () => {
    // R-3: degrading silently is the defect. The seam is public (`createPerformanceExtension`, and
    // `@bugsee/node` exports the request-scoped factory), so a broken store is reachable — but a
    // silent degrade means route naming stops working with no signal anywhere. Latched per SITE so a
    // store that throws on every outgoing network call cannot flood the sink.
    const broken = (): never => {
      throw new Error('custom store broken');
    };
    const hostileStore: ActiveSpanStore = { get: broken, set: broken, clear: broken };
    const onError = vi.fn();
    const api = createPerformanceController({
      clock: fixedClock,
      store: createTransactionStore(),
      activeSpanStore: hostileStore,
      onError,
    });
    const txn = api.startTransaction({ name: 'T', operation: 'op' }); // set throws
    expect(onError).toHaveBeenCalledTimes(1);
    api.getActiveSpan(); // get throws
    expect(onError).toHaveBeenCalledTimes(2);
    txn.finish('OK'); // clear throws
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual([
      'custom store broken',
      'custom store broken',
      'custom store broken',
    ]);
    // Latched: every later call through the same three sites reports nothing further.
    api.getActiveSpan();
    api.setRouteName('/x');
    api.startTransaction({ name: 'U', operation: 'op' }).finish('OK');
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("a throwing onError sink never becomes the caller's outcome", () => {
    // The sink is user code (the launch option). A broken sink must not convert a degraded slot into
    // a throw out of startTransaction — the failure mode the guard exists to prevent.
    const broken = (): never => {
      throw new Error('custom store broken');
    };
    const api = createPerformanceController({
      clock: fixedClock,
      store: createTransactionStore(),
      activeSpanStore: { get: broken, set: broken, clear: broken },
      onError: () => {
        throw new Error('sink broken');
      },
    });
    let txn!: ReturnType<typeof api.startTransaction>;
    expect(() => {
      txn = api.startTransaction({ name: 'T', operation: 'op' });
    }).not.toThrow();
    expect(() => api.getActiveSpan()).not.toThrow();
    expect(() => txn.finish('OK')).not.toThrow();
  });

  it('a store returning a HOSTILE transaction never throws out of the naming seams either', () => {
    // The guard must cover the same surface as the contract it enforces. Wrapping `store.get()` but
    // not what it RETURNS left `setName`/`setAttribute` outside every try, so a custom store handing
    // back a transaction whose setters throw propagated straight into app code — the one thing the
    // must-not-throw contract promises cannot happen.
    const hostileTransaction = {
      isFinished: () => false,
      setName: () => {
        throw new Error('hostile transaction');
      },
      setAttribute: () => {
        throw new Error('hostile transaction');
      },
    } as unknown as Transaction;
    const onError = vi.fn();
    const api = createPerformanceController({
      clock: fixedClock,
      store: createTransactionStore(),
      activeSpanStore: { get: () => hostileTransaction, set: () => {}, clear: () => {} },
      onError,
    });
    expect(() => api.setRouteName('/x')).not.toThrow();
    expect(() => api.setActiveTransactionName('T')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1); // latched per site, like every other degradation
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('hostile transaction');
    // …and the read seam still hands the transaction out: only NAMING degraded.
    expect(api.getActiveSpan()).toBe(hostileTransaction);
  });

  it('the degradation latch is PER CONTROLLER — a sibling never consumes its report', () => {
    // Mirrors the store's own per-store latch test. Module-hoisting `reported` is caught today only
    // by cross-test ordering (an earlier sink-less hostile-store test would consume all the latches),
    // which is coupling, not an assertion. This states it directly.
    const broken = (): never => {
      throw new Error('custom store broken');
    };
    const hostile = (): ActiveSpanStore => ({ get: broken, set: broken, clear: broken });
    const first = vi.fn();
    const second = vi.fn();
    const apiA = createPerformanceController({
      clock: fixedClock,
      store: createTransactionStore(),
      activeSpanStore: hostile(),
      onError: first,
    });
    const apiB = createPerformanceController({
      clock: fixedClock,
      store: createTransactionStore(),
      activeSpanStore: hostile(),
      onError: second,
    });
    apiA.getActiveSpan();
    apiA.getActiveSpan(); // latched for A…
    expect(first).toHaveBeenCalledTimes(1);
    apiB.getActiveSpan(); // …and B still owes its own report
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a well-behaved store never touches onError', () => {
    const onError = vi.fn();
    const api = createPerformanceController({
      clock: fixedClock,
      store: createTransactionStore(),
      onError,
    });
    api.startTransaction({ name: 'T', operation: 'op' }).finish('OK');
    api.getActiveSpan();
    expect(onError).not.toHaveBeenCalled();
  });

  it('without an injected store the controller keeps the single-slot default (browser behavior)', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock: fixedClock, store });
    expect(api.getActiveSpan()).toBeUndefined();
    const txn = api.startTransaction({ name: 'T', operation: 'op' });
    expect(api.getActiveSpan()).toBe(txn);
    txn.finish();
    expect(api.getActiveSpan()).toBeUndefined();
  });
});

describe('createPerformanceController — the span redaction seam', () => {
  it('does not write a DROPPED transaction to either sink', () => {
    // Both sinks, deliberately: the store and the capture ring are separate writes, so filtering at one
    // would ship the unscrubbed transaction through the other. An earlier version of this wiring used
    // `filter(x) ?? serialized`, which turned every drop back into the original.
    const store = createTransactionStore({ maxTransactions: 10 });
    const onFinished = vi.fn();
    const api = createPerformanceController({
      clock: { wallNow: () => 1000, monotonicNow: () => 0 },
      store,
      onFinished,
      filterTransaction: () => null,
    });
    api.startTransaction({ name: 'GET /x', operation: 'http.server' }).finish();
    expect(store.drain()).toEqual([]);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('writes the FILTERED transaction, not the original, to both sinks', () => {
    const store = createTransactionStore({ maxTransactions: 10 });
    const onFinished = vi.fn();
    const api = createPerformanceController({
      clock: { wallNow: () => 1000, monotonicNow: () => 0 },
      store,
      onFinished,
      filterTransaction: (t) => ({ ...t, name: '<redacted>' }),
    });
    api.startTransaction({ name: 'GET /secret', operation: 'http.server' }).finish();
    expect(store.drain().map((t) => t.name)).toEqual(['<redacted>']);
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ name: '<redacted>' }));
  });
});
