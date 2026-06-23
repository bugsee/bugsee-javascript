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
  };
  return { api, started };
}

// A fake WebVitalsEnv whose document visibility can be flipped + fired (for onHidden background-cancel).
function fakeEnv() {
  const docListeners = new Map<string, () => void>();
  let visibilityState = 'visible';
  const env = {
    document: {
      addEventListener: (t: string, l: () => void) => docListeners.set(t, l),
      get visibilityState() {
        return visibilityState;
      },
    },
    window: { addEventListener: () => {} },
  } as unknown as WebVitalsEnv;
  return {
    env,
    fireHidden: () => {
      visibilityState = 'hidden';
      docListeners.get('visibilitychange')?.();
    },
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
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('nav.source', 'url');
    expect(started[0]?.setAttribute).toHaveBeenCalledWith('nav.type', 'push');
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

  it('teardown cancels the in-flight navigation and ignores later events', () => {
    const source = navSource();
    const network = netSource();
    const { api, started } = fakeApi();
    const t = fakeTimer();
    const stop = collectNavigations({
      source,
      api,
      networkSource: network,
      env: fakeEnv().env,
      timer: t.timer,
    });
    source.emit('navigate', detail({ to: '/x' }));
    stop();
    expect(started[0]?.finish).toHaveBeenCalledWith('CANCELLED'); // in-flight nav cancelled on teardown
    // after teardown, further events are ignored (no new transaction, no extra finish)
    source.emit('navigate', detail({ to: '/y' }));
    network.emit('before', { id: 'r', timestamp: 0 } as unknown as NetworkEvent);
    expect(api.startTransaction).toHaveBeenCalledTimes(1);
    expect(started[0]?.finish).toHaveBeenCalledTimes(1);
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
