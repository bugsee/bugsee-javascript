import type { TraceSink } from '@bugsee/capture';
import {
  ElectronPowerTracker,
  electronPowerTrackerFor,
  type PowerMonitorSource,
  resetElectronPowerTracker,
} from '@bugsee/trackers/electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElectronSystemTraceProducers } from './system-traces';

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
    getCurrentThermalState: vi.fn((): unknown => 'nominal'),
    ...over,
  };
  return {
    monitor: monitor as PowerMonitorSource & typeof monitor,
    fire: (e: string, ...args: unknown[]) => {
      for (const l of [...(table.get(e) ?? [])]) l(...args);
    },
    total: () => [...table.values()].reduce((n, l) => n + l.length, 0),
  };
}

const keys: object[] = [];
afterEach(() => {
  for (const k of keys.splice(0)) resetElectronPowerTracker(k);
});

function setup(over: Record<string, unknown> = {}, onError?: (e: unknown) => unknown) {
  const m = fakeMonitor(over);
  keys.push(m.monitor);
  const power = electronPowerTrackerFor({ powerMonitor: m.monitor }, onError);
  const emitted: Array<{ name: string; value: unknown; hold: boolean | undefined }> = [];
  const sink: TraceSink = {
    emit: (name, value, display, options) => {
      expect(display).toBeUndefined(); // no JavaScript producer sets displayId
      emitted.push({ name, value, hold: options?.hold });
    },
  };
  const producers = createElectronSystemTraceProducers({ power });
  return { m, power, emitted, sink, producers };
}

describe('power traces: thermal_state and cpu_speed_limit (C13)', () => {
  it('builds the two producers for a power tracker, none without one', () => {
    expect(setup().producers.map((p) => p.name)).toEqual(['thermal_state', 'cpu_speed_limit']);
    expect(createElectronSystemTraceProducers({}).map((p) => p.name)).toEqual([]);
  });

  it('touches nothing until started', () => {
    const { m, producers } = setup();
    expect(m.monitor.on).not.toHaveBeenCalled();
    expect(m.monitor.getCurrentThermalState).not.toHaveBeenCalled();
    expect(producers.length).toBe(2);
  });

  it('thermal_state: writes the current state at start (iOS int), then every change; sampled, never held', () => {
    const { m, producers, emitted, sink } = setup({ getCurrentThermalState: () => 'fair' });
    producers[0]?.start(sink);
    expect(emitted).toEqual([{ name: 'thermal_state', value: 1, hold: false }]);
    m.fire('thermal-state-change', { state: 'serious' });
    m.fire('thermal-state-change', { state: 'critical' });
    m.fire('thermal-state-change', { state: 'nominal' });
    expect(emitted.map((e) => e.value)).toEqual([1, 2, 3, 0]);
    expect(emitted.every((e) => e.name === 'thermal_state' && e.hold === false)).toBe(true);
  });

  it('thermal_state: `unknown` writes nothing (at start and on an event); a later known state still lands', () => {
    const { m, producers, emitted, sink } = setup({ getCurrentThermalState: () => 'unknown' });
    producers[0]?.start(sink);
    m.fire('thermal-state-change', { state: 'unknown' });
    m.fire('thermal-state-change', { state: 'bogus' });
    expect(emitted).toEqual([]);
    m.fire('thermal-state-change', { state: 'fair' });
    expect(emitted.map((e) => e.value)).toEqual([1]);
  });

  it('thermal_state: no getCurrentThermalState (Windows/Linux) -> no baseline; listener still armed harmlessly', () => {
    const { producers, emitted, sink } = setup({ getCurrentThermalState: undefined });
    producers[0]?.start(sink);
    expect(emitted).toEqual([]);
  });

  it('thermal_state: stop releases the listener, a late event writes nothing, and a restart re-reads', () => {
    let state = 'nominal';
    const { m, producers, emitted, sink } = setup({ getCurrentThermalState: () => state });
    producers[0]?.start(sink);
    expect(m.total()).toBe(1);
    producers[0]?.stop();
    expect(m.total()).toBe(0);
    m.fire('thermal-state-change', { state: 'critical' });
    expect(emitted).toHaveLength(1);
    state = 'serious';
    producers[0]?.start(sink);
    expect(emitted.map((e) => e.value)).toEqual([0, 2]);
  });

  it('cpu_speed_limit: event-fed only (no baseline), integer percent, sampled, never held', () => {
    const { m, producers, emitted, sink } = setup();
    producers[1]?.start(sink);
    expect(emitted).toEqual([]);
    m.fire('speed-limit-change', { limit: 75 });
    m.fire('speed-limit-change', { limit: 100 });
    m.fire('speed-limit-change', { limit: 0 }); // a genuine 0 is a measured value
    expect(emitted).toEqual([
      { name: 'cpu_speed_limit', value: 75, hold: false },
      { name: 'cpu_speed_limit', value: 100, hold: false },
      { name: 'cpu_speed_limit', value: 0, hold: false },
    ]);
  });

  it('cpu_speed_limit: an unreadable limit writes nothing, and stop releases the listener', () => {
    const { m, producers, emitted, sink } = setup();
    producers[1]?.start(sink);
    m.fire('speed-limit-change', { limit: 'fast' });
    m.fire('speed-limit-change', {});
    expect(emitted).toEqual([]);
    producers[1]?.stop();
    expect(m.total()).toBe(0);
    m.fire('speed-limit-change', { limit: 50 });
    expect(emitted).toEqual([]);
  });

  it('the two producers are independent: each arms only its own Electron event', () => {
    const { m, producers, sink } = setup();
    producers[0]?.start(sink);
    expect(m.total()).toBe(1);
    producers[1]?.start(sink);
    expect(m.total()).toBe(2);
    producers[0]?.stop();
    expect(m.total()).toBe(1);
  });

  it('a throwing getCurrentThermalState is reported through the tracker and the producer still starts', () => {
    const onError = vi.fn();
    const { m, producers, emitted, sink } = setup(
      {
        getCurrentThermalState: () => {
          throw new Error('thermal');
        },
      },
      onError,
    );
    expect(() => producers[0]?.start(sink)).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'thermal' }),
    );
    m.fire('thermal-state-change', { state: 'fair' });
    expect(emitted.map((e) => e.value)).toEqual([1]);
  });

  it('works with a directly constructed tracker too (structural, no registry needed)', () => {
    const m = fakeMonitor();
    const tracker = new ElectronPowerTracker({ powerMonitor: m.monitor });
    const producers = createElectronSystemTraceProducers({ power: tracker });
    const seen: unknown[] = [];
    producers[0]?.start({ emit: (_n, v) => seen.push(v) });
    expect(seen).toEqual([0]);
    tracker.reset();
  });
});
