import { describe, expect, it, vi } from 'vitest';
import { ConnectionTracker } from './connection-tracker';
import { PageLifecycleTracker } from './page-lifecycle-tracker';

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

describe('ConnectionTracker', () => {
  it('attaches nothing until the first subscriber', () => {
    const win = mkTarget();
    const connection = mkTarget();
    new ConnectionTracker({ window: win, navigator: { onLine: true, connection } });
    expect(win.count() + connection.count()).toBe(0);
  });

  it('listens to online/offline on the window and change on navigator.connection; releases all on the last unsubscribe', () => {
    const win = mkTarget();
    const connection = mkTarget();
    const t = new ConnectionTracker({ window: win, navigator: { onLine: true, connection } });
    const offA = t.on('state', () => {});
    const offB = t.on('state', () => {});
    expect(win.count()).toBe(2);
    expect(connection.count()).toBe(1);
    offA();
    expect(win.count() + connection.count()).toBe(3);
    offB();
    expect(win.count() + connection.count()).toBe(0);
  });

  it('emits a fresh snapshot of onLine + NetworkInformation on each event', () => {
    const win = mkTarget();
    const nav = {
      onLine: true,
      connection: {
        ...mkTarget(),
        type: 'wifi',
        effectiveType: '4g',
        downlink: 10,
        rtt: 50,
        saveData: false,
      },
    };
    const t = new ConnectionTracker({ window: win, navigator: nav });
    const seen: unknown[] = [];
    t.on('state', (s) => seen.push(s));
    nav.onLine = false;
    win.fire('offline');
    nav.onLine = true;
    nav.connection.rtt = 120;
    nav.connection.fire('change');
    expect(seen).toEqual([
      {
        onLine: false,
        connection: { type: 'wifi', effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
      },
      {
        onLine: true,
        connection: { type: 'wifi', effectiveType: '4g', downlink: 10, rtt: 120, saveData: false },
      },
    ]);
  });

  it('online fires the same snapshot path as offline', () => {
    const win = mkTarget();
    const nav = { onLine: false };
    const t = new ConnectionTracker({ window: win, navigator: nav });
    const seen: unknown[] = [];
    t.on('state', (s) => seen.push(s));
    nav.onLine = true;
    win.fire('online');
    expect(seen).toEqual([{ onLine: true }]);
  });

  it('current() is the live snapshot; onLine defaults to true when the browser does not say; undefined with no navigator', () => {
    expect(
      new ConnectionTracker({ navigator: { connection: { type: 'cellular' } } }).current(),
    ).toEqual({ onLine: true, connection: { type: 'cellular' } });
    expect(new ConnectionTracker({ navigator: { onLine: false } }).current()).toEqual({
      onLine: false,
    });
    expect(new ConnectionTracker({}).current()).toBeUndefined();
  });

  it('omits absent NetworkInformation fields instead of carrying undefined', () => {
    const c = new ConnectionTracker({
      navigator: { onLine: true, connection: { effectiveType: '3g' } },
    }).current();
    expect(c?.connection).toEqual({ effectiveType: '3g' });
    expect(Object.keys(c?.connection ?? {})).toEqual(['effectiveType']);
  });

  it('works with no window and a connection that cannot take listeners (Safari/Firefox)', () => {
    const onError = vi.fn();
    const t = new ConnectionTracker(
      { navigator: { onLine: true, connection: { type: 'wifi' } } },
      onError,
    );
    const off = t.on('state', () => {});
    expect(() => off()).not.toThrow();
    expect(onError).not.toHaveBeenCalled(); // skipped quietly, not a swallowed TypeError
  });

  it('a throwing getter in the event path is reported, never thrown into the browser', () => {
    const win = mkTarget();
    const onError = vi.fn();
    const nav = {
      get onLine(): boolean {
        throw new Error('getter');
      },
    };
    const t = new ConnectionTracker({ window: win, navigator: nav }, onError);
    t.on('state', () => {});
    expect(() => win.fire('offline')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(t.current()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a throwing removeEventListener does not leak the other listeners', () => {
    const win = mkTarget();
    const connection = mkTarget();
    const realRemove = win.removeEventListener;
    win.removeEventListener = (t, f) => {
      if (t === 'online') throw new Error('detached');
      realRemove(t, f);
    };
    const t = new ConnectionTracker({ window: win, navigator: { onLine: true, connection } });
    const off = t.on('state', () => {});
    expect(() => off()).not.toThrow();
    expect(connection.count()).toBe(0);
    expect(win.count()).toBe(1); // only the one whose removal threw is left
  });

  it('a throwing navigator.connection getter at activation is reported, not thrown out of on(); what attached is released', () => {
    const win = mkTarget();
    const onError = vi.fn();
    const nav = {
      onLine: true,
      get connection(): never {
        throw new Error('getter');
      },
    };
    const t = new ConnectionTracker({ window: win, navigator: nav }, onError);
    let off: (() => void) | undefined;
    expect(() => {
      off = t.on('state', () => {});
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(win.count()).toBe(2); // online/offline attached before the throw
    off?.();
    expect(win.count()).toBe(0);
  });

  it('removes each listener exactly once per activation cycle (no stale entries replayed on a later stop)', () => {
    const win = mkTarget();
    const removes = vi.fn();
    const realRemove = win.removeEventListener;
    win.removeEventListener = (t, f) => {
      removes(t);
      realRemove(t, f);
    };
    const t = new ConnectionTracker({ window: win, navigator: { onLine: true } });
    t.on('state', () => {})();
    t.on('state', () => {})();
    expect(removes).toHaveBeenCalledTimes(4); // online + offline, twice
  });

  it('an online/offline event with no navigator to read emits nothing', () => {
    const win = mkTarget();
    const t = new ConnectionTracker({ window: win });
    const seen = vi.fn();
    t.on('state', seen);
    win.fire('online');
    expect(seen).not.toHaveBeenCalled();
  });

  it('with a shared lifecycle it takes online/offline from it and attaches NO window listener of its own', () => {
    const win = mkTarget();
    const connection = mkTarget();
    const lifecycle = new PageLifecycleTracker({ window: win as never });
    const t = new ConnectionTracker({
      lifecycle,
      window: win,
      navigator: { onLine: true, connection },
    });
    const seen: unknown[] = [];
    const off = t.on('state', (s) => seen.push(s));
    expect(win.count()).toBe(4); // the lifecycle's own four window listeners; the tracker added none
    expect(connection.count()).toBe(1);
    win.fire('online');
    win.fire('offline');
    expect(seen).toHaveLength(2);
    off();
    expect(win.count() + connection.count()).toBe(0);
  });
});
