import { describe, expect, it, vi } from 'vitest';
import { type BatteryManagerLike, type BatteryState, BatteryTracker } from './battery-tracker';

function mkManager(level = 0.5, charging = false) {
  const listeners = new Map<string, Set<() => void>>();
  const set = (t: string): Set<() => void> => {
    let s = listeners.get(t);
    if (s === undefined) {
      s = new Set();
      listeners.set(t, s);
    }
    return s;
  };
  return {
    level,
    charging,
    addEventListener: (t: string, l: () => void) => {
      set(t).add(l);
    },
    removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
    fire: (t: string) =>
      listeners.get(t)?.forEach((l) => {
        l();
      }),
    has: (t: string) => (listeners.get(t)?.size ?? 0) > 0,
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('BatteryTracker', () => {
  it('does not call getBattery at construction', () => {
    const getBattery = vi.fn();
    new BatteryTracker({ getBattery });
    expect(getBattery).not.toHaveBeenCalled();
  });

  it('calls getBattery once on the first subscriber only, then attaches listeners and emits state', async () => {
    const m = mkManager(0.5, true);
    const getBattery = vi.fn(() => Promise.resolve(m));
    const t = new BatteryTracker({ getBattery });
    const a: BatteryState[] = [];
    const b: BatteryState[] = [];
    t.on('state', (s) => a.push(s));
    t.on('state', (s) => b.push(s));
    expect(getBattery).toHaveBeenCalledTimes(1);
    expect(t.current()).toBeUndefined();
    await flush();
    expect(m.has('levelchange')).toBe(true);
    expect(m.has('chargingchange')).toBe(true);
    expect(a).toEqual([{ level: 0.5, charging: true }]);
    expect(b).toEqual(a);
    expect(t.current()).toEqual({ level: 0.5, charging: true });
  });

  it('re-emits the new state on levelchange and chargingchange', async () => {
    const m = mkManager(0.5, false);
    const t = new BatteryTracker({ getBattery: () => Promise.resolve(m) });
    const seen: BatteryState[] = [];
    t.on('state', (s) => seen.push(s));
    await flush();
    m.level = 0.4;
    m.fire('levelchange');
    m.charging = true;
    m.fire('chargingchange');
    expect(seen).toEqual([
      { level: 0.5, charging: false },
      { level: 0.4, charging: false },
      { level: 0.4, charging: true },
    ]);
    expect(t.current()).toEqual({ level: 0.4, charging: true });
  });

  it('last unsubscribe removes both listeners and clears current()', async () => {
    const m = mkManager();
    const t = new BatteryTracker({ getBattery: () => Promise.resolve(m) });
    const off1 = t.on('state', () => {});
    const off2 = t.on('state', () => {});
    await flush();
    off1();
    expect(m.count()).toBe(2);
    off2();
    expect(m.count()).toBe(0);
    expect(t.current()).toBeUndefined();
  });

  it('stop before resolve: the late resolve attaches nothing and emits nothing', async () => {
    const m = mkManager();
    let resolve: (v: BatteryManagerLike) => void = () => {};
    const t = new BatteryTracker({ getBattery: () => new Promise((r) => (resolve = r)) });
    const seen: BatteryState[] = [];
    const off = t.on('state', (s) => seen.push(s));
    off();
    resolve(m);
    await flush();
    expect(m.count()).toBe(0);
    expect(seen).toEqual([]);
    expect(t.current()).toBeUndefined();
  });

  it('stop -> start: the old promise resolving late is ignored, the new one applies', async () => {
    const oldM = mkManager(0.1);
    const newM = mkManager(0.9);
    const resolvers: Array<(v: BatteryManagerLike) => void> = [];
    const t = new BatteryTracker({
      getBattery: () => new Promise((r) => resolvers.push(r)),
    });
    const seen: BatteryState[] = [];
    t.on('state', (s) => seen.push(s))();
    t.on('state', (s) => seen.push(s));
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.(newM);
    await flush();
    resolvers[0]?.(oldM);
    await flush();
    expect(oldM.count()).toBe(0);
    expect(newM.count()).toBe(2);
    expect(seen).toEqual([{ level: 0.9, charging: false }]);
  });

  it('a rejecting getBattery neither throws nor emits', async () => {
    const t = new BatteryTracker({ getBattery: () => Promise.reject(new Error('denied')) });
    const seen: BatteryState[] = [];
    expect(() => t.on('state', (s) => seen.push(s))).not.toThrow();
    await flush();
    expect(seen).toEqual([]);
    expect(t.current()).toBeUndefined();
  });

  it('a synchronously throwing getBattery neither throws nor emits', () => {
    const t = new BatteryTracker({
      getBattery: () => {
        throw new Error('SecurityError');
      },
    });
    const seen: BatteryState[] = [];
    expect(() => t.on('state', (s) => seen.push(s))).not.toThrow();
    expect(seen).toEqual([]);
  });

  it('an env without getBattery is inert', () => {
    const t = new BatteryTracker({});
    expect(() => t.on('state', () => {})).not.toThrow();
    expect(t.current()).toBeUndefined();
  });

  it('a manager without addEventListener still emits the one baseline', async () => {
    const t = new BatteryTracker({
      getBattery: () => Promise.resolve({ level: 0.3, charging: true }),
    });
    const seen: BatteryState[] = [];
    const off = t.on('state', (s) => seen.push(s));
    await flush();
    expect(seen).toEqual([{ level: 0.3, charging: true }]);
    expect(() => off()).not.toThrow();
  });
});
