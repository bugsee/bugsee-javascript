import type { TraceProducer } from '@bugsee/capture';
import { PowerTracker } from '@bugsee/trackers/browser';
import { describe, expect, it, vi } from 'vitest';
import { BatteryProducer, createBrowserSystemTraceProducers } from './trace-producers';

function mkManager(level: number, charging: boolean) {
  const l = new Map<string, Set<() => void>>();
  return {
    level,
    charging,
    addEventListener: (t: string, f: () => void) => {
      const s = l.get(t) ?? new Set<() => void>();
      s.add(f);
      l.set(t, s);
    },
    removeEventListener: (t: string, f: () => void) => void l.get(t)?.delete(f),
    count: () => [...l.values()].reduce((n, x) => n + x.size, 0),
    fire: (t: string) =>
      l.get(t)?.forEach((f) => {
        f();
      }),
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function run(producers: TraceProducer[]) {
  const out: Array<{ name: string; value: unknown }> = [];
  const sink = { emit: (name: string, value: unknown) => void out.push({ name, value }) };
  const p = producers[0];
  if (p === undefined) throw new Error('no producer');
  p.start(sink);
  return { out, p };
}

describe('BatteryProducer', () => {
  it('publishes the shared tracker current() at start when another subscriber already resolved it', async () => {
    const m = mkManager(0.25, false);
    const tracker = new PowerTracker({ getBattery: () => Promise.resolve(m) });
    const offOther = tracker.on('state', () => {});
    await flush();
    const { out, p } = run([new BatteryProducer(tracker)]);
    expect(out).toEqual([
      { name: 'battery', value: 25 },
      { name: 'charging', value: { state: 1 } },
    ]);
    p.stop();
    offOther();
  });

  it('stamps every value of one battery reading (baseline) with one sink-clock timestamp', async () => {
    const m = { ...mkManager(0.25, false), chargingTime: 60, dischargingTime: 120 };
    const tracker = new PowerTracker({ getBattery: () => Promise.resolve(m) });
    const offOther = tracker.on('state', () => {});
    await flush();
    const stamps: unknown[] = [];
    let clock = 6;
    const p = new BatteryProducer(tracker);
    p.start({
      emit: (_n: string, _v: unknown, _d?: number, o?: { timestamp?: number }) =>
        void stamps.push(o?.timestamp),
      now: () => (clock += 1),
    });
    expect(stamps.length).toBeGreaterThan(1);
    expect(new Set(stamps)).toEqual(new Set([7]));
    // the live path: a state change is its own poll with a fresh shared timestamp
    stamps.length = 0;
    m.level = 0.5;
    m.chargingTime = 90;
    m.fire('levelchange');
    m.fire('chargingtimechange');
    expect(stamps.length).toBeGreaterThan(1);
    expect(new Set(stamps)).toEqual(new Set([8])); // one poll = one stamp (levelchange emits two values; chargingtimechange nothing)
    expect(stamps.every((t) => typeof t === 'number' && t > 7)).toBe(true);
    p.stop();
    offOther();
  });

  it('an unreadable level while charging emits NOTHING: no battery, and no fabricated charging state', async () => {
    const m = mkManager(Number.NaN, true);
    const { out } = run(
      createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }),
    );
    await flush();
    expect(out).toEqual([]);
  });

  it('emits battery (rounded percent) and charging ({state}) once the manager resolves, then only on change', async () => {
    const m = mkManager(0.426, true);
    const { out, p } = run(
      createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }),
    );
    expect(out).toEqual([]);
    await flush();
    expect(out).toEqual([
      { name: 'battery', value: 43 },
      { name: 'charging', value: { state: 2 } },
    ]);
    m.level = 0.428; // rounds to the same 43 -> nothing for battery
    m.fire('levelchange');
    expect(out).toHaveLength(2);
    m.level = 1;
    m.fire('levelchange');
    expect(out.slice(2)).toEqual([
      { name: 'battery', value: 100 },
      { name: 'charging', value: { state: 3 } },
    ]);
    m.charging = false;
    m.fire('chargingchange');
    expect(out.slice(4)).toEqual([{ name: 'charging', value: { state: 1 } }]);
    expect(m.count()).toBe(4);
    p.stop();
    expect(m.count()).toBe(0); // stop released the tracker's listeners
    m.level = 0.1;
    m.fire('levelchange');
    expect(out).toHaveLength(5);
  });

  it('a restart (stop, then start) reuses the retained manager (one getBattery) and re-emits a fresh baseline', async () => {
    const m = mkManager(0.5, false);
    const getBattery = vi.fn(() => Promise.resolve(m));
    const producers = createBrowserSystemTraceProducers({ getBattery });
    const first = run(producers);
    await flush();
    first.p.stop(); // listeners released, manager + snapshot retained
    expect(m.count()).toBe(0);
    m.level = 0.4;
    const again = run(producers);
    expect(getBattery).toHaveBeenCalledTimes(1);
    expect(m.count()).toBe(4);
    expect(again.out).toEqual([
      { name: 'battery', value: 40 },
      { name: 'charging', value: { state: 1 } },
    ]);
  });

  describe('time traces', () => {
    const times = (out: Array<{ name: string; value: unknown }>) =>
      out.filter((o) => o.name.endsWith('_time_s'));

    it('emits integer-second battery_charging_time_s / battery_discharging_time_s, change-only', async () => {
      const m = Object.assign(mkManager(0.5, true), { chargingTime: 600.4, dischargingTime: 7200 });
      const { out } = run(
        createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }),
      );
      await flush();
      expect(times(out)).toEqual([
        { name: 'battery_charging_time_s', value: 600 },
        { name: 'battery_discharging_time_s', value: 7200 },
      ]);
      m.fire('levelchange'); // unchanged -> nothing new
      expect(times(out)).toHaveLength(2);
      m.chargingTime = 300;
      m.fire('chargingtimechange');
      expect(times(out).slice(2)).toEqual([{ name: 'battery_charging_time_s', value: 300 }]);
    });

    it('omits a time that is not finite and never sends it as a number', async () => {
      const m = Object.assign(mkManager(0.5, false), {
        chargingTime: Infinity,
        dischargingTime: NaN,
      });
      const { out } = run(
        createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }),
      );
      await flush();
      expect(times(out)).toEqual([]);
    });

    it('is emitted NOT held (hold:false), so a vanished time is never refreshed as a stale value', async () => {
      const m = Object.assign(mkManager(0.5, true), { chargingTime: 600 });
      const calls: Array<{ name: string; hold: boolean | undefined }> = [];
      const producer = createBrowserSystemTraceProducers({
        getBattery: () => Promise.resolve(m),
      })[0];
      producer?.start({
        emit: (name, _v, _d, o) => void calls.push({ name, hold: o?.hold }),
      });
      await flush();
      expect(calls.find((c) => c.name === 'battery_charging_time_s')?.hold).toBe(false);
      expect(calls.find((c) => c.name === 'battery')?.hold).toBe(true);
    });

    it('a time that disappears records nothing, and the same value reappearing is emitted again', async () => {
      const m = Object.assign(mkManager(0.5, true), { chargingTime: 600 });
      const { out } = run(
        createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }),
      );
      await flush();
      m.chargingTime = Infinity;
      m.fire('chargingtimechange');
      expect(times(out)).toHaveLength(1);
      m.chargingTime = 600;
      m.fire('chargingtimechange');
      expect(times(out)).toEqual([
        { name: 'battery_charging_time_s', value: 600 },
        { name: 'battery_charging_time_s', value: 600 },
      ]);
    });

    it('a restart re-emits the times (dedupe memory is cleared on stop)', async () => {
      const m = Object.assign(mkManager(0.5, true), { chargingTime: 600 });
      const producers = createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) });
      const first = run(producers);
      await flush();
      first.p.stop();
      const again = run(producers);
      expect(times(again.out)).toEqual([{ name: 'battery_charging_time_s', value: 600 }]);
    });
  });

  it('an unusable level emits no battery trace (never NaN) and no charging entry (never state 0 or a level-0 guess)', async () => {
    const m = mkManager(Number.NaN, false);
    const { out } = run(
      createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }),
    );
    await flush();
    expect(out).toEqual([]);
  });

  it('readable then unreadable level: nothing new is emitted (known edge: the held battery/charging cannot be retracted)', async () => {
    const m = mkManager(0.8, true);
    const { out } = run(
      createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }),
    );
    await flush();
    expect(out).toEqual([
      { name: 'battery', value: 80 },
      { name: 'charging', value: { state: 2 } },
    ]);
    m.level = Number.NaN;
    m.fire('levelchange');
    // No fabricated update and no zero; the provider keeps re-recording the last held values (no retract path yet).
    expect(out).toHaveLength(2);
  });

  it('an unsupported browser (no getBattery) emits nothing and reports no error', async () => {
    const onError = vi.fn();
    const { out } = run(createBrowserSystemTraceProducers({}, onError));
    await flush();
    expect(out).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('producers built twice from one window share ONE power tracker (one getBattery)', async () => {
    const m = mkManager(0.5, false);
    const getBattery = vi.fn(() => Promise.resolve(m));
    const win = { addEventListener: () => {}, removeEventListener: () => {} };
    const a = run(createBrowserSystemTraceProducers({ window: win, getBattery }));
    const b = run(createBrowserSystemTraceProducers({ window: win, getBattery }));
    await flush();
    expect(getBattery).toHaveBeenCalledTimes(1);
    expect(m.count()).toBe(4);
    a.p.stop();
    expect(m.count()).toBe(4);
    b.p.stop();
    expect(m.count()).toBe(0);
  });

  it('forwards onError to the battery tracker: a throw after getBattery resolves is reported', async () => {
    const m = mkManager(0.5, false);
    m.addEventListener = () => {
      throw new Error('add refused');
    };
    const onError = vi.fn();
    const { out } = run(
      createBrowserSystemTraceProducers({ getBattery: () => Promise.resolve(m) }, onError),
    );
    await flush();
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('add refused');
    expect(out).toEqual([]);
  });

  it('constructs nothing at call time (no getBattery call)', () => {
    const getBattery = vi.fn();
    createBrowserSystemTraceProducers({ getBattery });
    expect(getBattery).not.toHaveBeenCalled();
  });

  it('default env reads navigator lazily and tolerates its absence', async () => {
    vi.stubGlobal('navigator', undefined);
    try {
      const { out } = run(createBrowserSystemTraceProducers());
      await flush();
      expect(out).toEqual([]);
      vi.stubGlobal('navigator', {});
      expect(run(createBrowserSystemTraceProducers()).out).toEqual([]);
      const m = mkManager(0.7, false);
      const nav = {
        getBattery(this: unknown) {
          return this === nav ? Promise.resolve(m) : Promise.reject(new Error('unbound'));
        },
      };
      vi.stubGlobal('navigator', nav);
      const r = run(createBrowserSystemTraceProducers());
      await flush();
      expect(r.out).toEqual([
        { name: 'battery', value: 70 },
        { name: 'charging', value: { state: 1 } },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
