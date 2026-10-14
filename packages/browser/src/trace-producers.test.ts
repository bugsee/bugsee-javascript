import type { TraceProducer } from '@bugsee/capture';
import { describe, expect, it, vi } from 'vitest';
import { BatteryProducer, createBrowserSystemTraceProducers } from './trace-producers';
import { BatteryTracker } from './trackers/battery-tracker';

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
    const tracker = new BatteryTracker({ getBattery: () => Promise.resolve(m) });
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
    expect(m.count()).toBe(2);
    p.stop();
    expect(m.count()).toBe(0); // stop released the tracker's listeners
    m.level = 0.1;
    m.fire('levelchange');
    expect(out).toHaveLength(5);
  });

  it('a restart (stop, then start) re-fetches getBattery and re-emits the baseline', async () => {
    const m = mkManager(0.5, false);
    const getBattery = vi.fn(() => Promise.resolve(m));
    const producers = createBrowserSystemTraceProducers({ getBattery });
    const first = run(producers);
    await flush();
    first.p.stop(); // tracker deactivates -> current() undefined, listeners released
    expect(m.count()).toBe(0);
    const again = run(producers); // nothing cached: emits only after the NEW getBattery resolves
    expect(again.out).toEqual([]);
    await flush();
    expect(getBattery).toHaveBeenCalledTimes(2);
    expect(again.out).toEqual([
      { name: 'battery', value: 50 },
      { name: 'charging', value: { state: 1 } },
    ]);
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
