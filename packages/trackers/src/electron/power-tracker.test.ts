import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ElectronPowerTracker,
  electronPowerTrackerFor,
  type PowerMonitorSource,
  resetElectronPowerTracker,
} from './power-tracker';

type L = (...a: unknown[]) => void;
function fakeMonitor(over: Record<string, unknown> = {}) {
  const table = new Map<string, L[]>();
  const monitor = {
    on: vi.fn((e: string, l: L) => {
      table.set(e, [...(table.get(e) ?? []), l]);
    }),
    removeListener: vi.fn((e: string, l: L) => {
      table.set(
        e,
        (table.get(e) ?? []).filter((x) => x !== l),
      );
    }),
    isOnBatteryPower: vi.fn((): unknown => false),
    getCurrentThermalState: vi.fn((): unknown => 'nominal'),
    ...over,
  };
  return {
    monitor: monitor as PowerMonitorSource & typeof monitor,
    fire: (e: string, ...args: unknown[]) => {
      for (const l of [...(table.get(e) ?? [])]) l(...args);
    },
    count: (e: string) => table.get(e)?.length ?? 0,
    total: () => [...table.values()].reduce((n, l) => n + l.length, 0),
  };
}

const keys: object[] = [];
afterEach(() => {
  for (const k of keys.splice(0)) resetElectronPowerTracker(k);
});
const track = (m: ReturnType<typeof fakeMonitor>, onError?: (e: unknown) => unknown) => {
  keys.push(m.monitor);
  return electronPowerTrackerFor({ powerMonitor: m.monitor }, onError);
};

describe('ElectronPowerTracker', () => {
  it('attaches NOTHING until a stage has a listener', () => {
    const m = fakeMonitor();
    track(m);
    expect(m.monitor.on).not.toHaveBeenCalled();
  });

  it('suspendResume: maps suspend/resume, attaches only its own two events, releases on the last unsubscribe', () => {
    const m = fakeMonitor();
    const t = track(m);
    const seen = vi.fn();
    const off = t.on('suspendResume', seen);
    expect(m.count('suspend')).toBe(1);
    expect(m.count('resume')).toBe(1);
    expect(m.total()).toBe(2);
    m.fire('suspend');
    m.fire('resume');
    expect(seen.mock.calls.map((c) => c[0])).toEqual([{ state: 'suspend' }, { state: 'resume' }]);
    off();
    expect(m.total()).toBe(0);
    m.fire('suspend');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('lockScreen: maps lock-screen/unlock-screen', () => {
    const m = fakeMonitor();
    const t = track(m);
    const seen = vi.fn();
    t.on('lockScreen', seen);
    m.fire('lock-screen');
    m.fire('unlock-screen');
    expect(seen.mock.calls.map((c) => c[0])).toEqual([{ state: 'lock' }, { state: 'unlock' }]);
    expect(m.total()).toBe(2);
  });

  it('powerSource: maps on-ac/on-battery', () => {
    const m = fakeMonitor();
    const t = track(m);
    const seen = vi.fn();
    t.on('powerSource', seen);
    m.fire('on-battery');
    m.fire('on-ac');
    expect(seen.mock.calls.map((c) => c[0])).toEqual([{ source: 'battery' }, { source: 'ac' }]);
    expect(m.total()).toBe(2);
  });

  it('each emission is a fresh object (mutating one never corrupts the next)', () => {
    const m = fakeMonitor();
    const t = track(m);
    const states: string[] = [];
    t.on('suspendResume', (p) => {
      states.push(p.state);
      (p as { state: string }).state = 'mutated';
    });
    m.fire('suspend');
    m.fire('suspend');
    expect(states).toEqual(['suspend', 'suspend']);
  });

  it('stages are independent: releasing one leaves the others attached', () => {
    const m = fakeMonitor();
    const t = track(m);
    const off = t.on('lockScreen', () => {});
    t.on('powerSource', () => {});
    off();
    expect(m.count('lock-screen')).toBe(0);
    expect(m.count('on-ac')).toBe(1);
  });

  it('a throwing attach is reported, nothing stays attached, and the next listener change retries', () => {
    let fail = true;
    const m = fakeMonitor();
    const original = m.monitor.on.getMockImplementation() as (e: string, l: L) => void;
    m.monitor.on.mockImplementation((e: string, l: L) => {
      if (fail && e === 'resume') throw new Error('attach');
      original(e, l);
    });
    const onError = vi.fn();
    const t = track(m, onError);
    t.on('suspendResume', () => {});
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'attach' }));
    expect(m.total()).toBe(0);
    fail = false;
    t.on('lockScreen', () => {});
    expect(m.count('suspend')).toBe(1); // suspendResume re-armed by the retry
  });

  it('a monitor that cannot be released is never attached to', () => {
    const m = fakeMonitor({ removeListener: undefined });
    const t = track(m);
    t.on('suspendResume', () => {});
    expect(m.monitor.on).not.toHaveBeenCalled();
  });

  it('a monitor without `on` simply has no events', () => {
    const m = fakeMonitor({ on: undefined });
    const t = track(m);
    expect(() => t.on('powerSource', () => {})).not.toThrow();
  });

  it('a tracker built with no monitor (direct construction) attaches nothing', () => {
    const t = new ElectronPowerTracker();
    t.on('suspendResume', () => {});
    expect(t.current('powerSource')).toBeUndefined();
  });

  describe("current('powerSource')", () => {
    it('reads isOnBatteryPower live', () => {
      const m = fakeMonitor();
      const t = track(m);
      m.monitor.isOnBatteryPower.mockReturnValue(true);
      expect(t.current('powerSource')).toEqual({ source: 'battery' });
      m.monitor.isOnBatteryPower.mockReturnValue(false);
      expect(t.current('powerSource')).toEqual({ source: 'ac' });
    });
    it('is undefined (never guessed) without the method, with a non-boolean, or when it throws (reported)', () => {
      const quiet = vi.fn();
      expect(
        track(fakeMonitor({ isOnBatteryPower: undefined }), quiet).current('powerSource'),
      ).toBeUndefined();
      expect(quiet).not.toHaveBeenCalled(); // a missing method is absence, not an error
      const odd = fakeMonitor({ isOnBatteryPower: () => 'yes' });
      expect(track(odd).current('powerSource')).toBeUndefined();
      const onError = vi.fn();
      const bad = fakeMonitor({
        isOnBatteryPower: () => {
          throw new Error('read');
        },
      });
      expect(track(bad, onError).current('powerSource')).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'read' }));
    });
    it('rejects an unknown stage name', () => {
      const t = track(fakeMonitor());
      expect(t.current('other' as 'powerSource')).toBeUndefined();
      expect(t.current('other' as 'thermalState')).toBeUndefined();
    });
  });

  describe('thermalState stage (macOS thermal-state-change)', () => {
    it('maps the event detail to a known state, attaching only its own event and releasing on the last unsubscribe', () => {
      const m = fakeMonitor();
      const t = track(m);
      const seen = vi.fn();
      const off = t.on('thermalState', seen);
      expect(m.count('thermal-state-change')).toBe(1);
      expect(m.total()).toBe(1);
      for (const state of ['nominal', 'fair', 'serious', 'critical']) {
        m.fire('thermal-state-change', { state });
      }
      expect(seen.mock.calls.map((c) => c[0])).toEqual([
        { state: 'nominal' },
        { state: 'fair' },
        { state: 'serious' },
        { state: 'critical' },
      ]);
      off();
      expect(m.total()).toBe(0);
    });
    it('anything that is not one of the four known states is reported as unknown (never passed through)', () => {
      const m = fakeMonitor();
      const t = track(m);
      const seen = vi.fn();
      t.on('thermalState', seen);
      m.fire('thermal-state-change', { state: 'unknown' });
      m.fire('thermal-state-change', { state: 'meltdown' });
      m.fire('thermal-state-change', { state: 3 });
      m.fire('thermal-state-change', {});
      m.fire('thermal-state-change', null);
      m.fire('thermal-state-change');
      expect(seen.mock.calls.map((c) => c[0])).toEqual(Array(6).fill({ state: 'unknown' }));
    });
    it('does not arm the other stages', () => {
      const m = fakeMonitor();
      track(m).on('thermalState', () => {});
      expect(m.count('speed-limit-change')).toBe(0);
      expect(m.count('on-ac')).toBe(0);
    });
  });

  describe('speedLimit stage (speed-limit-change)', () => {
    it('maps the percent limit, attaching only its own event and releasing on the last unsubscribe', () => {
      const m = fakeMonitor();
      const t = track(m);
      const seen = vi.fn();
      const off = t.on('speedLimit', seen);
      expect(m.count('speed-limit-change')).toBe(1);
      expect(m.total()).toBe(1);
      m.fire('speed-limit-change', { limit: 100 });
      m.fire('speed-limit-change', { limit: 0 });
      m.fire('speed-limit-change', { limit: 62.4 });
      expect(seen.mock.calls.map((c) => c[0])).toEqual([
        { limit: 100 },
        { limit: 0 },
        { limit: 62 },
      ]);
      off();
      expect(m.total()).toBe(0);
    });
    it('drops a limit that cannot be real: non-number, NaN/Infinity, outside 0-100, no detail (omit, never zero)', () => {
      const m = fakeMonitor();
      const t = track(m);
      const seen = vi.fn();
      t.on('speedLimit', seen);
      for (const detail of [
        { limit: '50' },
        { limit: Number.NaN },
        { limit: Number.POSITIVE_INFINITY },
        { limit: -1 },
        { limit: 101 },
        { limit: 100.4 },
        {},
        null,
        undefined,
      ]) {
        m.fire('speed-limit-change', detail);
      }
      expect(seen).not.toHaveBeenCalled();
    });
  });

  describe("current('thermalState')", () => {
    it('reads getCurrentThermalState live and validates it', () => {
      const m = fakeMonitor();
      const t = track(m);
      for (const state of ['nominal', 'fair', 'serious', 'critical', 'unknown']) {
        m.monitor.getCurrentThermalState.mockReturnValue(state);
        expect(t.current('thermalState')).toEqual({ state });
      }
      m.monitor.getCurrentThermalState.mockReturnValue('nuclear');
      expect(t.current('thermalState')).toEqual({ state: 'unknown' });
      m.monitor.getCurrentThermalState.mockReturnValue(2);
      expect(t.current('thermalState')).toEqual({ state: 'unknown' });
    });
    it('is undefined without the method (non-macOS Electron) and when it throws (reported)', () => {
      const quiet = vi.fn();
      expect(
        track(fakeMonitor({ getCurrentThermalState: undefined }), quiet).current('thermalState'),
      ).toBeUndefined();
      expect(quiet).not.toHaveBeenCalled();
      const onError = vi.fn();
      const bad = fakeMonitor({
        getCurrentThermalState: () => {
          throw new Error('thermal');
        },
      });
      expect(track(bad, onError).current('thermalState')).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'thermal' }),
      );
    });
    it('is undefined for a tracker with no monitor', () => {
      expect(new ElectronPowerTracker().current('thermalState')).toBeUndefined();
    });
  });

  describe('a monitor whose property reads throw (host object not ready)', () => {
    const hostile = (message: string) =>
      new Proxy(
        {},
        {
          get() {
            throw new Error(message);
          },
        },
      ) as PowerMonitorSource;

    it('subscribing never throws, nothing attaches, the failure is reported once per attempt', () => {
      const onError = vi.fn();
      const monitor = hostile('power');
      keys.push(monitor);
      const t = electronPowerTrackerFor({ powerMonitor: monitor }, onError);
      expect(() => t.on('suspendResume', () => {})).not.toThrow();
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'power' }),
      );
    });

    it("current('powerSource') answers undefined and reports (the property read is inside the guard)", () => {
      const onError = vi.fn();
      const monitor = hostile('read');
      keys.push(monitor);
      const t = electronPowerTrackerFor({ powerMonitor: monitor }, onError);
      expect(t.current('powerSource')).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'read' }));
    });
  });

  describe('registry', () => {
    it('is a singleton per monitor object; different monitors are independent', () => {
      const a = fakeMonitor();
      const b = fakeMonitor();
      expect(track(a)).toBe(track(a));
      expect(track(a)).not.toBe(track(b));
    });
    it('throws without a monitor', () => {
      expect(() => electronPowerTrackerFor({})).toThrow(TypeError);
    });
    it('a relaunch rebinds onError (latest wins) and an absent one keeps the earlier', () => {
      const m = fakeMonitor();
      const first = vi.fn();
      const second = vi.fn();
      const t = track(m, first);
      track(m, second);
      track(m, undefined);
      t.on('suspendResume', () => {
        throw new Error('sub');
      });
      m.fire('suspend');
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });
    it('reset releases every listener and the next for() builds a fresh tracker', () => {
      const m = fakeMonitor();
      const t = track(m);
      t.on('suspendResume', () => {});
      t.on('powerSource', () => {});
      resetElectronPowerTracker(m.monitor);
      expect(m.total()).toBe(0);
      expect(track(m)).not.toBe(t);
    });
  });
});
