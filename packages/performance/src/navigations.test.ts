import { createMultiKeyEmitter } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceApi } from './controller';
import { collectNavigations, type NavigationDetailLike } from './navigations';
import type { Span, Transaction } from './span';
import type { WebVitalsEnv } from './web-vitals/env';

// A one-shot timer (record + fire by delay), shared shape with the idle-transaction test.
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

const fakeTxn = () =>
  ({
    setAttribute: vi.fn(),
    finish: vi.fn(),
    isFinished: vi.fn(() => false),
  }) as unknown as Transaction;

// A fake performance API recording each started transaction.
function fakeApi() {
  const started: Transaction[] = [];
  const api: PerformanceApi = {
    startTransaction: vi.fn(() => {
      const t = fakeTxn();
      started.push(t);
      return t;
    }),
    getActiveSpan: (): Span | undefined => undefined,
    setActiveTransactionName: () => {}, // unused by the navigation collector (the seam is F5/controller)
    setRouteName: () => {},
  };
  return { api, started };
}

// A fake WebVitalsEnv whose document visibility can be flipped + fired (for onHidden background-cancel),
// tracking add/removeEventListener so teardown's listener removal is observable.
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

const navSource = () => createMultiKeyEmitter<{ navigate: NavigationDetailLike }>();
const netSource = () => createMultiKeyEmitter<Record<NetworkStage, NetworkEvent>>();
const detail = (over: Partial<NavigationDetailLike> = {}): NavigationDetailLike => ({
  to: over.to ?? '/page',
  navigationType: over.navigationType ?? 'push',
  source: over.source ?? 'url',
});

describe('collectNavigations', () => {
  it('opens a `navigation` transaction per navigation, stamped with source + type', () => {
    const source = navSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectNavigations({ source, api, env: fakeEnv().env, timer: t.timer, finalTimeoutMs: 30000 });
    source.emit('navigate', detail({ to: '/users/42', navigationType: 'push', source: 'url' }));
    expect(api.startTransaction).toHaveBeenCalledWith({
      name: '/users/42',
      operation: 'navigation',
    });
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('nav.source', 'url'); // detection axis
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('nav.type', 'push');
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('bugsee.name_source', 'url'); // phase-1 naming (D5)
  });

  it('finishes the PREVIOUS navigation when a new one starts (a view is superseded)', () => {
    const source = navSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectNavigations({ source, api, env: fakeEnv().env, timer: t.timer });
    source.emit('navigate', detail({ to: '/a' }));
    source.emit('navigate', detail({ to: '/b' }));
    expect(started[0]?.finish).toHaveBeenCalledWith('OK'); // the first nav was finished (finishNow)
    expect(started).toHaveLength(2);
  });

  it('keeps a navigation alive on EACH network stage (resets the idle timer), then finishes OK on idle', () => {
    const source = navSource();
    const network = netSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    const clearCalls = () =>
      (t.timer.clearTimeout as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    collectNavigations({
      source,
      api,
      networkSource: network,
      env: fakeEnv().env,
      timer: t.timer,
      idleTimeoutMs: 1000,
    });
    source.emit('navigate', detail({ to: '/slow' }));
    // A request START *and* its END (complete/error/abort) each reset the idle timer (so the txn spans the
    // navigation's full work). Each wired stage must clear+reschedule the idle timer exactly once.
    for (const stage of ['before', 'complete', 'error', 'abort'] as const) {
      const before = clearCalls();
      network.emit(stage, { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
      expect(clearCalls()).toBe(before + 1); // this stage reset the idle timer (if it weren't wired, no reset)
    }
    t.fire(1000); // the (last-reset) idle timer elapses
    expect(started[0]?.finish).toHaveBeenCalledWith('OK');
  });

  it('cancels the in-flight navigation when the tab is hidden', () => {
    const source = navSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    const env = fakeEnv();
    collectNavigations({ source, api, env: env.env, timer: t.timer });
    source.emit('navigate', detail({ to: '/x' }));
    env.fireHidden();
    expect(started[0]?.finish).toHaveBeenCalledWith('CANCELLED');
  });

  it('teardown cancels the in-flight navigation, removes the hidden listener, and ignores later events', () => {
    const source = navSource();
    const network = netSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    const env = fakeEnv();
    const stop = collectNavigations({
      source,
      api,
      networkSource: network,
      env: env.env,
      timer: t.timer,
    });
    source.emit('navigate', detail({ to: '/x' }));
    expect(env.hiddenListenerCount()).toBe(1); // onHidden registered a visibility listener
    stop();
    expect(started[0]?.finish).toHaveBeenCalledWith('CANCELLED'); // in-flight nav cancelled on teardown
    expect(env.hiddenListenerCount()).toBe(0); // teardown removed it (no leak across launch/stop)
    // after teardown, further events are ignored (no new transaction, no extra finish)
    source.emit('navigate', detail({ to: '/y' }));
    network.emit('before', { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
    expect(api.startTransaction).toHaveBeenCalledTimes(1);
    expect(started[0]?.finish).toHaveBeenCalledTimes(1);
  });

  /**
   * Everything that can fire BEFORE the first navigation.
   *
   * `current` is undefined until a navigation is detected, and three callbacks are already live by then —
   * a network stage, the tab going hidden, and teardown. Each guards with `current?.`, and every one of
   * those guards survived mutation, meaning no test ever entered the collector's opening state. A page
   * that issues a request or is loaded in a background tab before any navigation is detected is the
   * ordinary case, not an exotic one.
   */
  it('tolerates network activity, a hide, and teardown before the first navigation', () => {
    const source = navSource();
    // The emitter SWALLOWS a listener throw, so `not.toThrow()` around `emit` proves nothing on its own —
    // a keepAlive that blew up on the undefined transaction would look identical. The error sink makes it
    // observable.
    const listenerErrors: unknown[] = [];
    const network = createMultiKeyEmitter<Record<NetworkStage, NetworkEvent>>((e) =>
      listenerErrors.push(e),
    );
    const { api, started } = fakeApi();
    const { env, fireHidden } = fakeEnv();
    const stop = collectNavigations({ source, api, networkSource: network, env });

    for (const stage of ['before', 'complete', 'error', 'abort'] as const) {
      network.emit(stage, { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
    }
    expect(listenerErrors, 'keepAlive threw before any navigation existed').toEqual([]);
    expect(() => fireHidden()).not.toThrow();
    expect(() => stop()).not.toThrow();
    // None of it invented a transaction out of nothing.
    expect(started, 'a transaction was started without a navigation').toHaveLength(0);
  });

  /** A hide arriving AFTER teardown must find nothing to cancel — the listener cannot always be removed. */
  it('no-ops when the tab hides after teardown', () => {
    const source = navSource();
    const { api, started } = fakeApi();
    const { env, fireHidden } = fakeEnv();
    const stop = collectNavigations({ source, api, env });

    source.emit('navigate', detail({ to: '/x' }));
    stop(); // cancels the in-flight navigation and clears `current`
    const cancelled = (started[0]?.finish as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(() => fireHidden()).not.toThrow();
    // The post-teardown hide changed nothing — no second finish on an already-cancelled transaction.
    expect((started[0]?.finish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(cancelled);
  });

  it('works without a network source (no keepAlive wiring)', () => {
    const source = navSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    collectNavigations({ source, api, env: fakeEnv().env, timer: t.timer, idleTimeoutMs: 1000 });
    source.emit('navigate', detail({ to: '/x' }));
    t.fire(1000);
    expect(started[0]?.finish).toHaveBeenCalledWith('OK');
  });

  it('uses the default idle timeouts + the global timer when none are injected', () => {
    vi.useFakeTimers();
    try {
      const source = navSource();
      const { api, started } = fakeApi();
      collectNavigations({ source, api }); // no timer / timeouts / env → all defaults (realWebVitalsEnv)
      source.emit('navigate', detail({ to: '/x' }));
      vi.advanceTimersByTime(1000); // the default idle timeout (1000)
      expect(started[0]?.finish).toHaveBeenCalledWith('OK');
    } finally {
      vi.useRealTimers();
    }
  });
});
