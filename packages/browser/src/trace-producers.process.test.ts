import type { TraceProducer } from '@bugsee/capture';
import {
  ApplicationTracker,
  ProcessTracker,
  processTrackerFor,
  resetProcessTracker,
  resetUiTracker,
  uiTrackerFor,
} from '@bugsee/trackers/browser';
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

function userIdleTracker(
  detector: ReturnType<typeof mkDetector>,
  state = 'granted',
  now?: () => number,
  permission?: { state: string },
  probe?: { statusListeners: Set<() => void>; aborts: number },
) {
  class FakeDetector {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a test double hands the shared fake detector back from `new`.
      return detector as unknown as FakeDetector;
    }
  }
  return new ProcessTracker({
    navigator: {
      permissions: {
        query: () =>
          Promise.resolve({
            state: permission?.state ?? state,
            addEventListener: (_t: string, l: () => void) => void probe?.statusListeners.add(l),
            removeEventListener: (_t: string, l: () => void) =>
              void probe?.statusListeners.delete(l),
          }),
      },
    },
    IdleDetector: FakeDetector as never,
    AbortController: class {
      signal = {};
      abort() {
        if (probe !== undefined) probe.aborts += 1;
      }
    },
    ...(now !== undefined ? { now } : {}),
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

describe('UserIdleProducer stop releases the stage', () => {
  it('stop() unsubscribes: detector aborted, permission listener removed, no growth over start/stop cycles', async () => {
    const detector = mkDetector();
    const probe = { statusListeners: new Set<() => void>(), aborts: 0 };
    const tracker = userIdleTracker(detector, 'granted', undefined, undefined, probe);
    const p = new UserIdleProducer(tracker);
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const out = start(p);
      await flush();
      expect(probe.statusListeners.size).toBe(1); // armed: exactly one permission listener, never accumulating
      expect(out.length).toBeGreaterThan(0);
      p.stop();
      expect(probe.statusListeners.size).toBe(0);
      expect(probe.aborts).toBe(cycle); // the detector of THIS cycle was aborted
      const seen = out.length;
      detector.userState = cycle % 2 === 0 ? 'active' : 'idle';
      detector.fire(); // a stopped producer hears nothing
      expect(out).toHaveLength(seen);
    }
  });
});

describe('UserIdleProducer seeding', () => {
  it('does not seed from a retained state while the permission re-query is pending; the live detector then reports it', async () => {
    const detector = mkDetector();
    const tracker = userIdleTracker(detector);
    const offOther = tracker.on('userIdle', () => {});
    await flush();
    offOther(); // the state is retained, the detector is released
    const p = new UserIdleProducer(tracker);
    const out = start(p);
    expect(out).toEqual([]); // the retained 'active' is NOT trusted before the permission is re-confirmed
    await flush();
    expect(out.map((r) => r.value)).toEqual(['active']); // the re-confirmed detector reports it
    p.stop();
  });

  it('a permission revoked while no stage was armed never seeds the held trace', async () => {
    const detector = mkDetector();
    const permission = { state: 'granted' };
    const tracker = userIdleTracker(detector, 'granted', undefined, permission);
    const offOther = tracker.on('userIdle', () => {});
    await flush();
    offOther();
    permission.state = 'denied'; // revoked while nobody listens
    const p = new UserIdleProducer(tracker);
    const out = start(p);
    expect(out).toEqual([]);
    await flush();
    expect(out).toEqual([]); // and the re-query dropped the snapshot: nothing is ever published
    expect(tracker.currentUserIdle()).toBeUndefined();
    p.stop();
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
  it('builds main-thread-idle with a lifecycle (like lag/fps); user-idle ONLY on opt-in; none under sensors:false', () => {
    const lifecycle = new ApplicationTracker({ window: mkTarget() });
    const names = (e: Parameters<typeof createBrowserSystemTraceProducers>[0]) =>
      createBrowserSystemTraceProducers(e).map((p) => p.name);
    expect(names({ lifecycle })).toEqual(
      expect.arrayContaining(['main-thread-lag', 'main-thread-idle']),
    );
    // user_idle_state is behavioural data: OFF unless the caller opts in with exactly `true` (the SDK never
    // prompts, and a host page's own idle-detection grant is not consent to record it)
    expect(names({ lifecycle })).not.toContain('user-idle');
    expect(names({})).not.toContain('user-idle');
    expect(names({ captureUserIdle: false })).not.toContain('user-idle');
    expect(names({ captureUserIdle: 'true' as never })).not.toContain('user-idle');
    expect(names({ captureUserIdle: true })).toContain('user-idle');
    expect(names({ lifecycle, captureUserIdle: true })).toContain('user-idle');
    expect(names({ lifecycle, captureUserIdle: true, sensors: false })).toEqual(['battery']);
    expect(names({})).not.toEqual(expect.arrayContaining(['main-thread-idle']));
    expect(names({ lifecycle, sensors: false })).toEqual(['battery']);
  });

  it('browserTraceEnvFrom hands back the SAME bound closures for the same window (a no-op relaunch stays a no-op), distinct ones per window', () => {
    const mk = () => ({
      requestIdleCallback: () => 1,
      cancelIdleCallback: () => {},
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    });
    const win = mk();
    const a = browserTraceEnvFrom(win, undefined);
    const b = browserTraceEnvFrom(win, undefined);
    expect(b.requestIdleCallback).toBe(a.requestIdleCallback);
    expect(b.cancelIdleCallback).toBe(a.cancelIdleCallback);
    expect(b.requestAnimationFrame).toBe(a.requestAnimationFrame);
    expect(b.cancelAnimationFrame).toBe(a.cancelAnimationFrame);
    const other = browserTraceEnvFrom(mk(), undefined);
    expect(other.requestIdleCallback).not.toBe(a.requestIdleCallback);
    // the same function on a DIFFERENT window is bound to that window
    const shared = function (this: unknown) {
      return this;
    };
    const w1 = { requestIdleCallback: shared };
    const w2 = { requestIdleCallback: shared };
    const r1 = browserTraceEnvFrom(w1, undefined).requestIdleCallback as unknown as () => unknown;
    const r2 = browserTraceEnvFrom(w2, undefined).requestIdleCallback as unknown as () => unknown;
    expect(r1()).toBe(w1);
    expect(r2()).toBe(w2);
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

  it('the merged factory wires ui traces on the UiTracker and process traces on the ProcessTracker, each producer once', () => {
    const win = Object.assign(mkTarget(), {
      performance: { now: () => 1 },
      screen: { width: 1, height: 2 },
      devicePixelRatio: 1,
    });
    const lifecycle = new ApplicationTracker({ window: win });
    try {
      const ps = createBrowserSystemTraceProducers({
        ...browserTraceEnvFrom(win, undefined),
        window: win,
        lifecycle,
        captureUserIdle: true,
      });
      const names = ps.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length); // no producer twice (e.g. a second main-thread-lag)
      expect(names).toEqual(
        expect.arrayContaining([
          'memory',
          'user-idle',
          'main-thread-lag',
          'main-thread-idle',
          'orientation',
          'displays',
          'fps',
        ]),
      );
      expect(names.filter((n) => n === 'main-thread-lag')).toHaveLength(1);
      // both domain trackers are per-window singletons
      expect(uiTrackerFor({ window: win })).toBe(uiTrackerFor({ window: win }));
      expect(processTrackerFor({ window: win })).toBe(processTrackerFor({ window: win }));
    } finally {
      resetProcessTracker({ window: win });
      resetUiTracker({ window: win });
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
        // biome-ignore lint/correctness/noConstructorReturn: a test double hands the shared fake detector back from `new`.
        return detector as unknown as FakeDetector;
      }
    }
    const lifecycle = new ApplicationTracker({ window: win });
    try {
      const ps = createBrowserSystemTraceProducers({
        ...browserTraceEnvFrom(win, undefined),
        window: win,
        lifecycle,
        captureUserIdle: true,
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
      // ONE tracker serves both producers: the window's registry instance saw the user-idle subscription (it retained
      // the state) AND carries the heap seam, and a second lookup returns that same object.
      const shared = processTrackerFor({ window: win });
      expect(processTrackerFor({ window: win })).toBe(shared);
      expect(shared.currentUserIdle()).toEqual({ userState: 'active', screenState: 'unlocked' });
      expect(shared.currentHeap()).toEqual({ used: 1, limit: 3 });
    } finally {
      resetProcessTracker({ window: win });
    }
  });
});

describe('user_idle_state opt-in x permission (end to end through the factory)', () => {
  const run = async (env: { captureUserIdle?: boolean }, state: string) => {
    const win = Object.assign(mkTarget(), { performance: { now: () => 1 } });
    const detector = mkDetector();
    class FakeDetector {
      constructor() {
        // biome-ignore lint/correctness/noConstructorReturn: a test double hands the shared fake detector back from `new`.
        return detector as unknown as FakeDetector;
      }
    }
    const query = vi.fn(() => Promise.resolve({ state }));
    try {
      const ps = createBrowserSystemTraceProducers({
        ...browserTraceEnvFrom(win, undefined),
        window: win,
        ...env,
        navigator: { permissions: { query } },
        IdleDetector: FakeDetector as never,
        AbortController: class {
          signal = {};
          abort() {}
        },
      });
      const producer = ps.find((p) => p.name === 'user-idle');
      const out = producer === undefined ? [] : start(producer);
      await flush();
      return { out, query, hasProducer: producer !== undefined };
    } finally {
      resetProcessTracker({ window: win });
    }
  };

  it('off by default: no producer, no permission query, no trace, even with the permission granted', async () => {
    const r = await run({}, 'granted');
    expect(r.hasProducer).toBe(false);
    expect(r.query).not.toHaveBeenCalled();
    expect(r.out).toEqual([]);
  });

  it('opted in and already granted: the trace is produced', async () => {
    const r = await run({ captureUserIdle: true }, 'granted');
    expect(r.out.map((x) => x.value)).toEqual(['active']);
  });

  it.each([
    'prompt',
    'denied',
  ])('opted in but permission %s: no trace (the SDK never prompts)', async (state) => {
    const r = await run({ captureUserIdle: true }, state);
    expect(r.hasProducer).toBe(true);
    expect(r.query).toHaveBeenCalled();
    expect(r.out).toEqual([]);
  });
});
