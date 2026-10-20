import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectivityState,
  ConnectivityTracker,
  connectivityTrackerFor,
  type NetworkInfo,
  resetConnectivityTracker,
} from './connectivity-tracker';

function mkTarget() {
  const l = new Map<string, Set<() => void>>();
  return {
    addEventListener: (t: string, f: () => void) => {
      const s = l.get(t) ?? new Set<() => void>();
      s.add(f);
      l.set(t, s);
    },
    removeEventListener: (t: string, f: () => void) => void l.get(t)?.delete(f),
    fire: (t: string) =>
      l.get(t)?.forEach((f) => {
        f();
      }),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0),
  };
}
function mkNav(info?: Record<string, unknown>, onLine = true) {
  const connection = info === undefined ? undefined : Object.assign(mkTarget(), info);
  return { onLine, connection };
}

const wins: object[] = [];
function mkWin() {
  const w = mkTarget();
  wins.push(w);
  return w;
}
afterEach(() => {
  for (const w of wins.splice(0)) resetConnectivityTracker({ window: w });
});

describe('ConnectivityTracker', () => {
  it('reads online + every NetworkInformation field; omits absent ones', () => {
    const nav = mkNav({
      type: 'wifi',
      effectiveType: '4g',
      downlink: 10,
      downlinkMax: 100,
      rtt: 50,
      saveData: false,
    });
    expect(new ConnectivityTracker({ navigator: nav }).current()).toEqual({
      online: true,
      networkInfo: {
        type: 'wifi',
        effectiveType: '4g',
        downlink: 10,
        downlinkMax: 100,
        rtt: 50,
        saveData: false,
      },
    });
    expect(new ConnectivityTracker({ navigator: mkNav({ rtt: 5 }) }).current()).toEqual({
      online: true,
      networkInfo: { rtt: 5 },
    });
  });

  it('no NetworkInformation -> no networkInfo key; no navigator -> undefined', () => {
    expect(new ConnectivityTracker({ navigator: mkNav() }).current()).toEqual({ online: true });
    expect(new ConnectivityTracker({}).current()).toBeUndefined();
  });

  it('onLine false -> online false; anything but false counts as online', () => {
    expect(new ConnectivityTracker({ navigator: mkNav(undefined, false) }).current()?.online).toBe(
      false,
    );
    expect(new ConnectivityTracker({ navigator: {} }).current()?.online).toBe(true);
  });

  it('omits invalid / zero / non-finite values, never fabricates', () => {
    const nav = mkNav({
      type: '',
      effectiveType: 4,
      downlink: 0,
      downlinkMax: Infinity,
      rtt: -1,
      saveData: 'yes',
    });
    expect(new ConnectivityTracker({ navigator: nav }).current()).toEqual({
      online: true,
      networkInfo: {},
    });
    const nan = mkNav({ downlink: NaN, downlinkMax: 0, rtt: 0, saveData: true });
    expect(new ConnectivityTracker({ navigator: nan }).current()?.networkInfo).toEqual({
      saveData: true,
    });
  });

  it('a throwing getter costs only that field and is reported', () => {
    const onError = vi.fn();
    const connection = Object.assign(mkTarget(), { type: 'wifi' });
    Object.defineProperty(connection, 'rtt', {
      get() {
        throw new Error('rtt boom');
      },
    });
    const t = new ConnectivityTracker({ navigator: { onLine: true, connection } }, onError);
    expect(t.current()?.networkInfo).toEqual({ type: 'wifi' });
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('rtt boom');
  });

  it('a throwing onLine getter is NOT online: the value is omitted, nothing fabricated, and it is reported', () => {
    const onError = vi.fn();
    const nav = {};
    Object.defineProperty(nav, 'onLine', {
      get() {
        throw new Error('online boom');
      },
    });
    const win = mkTarget();
    const t = new ConnectivityTracker({ window: win, navigator: nav }, onError);
    expect(t.current()).toEqual({});
    expect(onError).toHaveBeenCalledTimes(1);
    const online: unknown[] = [];
    const states: unknown[] = [];
    t.on('online', (e) => online.push(e));
    t.on('state', (s) => states.push(s));
    win.fire('offline');
    expect(online).toEqual([{ online: false }]); // the event is the evidence; never a fabricated true
    expect(states).toEqual([{ online: false }]);
  });

  it('a throwing navigator.connection getter degrades to online-only and is reported once per read', () => {
    const onError = vi.fn();
    const nav = { onLine: true };
    Object.defineProperty(nav, 'connection', {
      get() {
        throw new Error('conn boom');
      },
    });
    const win = mkTarget();
    const t = new ConnectivityTracker({ window: win, navigator: nav }, onError);
    expect(t.current()).toEqual({ online: true });
    expect(onError).toHaveBeenCalledTimes(1);
    onError.mockClear();
    const off = t.on('state', () => {});
    expect(win.count()).toBe(2); // window listeners still attach
    expect(onError).toHaveBeenCalledTimes(2); // activation: listener lookup + baseline read
    off();
  });

  it('when onLine is unreadable, the offline/online EVENT itself is the evidence', () => {
    const nav = {};
    Object.defineProperty(nav, 'onLine', {
      get() {
        throw new Error('online boom');
      },
    });
    const win = mkTarget();
    const t = new ConnectivityTracker({ window: win, navigator: nav });
    const online: boolean[] = [];
    const states: unknown[] = [];
    t.on('online', (e) => online.push(e.online)); // baseline: unreadable -> nothing
    t.on('state', (s) => states.push(s));
    win.fire('offline');
    win.fire('online');
    expect(online).toEqual([false, true]);
    expect(states).toEqual([{ online: false }, { online: true }]);
  });

  it('a readable onLine wins over the event hint', () => {
    const win = mkTarget();
    const nav = { onLine: true };
    const t = new ConnectivityTracker({ window: win, navigator: nav });
    const online: boolean[] = [];
    t.on('online', (e) => online.push(e.online));
    win.fire('offline'); // stale event, the browser says online
    expect(online).toEqual([true, true]);
  });

  it('a throwing addEventListener READ (cross-origin proxy) is reported and does not stop the other listeners', () => {
    const onError = vi.fn();
    const conn = mkTarget();
    const win = {};
    Object.defineProperty(win, 'addEventListener', {
      get() {
        throw new Error('SecurityError');
      },
    });
    const t = new ConnectivityTracker(
      {
        window: win,
        navigator: { onLine: true, connection: Object.assign(conn, { type: 'wifi' }) },
      },
      onError,
    );
    expect(() => t.on('state', () => {})).not.toThrow();
    expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toEqual([
      'SecurityError',
      'SecurityError',
    ]); // online + offline
    expect(conn.count()).toBe(1);
  });

  it('an absent onLine property is treated as online (old behavior)', () => {
    expect(new ConnectivityTracker({ navigator: {} }).current()).toEqual({ online: true });
  });

  it('a throwing onError never escapes', () => {
    const nav = {};
    Object.defineProperty(nav, 'onLine', {
      get() {
        throw new Error('x');
      },
    });
    const t = new ConnectivityTracker({ navigator: nav }, () => {
      throw new Error('reporter');
    });
    expect(() => t.current()).not.toThrow();
  });

  it('emits online / state on online+offline events', () => {
    const win = mkWin() as ReturnType<typeof mkTarget>;
    const nav = mkNav({ type: 'wifi' });
    const t = new ConnectivityTracker({ window: win, navigator: nav });
    const online: boolean[] = [];
    const states: ConnectivityState[] = [];
    t.on('online', (e) => online.push(e.online));
    t.on('state', (s) => states.push(s));
    expect(online).toEqual([true]); // baseline
    nav.onLine = false;
    win.fire('offline');
    nav.onLine = true;
    win.fire('online');
    expect(online).toEqual([true, false, true]);
    expect(states.map((s) => s.online)).toEqual([false, true]); // subscribed after the baseline
  });

  it('emits networkInfo / state on connection change', () => {
    const nav = mkNav({ effectiveType: '4g', downlink: 10 });
    const t = new ConnectivityTracker({ window: mkWin(), navigator: nav });
    const infos: NetworkInfo[] = [];
    const states: ConnectivityState[] = [];
    t.on('networkInfo', (i) => infos.push(i));
    t.on('state', (s) => states.push(s));
    Object.assign(nav.connection as object, { effectiveType: '3g', downlink: 1.5, downlinkMax: 7 });
    (nav.connection as ReturnType<typeof mkTarget>).fire('change');
    expect(infos).toEqual([
      { effectiveType: '4g', downlink: 10 },
      { effectiveType: '3g', downlink: 1.5, downlinkMax: 7 },
    ]);
    expect(states.at(-1)).toEqual({ online: true, networkInfo: infos[1] });
    expect(states).toHaveLength(1);
  });

  it('online/offline events with a connection present emit online + state but NOT networkInfo', () => {
    const win = mkWin() as ReturnType<typeof mkTarget>;
    const t = new ConnectivityTracker({ window: win, navigator: mkNav({ type: 'wifi' }) });
    const infos: NetworkInfo[] = [];
    const online: boolean[] = [];
    t.on('online', (e) => online.push(e.online)); // activates; the baseline is already gone
    t.on('networkInfo', (i) => infos.push(i));
    win.fire('offline');
    win.fire('online');
    expect(online).toEqual([true, true, true]); // baseline + 2 events
    expect(infos).toEqual([]);
  });

  it('a connection change after navigator.connection vanished emits no networkInfo', () => {
    const nav = mkNav({ type: 'wifi' });
    const conn = nav.connection as ReturnType<typeof mkTarget>;
    const t = new ConnectivityTracker({ navigator: nav });
    const infos: NetworkInfo[] = [];
    t.on('networkInfo', (i) => infos.push(i));
    nav.connection = undefined;
    conn.fire('change');
    expect(infos).toHaveLength(1); // the baseline only
  });

  it('listeners attach only while subscribed and are fully released', () => {
    const win = mkWin() as ReturnType<typeof mkTarget>;
    const nav = mkNav({ type: 'wifi' });
    const conn = nav.connection as ReturnType<typeof mkTarget>;
    const t = new ConnectivityTracker({ window: win, navigator: nav });
    expect(win.count() + conn.count()).toBe(0);
    const off = t.on('online', () => {});
    expect(win.count()).toBe(2);
    expect(conn.count()).toBe(1);
    off();
    expect(win.count() + conn.count()).toBe(0);
  });

  it('retention: nothing is lost across the last unsubscribe; a later subscriber gets a fresh baseline', () => {
    const win = mkWin() as ReturnType<typeof mkTarget>;
    const nav = mkNav({ type: 'wifi' });
    const t = new ConnectivityTracker({ window: win, navigator: nav });
    const off = t.on('state', () => {});
    off();
    nav.onLine = false; // changed while nobody listened
    const seen: ConnectivityState[] = [];
    t.on('state', (s) => seen.push(s));
    expect(seen).toEqual([{ online: false, networkInfo: { type: 'wifi' } }]);
  });

  it('no navigator but window events: a firing event emits nothing', () => {
    const win = mkTarget();
    const t = new ConnectivityTracker({ window: win });
    const seen: unknown[] = [];
    t.on('state', (s) => seen.push(s));
    win.fire('online');
    expect(seen).toEqual([]);
  });

  it('a refused addEventListener is reported once; the listeners that did attach stay attached and are released on stop', () => {
    const onError = vi.fn();
    const conn = mkTarget();
    const online = new Set<() => void>();
    const win = {
      addEventListener: (type: string, f: () => void) => {
        if (type === 'offline') throw new Error('add refused');
        online.add(f);
      },
      removeEventListener: (_type: string, f: () => void) => void online.delete(f),
    };
    const nav = { onLine: true, connection: Object.assign(conn, { type: 'wifi' }) };
    const t = new ConnectivityTracker({ window: win, navigator: nav }, onError);
    const off = t.on('state', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('add refused');
    expect(online.size).toBe(1); // not dead: online stays attached
    expect(conn.count()).toBe(1); // and the connection listener after the refusal still attached
    off();
    expect(online.size).toBe(0);
    expect(conn.count()).toBe(0);
  });

  it('a throwing reporter on a refused addEventListener never escapes on()', () => {
    const win = {
      addEventListener: () => {
        throw new Error('add refused');
      },
      removeEventListener: () => {},
    };
    const t = new ConnectivityTracker({ window: win, navigator: mkNav() }, () => {
      throw new Error('reporter');
    });
    expect(() => t.on('state', () => {})).not.toThrow();
  });

  it('a removeEventListener that throws does not leak the other targets', () => {
    const conn = mkTarget();
    const win = {
      addEventListener: () => {},
      removeEventListener: () => {
        throw new Error('gone');
      },
    };
    const t = new ConnectivityTracker({ window: win, navigator: { connection: conn } });
    const off = t.on('state', () => {});
    expect(conn.count()).toBe(1);
    off();
    expect(conn.count()).toBe(0);
  });

  it('a throwing subscriber AND a throwing onError never escape a DOM dispatch or the activation baseline', () => {
    const onError = vi.fn(() => {
      throw new Error('reporter');
    });
    const win = mkWin() as ReturnType<typeof mkTarget>;
    const t = new ConnectivityTracker({ window: win, navigator: mkNav() }, onError);
    let calls = 0;
    // The first call is the activation baseline.
    expect(() =>
      t.on('online', () => {
        calls += 1;
        throw new Error('subscriber');
      }),
    ).not.toThrow();
    expect(() => win.fire('offline')).not.toThrow();
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2); // both subscriber failures reached the (throwing) reporter
  });

  it('a throwing subscriber is reported through onError during dispatch', () => {
    const onError = vi.fn();
    const win = mkWin() as ReturnType<typeof mkTarget>;
    const t = new ConnectivityTracker({ window: win, navigator: mkNav() }, onError);
    t.on('online', () => {
      throw new Error('subscriber');
    });
    onError.mockClear();
    win.fire('offline');
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown as [Error])[0].message).toBe('subscriber');
  });

  it('a navigator without usable event targets still works (no connection listener)', () => {
    const t = new ConnectivityTracker({
      navigator: { onLine: true, connection: { type: 'wifi' } },
    });
    const seen: ConnectivityState[] = [];
    t.on('state', (s) => seen.push(s));
    expect(seen).toEqual([{ online: true, networkInfo: { type: 'wifi' } }]);
  });

  describe('rebind (latest launch wins, merge not drop)', () => {
    it('a defined onError replaces the reporter; undefined keeps it', () => {
      const first = vi.fn();
      const second = vi.fn();
      const nav = { onLine: true };
      Object.defineProperty(nav, 'connection', {
        get() {
          throw new Error('e');
        },
      });
      const t = new ConnectivityTracker({ navigator: nav }, first);
      t.rebind({}, second);
      t.current();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
      second.mockClear();
      t.rebind({});
      t.current();
      expect(second).toHaveBeenCalled();
    });

    it('a partial env never clobbers window/navigator; a defined one replaces', () => {
      const win = mkTarget();
      const nav = mkNav({ type: 'wifi' });
      const t = new ConnectivityTracker({ window: win, navigator: nav });
      t.rebind({});
      t.on('state', () => {});
      expect(win.count()).toBe(2);
      expect(t.current()?.networkInfo).toEqual({ type: 'wifi' });
    });

    it('a running tracker moves its listeners to a new window/navigator and re-reads', () => {
      const w1 = mkTarget();
      const n1 = mkNav({ type: 'wifi' });
      const t = new ConnectivityTracker({ window: w1, navigator: n1 });
      const seen: ConnectivityState[] = [];
      t.on('state', (s) => seen.push(s));
      const w2 = mkTarget();
      const n2 = mkNav({ type: 'cellular' }, false);
      t.rebind({ window: w2, navigator: n2 });
      expect(w1.count()).toBe(0);
      expect((n1.connection as ReturnType<typeof mkTarget>).count()).toBe(0);
      expect(w2.count()).toBe(2);
      expect((n2.connection as ReturnType<typeof mkTarget>).count()).toBe(1);
      expect(seen.at(-1)).toEqual({ online: false, networkInfo: { type: 'cellular' } });
    });

    it('a navigator-only rebind moves the connection listener and re-reads', () => {
      const win = mkTarget();
      const n1 = mkNav({ type: 'wifi' });
      const t = new ConnectivityTracker({ window: win, navigator: n1 });
      const seen: ConnectivityState[] = [];
      t.on('state', (s) => seen.push(s));
      const n2 = mkNav({ type: 'cellular' });
      t.rebind({ navigator: n2 });
      expect((n1.connection as ReturnType<typeof mkTarget>).count()).toBe(0);
      expect((n2.connection as ReturnType<typeof mkTarget>).count()).toBe(1);
      expect(win.count()).toBe(2);
      expect(seen.at(-1)?.networkInfo).toEqual({ type: 'cellular' });
    });

    it('rebinding the same objects while running does not re-attach or re-emit', () => {
      const w1 = mkTarget();
      const n1 = mkNav();
      const t = new ConnectivityTracker({ window: w1, navigator: n1 });
      const seen: unknown[] = [];
      t.on('state', (s) => seen.push(s));
      t.rebind({ window: w1, navigator: n1 });
      expect(seen).toHaveLength(1);
      expect(w1.count()).toBe(2);
    });

    it('a partial env on a running tracker does not re-attach or re-emit', () => {
      const w1 = mkTarget();
      const t = new ConnectivityTracker({ window: w1, navigator: mkNav() });
      const seen: unknown[] = [];
      t.on('state', (s) => seen.push(s));
      t.rebind({});
      expect(seen).toHaveLength(1);
      expect(w1.count()).toBe(2);
    });

    it('an idle tracker just adopts the new objects (no listeners)', () => {
      const w2 = mkTarget();
      const t = new ConnectivityTracker({ navigator: mkNav() });
      t.rebind({ window: w2 });
      expect(w2.count()).toBe(0);
      t.on('state', () => {});
      expect(w2.count()).toBe(2);
    });
  });

  it('reset() releases the listeners', () => {
    const win = mkTarget();
    const t = new ConnectivityTracker({ window: win });
    t.on('state', () => {});
    t.reset();
    expect(win.count()).toBe(0);
  });
});

describe('connectivityTrackerFor', () => {
  it('is one singleton per window; a different window gets its own', () => {
    const w = mkWin();
    const a = connectivityTrackerFor({ window: w });
    expect(connectivityTrackerFor({ window: w })).toBe(a);
    expect(connectivityTrackerFor({ window: mkWin() })).not.toBe(a);
  });

  it('keys on navigator without a window, else on the env object', () => {
    const nav = {};
    const a = connectivityTrackerFor({ navigator: nav });
    expect(connectivityTrackerFor({ navigator: nav })).toBe(a);
    const env = {};
    expect(connectivityTrackerFor(env)).toBe(connectivityTrackerFor(env));
    expect(connectivityTrackerFor({})).not.toBe(connectivityTrackerFor({}));
    resetConnectivityTracker({ navigator: nav });
  });

  it('a relaunch hands the shared tracker the latest onError and merges a partial env', () => {
    const w = mkWin();
    const nav = mkNav({ type: 'wifi' });
    const first = vi.fn();
    const second = vi.fn();
    const a = connectivityTrackerFor({ window: w, navigator: nav }, first);
    const b = connectivityTrackerFor({ window: w }, second);
    expect(b).toBe(a);
    expect(a.current()?.networkInfo).toEqual({ type: 'wifi' }); // navigator not dropped
    const broken = {};
    Object.defineProperty(broken, 'connection', {
      get() {
        throw new Error('late');
      },
    });
    connectivityTrackerFor({ window: w, navigator: broken }, second);
    a.current();
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });

  it('a throwing env.window getter is reported ONCE per call and reset still finds the tracker when the getter recovers', () => {
    const onError = vi.fn();
    const nav = mkNav({ type: 'wifi' });
    const w = mkTarget();
    let fail = true;
    const env = {
      get window() {
        if (fail) throw new Error('flaky');
        return w;
      },
      navigator: nav,
    };
    const t = connectivityTrackerFor(env, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    t.on('state', () => {});
    expect((nav.connection as ReturnType<typeof mkTarget>).count()).toBe(1);
    fail = false; // reset now resolves window first, but the tracker was keyed on navigator
    resetConnectivityTracker(env);
    expect((nav.connection as ReturnType<typeof mkTarget>).count()).toBe(0);
    expect(connectivityTrackerFor({ navigator: nav })).not.toBe(t);
    resetConnectivityTracker({ navigator: nav });
  });

  it('a throwing env.window / env.navigator read is reported and never fails', () => {
    const onError = vi.fn();
    const env = {};
    Object.defineProperty(env, 'window', {
      get() {
        throw new Error('win');
      },
    });
    Object.defineProperty(env, 'navigator', {
      get() {
        throw new Error('nav');
      },
    });
    expect(() => connectivityTrackerFor(env, onError)).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('resetConnectivityTracker releases the listeners and the next call builds a fresh one', () => {
    const w = mkWin() as ReturnType<typeof mkTarget>;
    const a = connectivityTrackerFor({ window: w, navigator: mkNav() });
    a.on('state', () => {});
    expect(w.count()).toBe(2);
    resetConnectivityTracker({ window: w });
    expect(w.count()).toBe(0);
    expect(connectivityTrackerFor({ window: w })).not.toBe(a);
  });
});
