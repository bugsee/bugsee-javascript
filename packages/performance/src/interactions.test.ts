import { createMultiKeyEmitter } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceApi } from './controller';
import { collectInteractions, type InteractionDetailLike } from './interactions';
import type { Span, Transaction } from './span';
import type { WebVitalsEnv } from './web-vitals/env';

// A one-shot timer (record + fire by delay) — shared shape with the navigation/idle tests.
function fakeTimer() {
  const scheduled = new Map<number, { cb: () => void; ms: number }>();
  let nextId = 1;
  return {
    timer: {
      setTimeout: vi.fn((cb: () => void, ms: number) => {
        const id = nextId++;
        scheduled.set(id, { cb, ms });
        return id;
      }),
      clearTimeout: vi.fn((h: unknown) => {
        scheduled.delete(h as number);
      }),
    },
    fire: (ms: number) => {
      let target: number | undefined;
      for (const [id, s] of scheduled) if (s.ms === ms) target = id;
      if (target !== undefined) {
        const s = scheduled.get(target);
        scheduled.delete(target);
        s?.cb();
      }
    },
  };
}

// Fully conforming — deliberately NOT cast (`as unknown as Transaction`). Left as a bare object literal
// assigned to a `Transaction`-typed const, tsc's missing-property check on a fresh object literal rejects
// this double at authoring time (a CI gate) the moment `Transaction` grows a member it does not implement.
// R5-8: these three were the last casts left, and they sit in the package that OWNS the interface.
const fakeTxn = (operation = 'ui.interaction'): Transaction => {
  const txn: Transaction = {
    getTraceId: () => 'trace-1',
    getSpanId: () => 'span-1',
    isSampled: () => true,
    isFinished: vi.fn(() => false),
    setName: vi.fn(() => txn),
    setDescription: vi.fn(() => txn),
    setAttribute: vi.fn(() => txn),
    setStatus: vi.fn(() => txn),
    startChildSpan: vi.fn(() => txn),
    recordChildSpan: vi.fn(),
    getStatus: () => 'OK',
    getDescription: () => undefined,
    getAttributes: vi.fn(() => ({})),
    getName: () => 'name',
    finish: vi.fn(),
    getOperation: () => operation,
  };
  return txn;
};

// A fake performance API: startTransaction records + becomes the active slot (mirrors the real controller),
// and `setActive` injects an externally-active span (e.g. a navigation/pageload) for the coexistence gate.
function fakeApi() {
  const started: Transaction[] = [];
  let active: Span | undefined;
  const api: PerformanceApi = {
    startTransaction: vi.fn((opts: { operation: string }) => {
      const t = fakeTxn(opts.operation);
      started.push(t);
      active = t;
      return t;
    }) as unknown as PerformanceApi['startTransaction'],
    getActiveSpan: () => active,
    setActiveTransactionName: () => {}, // unused by the interaction collector (the seam is F5/controller)
    setRouteName: () => {},
  };
  return { api, started, setActive: (s: Span | undefined) => (active = s) };
}

function fakeEnv() {
  const docListeners = new Map<string, Set<() => void>>();
  let visibilityState = 'visible';
  const env = {
    document: {
      addEventListener: (t: string, l: () => void) =>
        (docListeners.get(t) ?? docListeners.set(t, new Set()).get(t))?.add(l),
      removeEventListener: (t: string, l: () => void) => docListeners.get(t)?.delete(l),
      get visibilityState() {
        return visibilityState;
      },
    },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
  } as unknown as WebVitalsEnv;
  return {
    env,
    fireHidden: () => {
      visibilityState = 'hidden';
      for (const l of docListeners.get('visibilitychange') ?? []) l();
    },
    hiddenListenerCount: () => docListeners.get('visibilitychange')?.size ?? 0,
  };
}

const intSource = () => createMultiKeyEmitter<{ interact: InteractionDetailLike }>();
const netSource = () => createMultiKeyEmitter<Record<NetworkStage, NetworkEvent>>();
const detail = (over: Partial<InteractionDetailLike> = {}): InteractionDetailLike => ({
  interactionType: over.interactionType ?? 'click',
  ...(over.target !== undefined ? { target: over.target } : {}),
  ...(over.component !== undefined ? { component: over.component } : {}),
  duration: over.duration ?? 50,
  interactionId: over.interactionId ?? 1,
});

describe('collectInteractions', () => {
  it('opens a `ui.interaction` transaction per interaction, named + stamped (type, target, duration)', () => {
    const source = intSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectInteractions({ source, api, env: fakeEnv().env, timer: t.timer, finalTimeoutMs: 30000 });
    source.emit(
      'interact',
      detail({
        interactionType: 'click',
        target: 'button#submit',
        duration: 120,
        interactionId: 14,
      }),
    );
    expect(api.startTransaction).toHaveBeenCalledWith({
      name: 'click button#submit',
      operation: 'ui.interaction',
    });
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('ui.interaction_type', 'click');
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('ui.interaction_target', 'button#submit');
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('ui.interaction_duration_ms', 120);
  });

  it('stamps `ui.component` from the resolved component name (D2), and omits it when absent', () => {
    const source = intSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectInteractions({ source, api, env: fakeEnv().env, timer: t.timer });
    source.emit('interact', detail({ component: 'Toolbar', interactionId: 1 }));
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('ui.component', 'Toolbar');
    // a second interaction with no component → no ui.component stamped
    source.emit('interact', detail({ interactionId: 2 }));
    expect(started[1]?.setAttribute).not.toHaveBeenCalledWith('ui.component', expect.anything());
  });

  it('names by the interaction type alone (and stamps no target) when there is no target', () => {
    const source = intSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectInteractions({ source, api, env: fakeEnv().env, timer: t.timer });
    source.emit('interact', detail({ interactionType: 'keydown', duration: 40, interactionId: 2 }));
    expect(api.startTransaction).toHaveBeenCalledWith({
      name: 'keydown',
      operation: 'ui.interaction',
    });
    // Exactly the type + duration attributes — no `ui.interaction_target` at all (not even `undefined`,
    // which `expect.anything()` would miss). Pins the `if (detail.target !== undefined)` guard.
    expect(started[0]?.setAttribute).toHaveBeenCalledTimes(2);
    expect(started[0]?.setAttribute).not.toHaveBeenCalledWith('ui.interaction_target', undefined);
  });

  /**
   * Everything that can fire BEFORE the first interaction — the collector's opening state.
   *
   * `current` is undefined until an interaction is detected, yet a network stage, a tab hide and teardown
   * are all live from the moment the collector is wired. Every `current?.` guarding that survived
   * mutation. A page that issues requests during load, or is opened in a background tab, reaches this
   * state on every session.
   */
  it('tolerates network activity, a hide, and teardown before the first interaction', () => {
    const source = intSource();
    // The emitter SWALLOWS a listener throw, so `not.toThrow()` around `emit` cannot see a keepAlive that
    // blew up on the undefined transaction. The error sink can.
    const listenerErrors: unknown[] = [];
    const network = createMultiKeyEmitter<Record<NetworkStage, NetworkEvent>>((e) =>
      listenerErrors.push(e),
    );
    const { api, started } = fakeApi();
    const { env, fireHidden } = fakeEnv();
    const stop = collectInteractions({ source, api, networkSource: network, env });

    for (const stage of ['before', 'complete', 'error', 'abort'] as const) {
      network.emit(stage, { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
    }
    expect(listenerErrors, 'keepAlive threw before any interaction existed').toEqual([]);
    expect(() => fireHidden()).not.toThrow();
    expect(() => stop()).not.toThrow();
    expect(started, 'a transaction was started without an interaction').toHaveLength(0);
  });

  it('SKIPS the interaction when an active NAVIGATION owns the slot (no double-count of a click→route change)', () => {
    const source = intSource();
    const { api, setActive } = fakeApi();
    const t = fakeTimer();
    collectInteractions({ source, api, env: fakeEnv().env, timer: t.timer });
    setActive(fakeTxn('navigation')); // a route change is already in flight
    source.emit('interact', detail({ interactionId: 9 }));
    expect(api.startTransaction).not.toHaveBeenCalled();
  });

  it('does NOT skip when the active span is the lingering pageload (a no-navigation SPA still records interactions)', () => {
    const source = intSource();
    const { api, setActive } = fakeApi();
    const t = fakeTimer();
    collectInteractions({ source, api, env: fakeEnv().env, timer: t.timer });
    setActive(fakeTxn('pageload')); // the pageload lingers active until tab-hide (D12) — must NOT block
    source.emit('interact', detail({ interactionId: 5 }));
    expect(api.startTransaction).toHaveBeenCalledWith({
      name: 'click',
      operation: 'ui.interaction',
    });
  });

  it('finishes the PREVIOUS interaction (OK) when a new one supersedes it', () => {
    const source = intSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectInteractions({ source, api, env: fakeEnv().env, timer: t.timer });
    source.emit('interact', detail({ interactionId: 1 }));
    source.emit('interact', detail({ interactionId: 2 }));
    expect(started[0]?.finish).toHaveBeenCalledWith('OK');
    expect(started).toHaveLength(2);
  });

  it('keeps the interaction alive on EACH network stage, then finishes OK on idle', () => {
    const source = intSource();
    const network = netSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    const clearCalls = () =>
      (t.timer.clearTimeout as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    collectInteractions({
      source,
      api,
      networkSource: network,
      env: fakeEnv().env,
      timer: t.timer,
      idleTimeoutMs: 1000,
    });
    source.emit('interact', detail({ interactionId: 1 }));
    for (const stage of ['before', 'complete', 'error', 'abort'] as const) {
      const before = clearCalls();
      network.emit(stage, { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
      expect(clearCalls()).toBe(before + 1); // this stage reset the idle timer
    }
    t.fire(1000);
    expect(started[0]?.finish).toHaveBeenCalledWith('OK');
  });

  it('does NOT keep an ORPHANED interaction alive on network activity once a navigation owns the slot', () => {
    const source = intSource();
    const network = netSource();
    const { api, setActive } = fakeApi();
    const t = fakeTimer();
    const clearCalls = () =>
      (t.timer.clearTimeout as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    collectInteractions({
      source,
      api,
      networkSource: network,
      env: fakeEnv().env,
      timer: t.timer,
      idleTimeoutMs: 1000,
    });
    source.emit('interact', detail({ interactionId: 1 })); // the interaction owns the active slot
    setActive(fakeTxn('navigation')); // a navigation steals it → the interaction is now orphaned
    const before = clearCalls();
    network.emit('before', { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
    expect(clearCalls()).toBe(before); // NO idle-timer reset — the orphan is not propped up by foreign traffic
  });

  it('cancels the in-flight interaction when the tab is hidden', () => {
    const source = intSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    const env = fakeEnv();
    collectInteractions({ source, api, env: env.env, timer: t.timer });
    source.emit('interact', detail({ interactionId: 1 }));
    env.fireHidden();
    expect(started[0]?.finish).toHaveBeenCalledWith('CANCELLED');
  });

  it('teardown cancels the in-flight interaction, removes the hidden listener, and ignores later events', () => {
    const source = intSource();
    const network = netSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    const env = fakeEnv();
    const stop = collectInteractions({
      source,
      api,
      networkSource: network,
      env: env.env,
      timer: t.timer,
    });
    source.emit('interact', detail({ interactionId: 1 }));
    expect(env.hiddenListenerCount()).toBe(1); // onHidden registered a visibility listener
    stop();
    expect(started[0]?.finish).toHaveBeenCalledWith('CANCELLED');
    expect(env.hiddenListenerCount()).toBe(0); // teardown removed it (no leak across launch/stop)
    source.emit('interact', detail({ interactionId: 2 }));
    network.emit('before', { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
    expect(api.startTransaction).toHaveBeenCalledTimes(1);
    expect(started[0]?.finish).toHaveBeenCalledTimes(1);
  });

  it('works without a network source (no keepAlive wiring)', () => {
    const source = intSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectInteractions({ source, api, env: fakeEnv().env, timer: t.timer, idleTimeoutMs: 1000 });
    source.emit('interact', detail({ interactionId: 1 }));
    t.fire(1000);
    expect(started[0]?.finish).toHaveBeenCalledWith('OK');
  });

  it('uses the default idle timeout + the global timer + real env when none are injected', () => {
    vi.useFakeTimers();
    try {
      const source = intSource();
      const { api, started } = fakeApi();
      collectInteractions({ source, api });
      source.emit('interact', detail({ interactionId: 1 }));
      vi.advanceTimersByTime(1000);
      expect(started[0]?.finish).toHaveBeenCalledWith('OK');
    } finally {
      vi.useRealTimers();
    }
  });
});
