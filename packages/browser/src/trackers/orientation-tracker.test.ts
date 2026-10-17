import { describe, expect, it, vi } from 'vitest';
import { OrientationTracker } from './orientation-tracker';

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

describe('OrientationTracker', () => {
  it('attaches nothing until the first subscriber', () => {
    const win = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    new OrientationTracker({ window: win, screen: { orientation } });
    expect(win.count() + orientation.count()).toBe(0);
  });

  it('listens to screen.orientation change AND window orientationchange; releases both on the last unsubscribe', () => {
    const win = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    const t = new OrientationTracker({ window: win, screen: { orientation } });
    const offA = t.on('state', () => {});
    const offB = t.on('state', () => {});
    expect(orientation.count()).toBe(1);
    expect(win.count()).toBe(1);
    offA();
    expect(orientation.count() + win.count()).toBe(2);
    offB();
    expect(orientation.count() + win.count()).toBe(0);
  });

  it('emits the current {type, angle} on each change', () => {
    const win = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    const t = new OrientationTracker({ window: win, screen: { orientation } });
    const seen: unknown[] = [];
    t.on('state', (s) => seen.push(s));
    orientation.type = 'landscape-primary';
    orientation.angle = 90;
    orientation.fire('change');
    orientation.type = 'landscape-secondary';
    orientation.angle = 270;
    win.fire('orientationchange');
    expect(seen).toEqual([
      { type: 'landscape-primary', angle: 90 },
      { type: 'landscape-secondary', angle: 270 },
    ]);
  });

  it('current() is the live orientation; undefined when the engine has no screen.orientation', () => {
    expect(
      new OrientationTracker({
        screen: { orientation: { type: 'portrait-secondary', angle: 180 } },
      }).current(),
    ).toEqual({ type: 'portrait-secondary', angle: 180 });
    expect(new OrientationTracker({ screen: {} }).current()).toBeUndefined();
    expect(new OrientationTracker({}).current()).toBeUndefined();
  });

  it('tolerates an orientation object that cannot take listeners', () => {
    const win = mkTarget();
    const t = new OrientationTracker({
      window: win,
      screen: { orientation: { type: 'portrait-primary', angle: 0 } },
    });
    const off = t.on('state', () => {});
    expect(win.count()).toBe(1);
    off();
    expect(win.count()).toBe(0);
  });

  it('a throwing getter in the event path is reported, not thrown; current() likewise', () => {
    const win = mkTarget();
    const onError = vi.fn();
    const screen = {
      get orientation(): never {
        throw new Error('getter');
      },
    };
    const t = new OrientationTracker({ window: win, screen }, onError);
    t.on('state', () => {});
    expect(() => win.fire('orientationchange')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(t.current()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a throwing removeEventListener does not leak the other listener', () => {
    const win = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    orientation.removeEventListener = () => {
      throw new Error('detached');
    };
    const t = new OrientationTracker({ window: win, screen: { orientation } });
    const off = t.on('state', () => {});
    expect(() => off()).not.toThrow();
    expect(win.count()).toBe(0);
  });

  it('an event whose read throws (orientation getter fails after activation) is reported, never thrown', () => {
    const win = mkTarget();
    const onError = vi.fn();
    let reads = 0;
    const live = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    const screen = {
      get orientation() {
        reads += 1;
        if (reads > 1) throw new Error('getter'); // activation reads it once
        return live;
      },
    };
    const t = new OrientationTracker({ window: win, screen }, onError);
    const seen: unknown[] = [];
    t.on('state', (s) => seen.push(s));
    expect(() => live.fire('change')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it('an event that finds no orientation anymore emits nothing', () => {
    const win = mkTarget();
    const live = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    let gone = false;
    const screen = {
      get orientation() {
        return gone ? undefined : live;
      },
    };
    const t = new OrientationTracker({ window: win, screen });
    const seen: unknown[] = [];
    t.on('state', (s) => seen.push(s));
    gone = true;
    live.fire('change');
    win.fire('orientationchange');
    expect(seen).toEqual([]);
  });

  it('removes each listener exactly once per activation cycle (no stale entries replayed on a later stop)', () => {
    const win = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    const removes = vi.fn();
    const realRemove = orientation.removeEventListener;
    orientation.removeEventListener = (t, f) => {
      removes(t);
      realRemove(t, f);
    };
    const t = new OrientationTracker({ window: win, screen: { orientation } });
    t.on('state', () => {})();
    t.on('state', () => {})();
    expect(removes).toHaveBeenCalledTimes(2);
  });
});
