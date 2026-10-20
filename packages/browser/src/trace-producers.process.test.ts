import type { TraceProducer } from '@bugsee/capture';
import { ApplicationTracker, ProcessTracker, resetProcessTracker } from '@bugsee/trackers/browser';
import { describe, expect, it, vi } from 'vitest';
import {
  browserTraceEnvFrom,
  createBrowserSystemTraceProducers,
  MainThreadIdleProducer,
  UserIdleProducer,
} from './trace-producers';

type Row = { name: string; value: unknown; hold: boolean | undefined };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function start(p: TraceProducer) {
  const out: Row[] = [];
  p.start({
    emit: (name: string, value: unknown, _d?: number, o?: { hold?: boolean }) =>
      void out.push({ name, value, hold: o?.hold }),
  });
  return out;
}

function mkTarget() {
  const l = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener: (t: string, f: (e: unknown) => void) => {
      const s = l.get(t) ?? new Set<(e: unknown) => void>();
      s.add(f);
      l.set(t, s);
    },
    removeEventListener: (t: string, f: (e: unknown) => void) => void l.get(t)?.delete(f),
  };
}

function mkDetector() {
  const listeners = new Set<() => void>();
  const d = {
    userState: 'active' as unknown,
    screenState: 'unlocked' as unknown,
    start: () => Promise.resolve(undefined as unknown),
    addEventListener: (_t: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => void listeners.delete(l),
    fire: () =>
      listeners.forEach((l) => {
        l();
      }),
  };
  return d;
}

function userIdleTracker(detector: ReturnType<typeof mkDetector>, state = 'granted') {
  class FakeDetector {
    constructor() {
      return detector as unknown as FakeDetector;
    }
  }
  return new ProcessTracker({
    navigator: { permissions: { query: () => Promise.resolve({ state }) } },
    IdleDetector: FakeDetector as never,
    AbortController: class {
      signal = {};
      abort() {}
    },
  });
}

describe('UserIdleProducer (user_idle_state)', () => {
  it('maps userState to a string; a locked screen wins; held and de-duplicated', async () => {
    const detector = mkDetector();
    const out = start(new UserIdleProducer(userIdleTracker(detector)));
    await flush();
    expect(out).toEqual([{ name: 'user_idle_state', value: 'active', hold: true }]);
    detector.fire(); // unchanged
    detector.userState = 'idle';
    detector.fire();
    detector.screenState = 'locked';
    detector.fire();
    detector.userState = 'active'; // locked still wins
    detector.fire();
    detector.screenState = 'unlocked';
    detector.fire();
    expect(out.map((r) => r.value)).toEqual(['active', 'idle', 'locked', 'active']);
  });

  it('a state without a screenState is just the userState', async () => {
    const detector = mkDetector();
    detector.screenState = undefined;
    detector.userState = 'idle';
    const out = start(new UserIdleProducer(userIdleTracker(detector)));
    await flush();
    expect(out.map((r) => r.value)).toEqual(['idle']);
  });

  it('produces NO trace unless the permission is already granted', async () => {
    for (const state of ['prompt', 'denied']) {
      const out = start(new UserIdleProducer(userIdleTracker(mkDetector(), state)));
      await flush();
      expect(out).toEqual([]);
    }
  });

  it('seeds from the retained state and releases on stop', async () => {
    const detector = mkDetector();
    const tracker = userIdleTracker(detector);
    const offOther = tracker.on('userIdle', () => {});
    await flush();
    const p = new UserIdleProducer(tracker);
    const out = start(p);
    expect(out.map((r) => r.value)).toEqual(['active']); // immediate, from currentUserIdle()
    p.stop();
    detector.userState = 'idle';
    detector.fire();
    expect(out).toHaveLength(1);
    offOther();
  });
});

describe('MainThreadIdleProducer (main_thread_idle_ms)', () => {
  it('emits each granted idle period (polled, not held) and releases on stop', () => {
    const doc = { visibilityState: 'visible' };
    const lifecycle = new ApplicationTracker({ window: mkTarget(), document: mkTarget() });
    let tick: () => void = () => {};
    let grant: ((d: { timeRemaining(): number }) => void) | undefined;
    const clear = vi.fn();
    const tracker = new ProcessTracker({
      lifecycle,
      document: doc,
      requestIdleCallback: (cb) => {
        grant = cb;
        return 1;
      },
      scheduler: {
        setInterval: (cb) => {
          tick = cb;
          return 9;
        },
        clearInterval: clear,
      },
    });
    const p = new MainThreadIdleProducer(tracker);
    const out = start(p);
    expect(out).toEqual([]);
    tick();
    grant?.({ timeRemaining: () => 42 });
    expect(out).toEqual([{ name: 'main_thread_idle_ms', value: 42, hold: false }]);
    p.stop();
    expect(clear).toHaveBeenCalledWith(9);
  });
});

describe('createBrowserSystemTraceProducers: process traces', () => {
  it('builds main-thread-idle with a lifecycle (like lag/fps) and user-idle always; none under sensors:false', () => {
    const lifecycle = new ApplicationTracker({ window: mkTarget() });
    const names = (e: Parameters<typeof createBrowserSystemTraceProducers>[0]) =>
      createBrowserSystemTraceProducers(e).map((p) => p.name);
    expect(names({ lifecycle })).toEqual(
      expect.arrayContaining(['main-thread-lag', 'main-thread-idle', 'user-idle']),
    );
    expect(names({})).toEqual(expect.arrayContaining(['user-idle']));
    expect(names({})).not.toEqual(expect.arrayContaining(['main-thread-idle']));
    expect(names({ lifecycle, sensors: false })).toEqual(['battery']);
  });

  it('browserTraceEnvFrom binds requestIdleCallback/cancelIdleCallback to the window and passes IdleDetector/AbortController', () => {
    const calls: string[] = [];
    const win = {
      requestIdleCallback(this: unknown, cb: () => void): number {
        calls.push(this === win ? 'ric:window' : 'ric:other');
        cb();
        return 3;
      },
      cancelIdleCallback(this: unknown, h: number): void {
        calls.push(this === win ? `cic:window:${h}` : 'cic:other');
      },
      IdleDetector: class {},
      AbortController: class {},
    };
    const env = browserTraceEnvFrom(win, undefined);
    const { requestIdleCallback: ric, cancelIdleCallback: cic } = env;
    expect(ric?.(() => {})).toBe(3);
    cic?.(3);
    expect(calls).toEqual(['ric:window', 'cic:window:3']);
    expect(env.IdleDetector).toBe(win.IdleDetector);
    expect(env.AbortController).toBe(win.AbortController);
    // absent surfaces stay absent; hostile getters are reported, never thrown
    const bare = browserTraceEnvFrom({}, undefined);
    expect(bare.requestIdleCallback).toBeUndefined();
    expect(bare.IdleDetector).toBeUndefined();
    const errors: unknown[] = [];
    const hostile = {};
    Object.defineProperty(hostile, 'IdleDetector', {
      get(): never {
        throw new Error('blocked');
      },
    });
    expect(browserTraceEnvFrom(hostile, undefined, (e) => errors.push(e)).IdleDetector).toBe(
      undefined,
    );
    expect(errors).toHaveLength(1);
  });

  it('passes requestIdleCallback and cancelIdleCallback through: the probe is cancelled on stop', () => {
    const win = mkTarget();
    const lifecycle = new ApplicationTracker({ window: win });
    let tick: () => void = () => {};
    const cancel = vi.fn();
    const w = {};
    const ps = createBrowserSystemTraceProducers({
      window: w as never,
      document: { visibilityState: 'visible' },
      lifecycle,
      requestIdleCallback: () => 11,
      cancelIdleCallback: cancel,
      scheduler: {
        setInterval: (cb) => {
          tick = cb;
          return 1;
        },
        clearInterval: () => {},
      },
    });
    try {
      const idle = ps.find((p) => p.name === 'main-thread-idle') as TraceProducer;
      start(idle);
      tick();
      idle.stop();
      expect(cancel).toHaveBeenCalledWith(11);
    } finally {
      resetProcessTracker({ window: w });
    }
  });

  it('all process traces share ONE tracker per window and the env seams reach it (idle + user idle)', async () => {
    const win = Object.assign(mkTarget(), {
      performance: {
        memory: { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 },
        now: () => 1,
      },
    });
    const detector = mkDetector();
    class FakeDetector {
      constructor() {
        return detector as unknown as FakeDetector;
      }
    }
    const lifecycle = new ApplicationTracker({ window: win });
    try {
      const ps = createBrowserSystemTraceProducers({
        ...browserTraceEnvFrom(win, undefined),
        window: win,
        lifecycle,
        navigator: { permissions: { query: () => Promise.resolve({ state: 'granted' }) } },
        IdleDetector: FakeDetector as never,
        AbortController: class {
          signal = {};
          abort() {}
        },
      });
      const userIdle = ps.find((p) => p.name === 'user-idle') as TraceProducer;
      const memory = ps.find((p) => p.name === 'memory') as TraceProducer;
      const outUser = start(userIdle);
      const outMem = start(memory);
      await flush();
      expect(outUser.map((r) => r.value)).toEqual(['active']);
      expect(outMem.map((r) => r.name)).toEqual([
        'ram_js_heap_total',
        'ram_js_heap_free',
        'ram_js_heap_used',
      ]);
    } finally {
      resetProcessTracker({ window: win });
    }
  });
});
