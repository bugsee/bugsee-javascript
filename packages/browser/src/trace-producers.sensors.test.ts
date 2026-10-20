import type { TraceProducer } from '@bugsee/capture';
import { ConnectivityTracker, ProcessTracker, UiTracker } from '@bugsee/trackers/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdvertisedMemoryProducer,
  ConnectionProducer,
  createBrowserSystemTraceProducers,
  MemoryProducer,
  OrientationProducer,
} from './trace-producers';

type Row = { name: string; value: unknown };
const startAll = (producers: readonly TraceProducer[]) => {
  const out: Row[] = [];
  const sink = { emit: (name: string, value: unknown) => void out.push({ name, value }) };
  for (const p of producers) p.start(sink);
  return {
    out,
    stop: () => {
      for (const p of producers) p.stop();
    },
  };
};
const named = (producers: readonly TraceProducer[], names: string[]) =>
  producers.filter((p) => names.includes(p.name));

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
function mkScheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: (cb: () => void) => {
      timers.set(next, cb);
      return next++;
    },
    clearInterval: (h: unknown) => void timers.delete(h as number),
    tick: () =>
      [...timers.values()].forEach((cb) => {
        cb();
      }),
    live: () => timers.size,
  };
}
const heap = (used: number, limit: number) => ({
  usedJSHeapSize: used,
  totalJSHeapSize: limit / 2,
  jsHeapSizeLimit: limit,
});

afterEach(() => vi.unstubAllGlobals());

/** A ProcessTracker whose `performance.memory` is the live getter `memory()`. */
function mkProcess(memory: () => unknown, scheduler?: ReturnType<typeof mkScheduler>) {
  return new ProcessTracker({
    ...(scheduler !== undefined ? { scheduler } : {}),
    performance: {
      get memory() {
        return memory() as never;
      },
    },
  });
}

describe('MemoryProducer', () => {
  it('emits the GROUPED ram_js_heap_* series (limit as total, free = limit - used) as a baseline, then every tick', () => {
    // `total` is the heap CEILING (jsHeapSizeLimit) and `free` is total - used — Android's ram_jvm_heap
    // contract. NOT totalJSHeapSize (merely what V8 has committed), which would make `free` shrink as
    // the heap grew; and no fourth `committed` series, which would break the stacked area.
    const s = mkScheduler();
    let used = 1;
    const p = new MemoryProducer(mkProcess(() => heap(used, 3), s));
    const { out, stop } = startAll([p]);
    expect(out).toEqual([
      { name: 'ram_js_heap_total', value: 3 },
      { name: 'ram_js_heap_free', value: 2 },
      { name: 'ram_js_heap_used', value: 1 },
    ]);
    used = 2;
    s.tick();
    expect(out.slice(3)).toEqual([
      { name: 'ram_js_heap_total', value: 3 },
      { name: 'ram_js_heap_free', value: 1 },
      { name: 'ram_js_heap_used', value: 2 },
    ]);
    stop();
    expect(s.live()).toBe(0);
  });

  it('emits through the unconditional (polled) path: an unchanged reading is still emitted each tick', () => {
    const s = mkScheduler();
    const p = new MemoryProducer(mkProcess(() => heap(1, 3), s));
    const { out } = startAll([p]);
    s.tick();
    expect(out).toHaveLength(6);
  });

  it('emits nothing and starts no timer where the engine has no performance.memory', () => {
    const s = mkScheduler();
    const { out } = startAll([new MemoryProducer(mkProcess(() => undefined, s))]);
    expect(out).toEqual([]);
    expect(s.live()).toBe(0);
  });

  it('never emits the retired browser_memory_* names', () => {
    const names = startAll([new MemoryProducer(mkProcess(() => heap(1, 3)))]).out.map(
      (r) => r.name,
    );
    expect(names.filter((n) => n.startsWith('browser_memory'))).toEqual([]);
  });
});

describe('AdvertisedMemoryProducer', () => {
  it('emits ram_system_advertised in BYTES once, from navigator.deviceMemory (GiB)', () => {
    // deviceMemory is a rounded bucket (32 on a 64 GB machine), so it is the ADVERTISED figure, not the
    // environment's memory_total.
    expect(startAll([new AdvertisedMemoryProducer(() => 8)]).out).toEqual([
      { name: 'ram_system_advertised', value: 8 * 1024 ** 3 },
    ]);
  });

  it('emits nothing where deviceMemory is unsupported (Safari/Firefox)', () => {
    expect(startAll([new AdvertisedMemoryProducer(() => undefined)]).out).toEqual([]);
  });
});

describe('ConnectionProducer', () => {
  it('emits a TRANSPORT type the viewer can render, with effectiveType kept as detail', () => {
    // `type` must be a CONNECTION_STATES key; it used to carry effectiveType ('4g'), in no table.
    const t = new ConnectivityTracker({
      navigator: {
        onLine: true,
        connection: {
          type: 'wifi',
          effectiveType: '4g',
          downlink: 10,
          downlinkMax: 100,
          rtt: 50,
          saveData: false,
        },
      },
    });
    expect(startAll([new ConnectionProducer(t)]).out).toEqual([
      {
        name: 'connection',
        value: {
          type: 'wifi',
          effective_type: '4g',
          link_downstream_kbps: 10_000, // downlink is Mbps; Android reports kbps
          link_downstream_max_kbps: 100_000,
          rtt: 50,
          save_data: false,
        },
      },
    ]);
  });

  it('reports not_reachable when offline even if NetworkInformation names a transport', () => {
    const win = mkTarget();
    const nav = { onLine: true, connection: { type: 'wifi' } };
    const { out } = startAll([
      new ConnectionProducer(new ConnectivityTracker({ window: win, navigator: nav })),
    ]);
    nav.onLine = false;
    win.fire('offline');
    expect(out.map((r) => (r.value as { type: string }).type)).toEqual(['wifi', 'not_reachable']);
  });

  it('still emits (type unknown) with NO NetworkInformation, because onLine alone is worth a row', () => {
    expect(
      startAll([new ConnectionProducer(new ConnectivityTracker({ navigator: { onLine: true } }))])
        .out,
    ).toEqual([{ name: 'connection', value: { type: 'unknown' } }]);
  });

  it('de-duplicates: an event that changes nothing emits nothing; a real change emits', () => {
    const win = mkTarget();
    const nav = { onLine: true };
    const { out } = startAll([
      new ConnectionProducer(new ConnectivityTracker({ window: win, navigator: nav })),
    ]);
    win.fire('online');
    expect(out).toHaveLength(1);
    nav.onLine = false;
    win.fire('offline');
    expect(out).toHaveLength(2);
  });

  it('producers built twice from one window share ONE connectivity tracker (one listener pair)', () => {
    const win = mkTarget();
    const nav = { onLine: true };
    const pick = () =>
      named(createBrowserSystemTraceProducers({ window: win, navigator: nav }), ['connection']);
    const a = startAll(pick());
    const b = startAll(pick());
    expect(win.count()).toBe(2); // ONE online + offline pair, shared; a per-producer tracker would make it 4
    a.stop();
    b.stop();
    expect(win.count()).toBe(0);
  });

  it('emits no row when navigator.onLine cannot be read (never a fabricated online/unknown)', () => {
    const nav = { connection: { type: 'wifi' } };
    Object.defineProperty(nav, 'onLine', {
      get() {
        throw new Error('onLine blocked');
      },
    });
    const onError = vi.fn();
    expect(
      startAll([new ConnectionProducer(new ConnectivityTracker({ navigator: nav }, onError))]).out,
    ).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('emits nothing with no navigator at all', () => {
    expect(startAll([new ConnectionProducer(new ConnectivityTracker({}))]).out).toEqual([]);
  });

  it('stop() releases the tracker listeners and late events write nothing', () => {
    const win = mkTarget();
    const nav = { onLine: true };
    const { out, stop } = startAll([
      new ConnectionProducer(new ConnectivityTracker({ window: win, navigator: nav })),
    ]);
    stop();
    expect(win.count()).toBe(0);
    nav.onLine = false;
    win.fire('offline');
    expect(out).toHaveLength(1);
  });
});

describe('OrientationProducer', () => {
  it('emits the Android-enum INT, never the browser {type, angle} object', () => {
    const orientation = Object.assign(mkTarget(), { type: 'landscape-primary', angle: 90 });
    const { out } = startAll([new OrientationProducer(new UiTracker({ screen: { orientation } }))]);
    expect(out).toEqual([{ name: 'orientation', value: 3 }]); // LandscapeLeft
    orientation.type = 'portrait-primary';
    orientation.angle = 0;
    orientation.fire('change');
    expect(out.slice(1)).toEqual([{ name: 'orientation', value: 1 }]); // Portrait
  });

  it('collapses the double delivery (screen.orientation change + window orientationchange)', () => {
    const win = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    const { out } = startAll([
      new OrientationProducer(new UiTracker({ window: win, screen: { orientation } })),
    ]);
    orientation.type = 'landscape-secondary';
    orientation.angle = 270;
    orientation.fire('change');
    win.fire('orientationchange');
    expect(out.map((r) => r.value)).toEqual([1, 4]);
  });

  it('ignores a bare orientation notification (an orientationchange the engine cannot read)', () => {
    const win = mkTarget();
    const { out } = startAll([new OrientationProducer(new UiTracker({ window: win, screen: {} }))]);
    win.fire('orientationchange');
    expect(out).toEqual([]);
  });

  it('emits nothing where the engine has no screen.orientation', () => {
    expect(startAll([new OrientationProducer(new UiTracker({ screen: {} }))]).out).toEqual([]);
  });
});

describe('createBrowserSystemTraceProducers (sensors)', () => {
  it('builds battery first, then one producer per sensor, activating nothing at call time', () => {
    const s = mkScheduler();
    const win = mkTarget();
    const connection = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    const producers = createBrowserSystemTraceProducers({
      performance: { memory: heap(1, 3) },
      navigator: { onLine: true, connection: Object.assign(connection, { type: 'wifi' }) },
      screen: { orientation },
      window: win,
      scheduler: s,
    });
    expect(producers.map((p) => p.name)).toEqual([
      'battery',
      'memory',
      'user-idle',
      'ram-system-advertised',
      'storage',
      'connection',
      'orientation',
    ]);
    expect(s.live() + win.count() + connection.count() + orientation.count()).toBe(0);
  });

  it('starting and stopping the whole set attaches then releases every resource', () => {
    const s = mkScheduler();
    const win = mkTarget();
    const connection = mkTarget();
    const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
    const producers = createBrowserSystemTraceProducers({
      performance: { memory: heap(1, 3) },
      navigator: {
        onLine: true,
        deviceMemory: 4,
        connection: Object.assign(connection, { type: 'wifi' }),
      },
      screen: { orientation },
      window: win,
      scheduler: s,
    });
    const { out, stop } = startAll(producers);
    expect(out.map((r) => r.name).sort()).toEqual(
      [
        'ram_js_heap_total',
        'ram_js_heap_free',
        'ram_js_heap_used',
        'ram_system_advertised',
        'connection',
        'orientation',
      ].sort(),
    );
    expect(s.live()).toBe(1);
    expect(win.count()).toBe(3); // online, offline, orientationchange
    stop();
    expect(s.live() + win.count() + connection.count() + orientation.count()).toBe(0);
  });

  it('an empty env samples nothing', () => {
    expect(startAll(createBrowserSystemTraceProducers({})).out).toEqual([]);
  });

  it('forwards onError to the sensor trackers', () => {
    const onError = vi.fn();
    const { out } = startAll(
      named(
        createBrowserSystemTraceProducers(
          {
            performance: {
              get memory(): never {
                throw new Error('getter');
              },
            },
          },
          onError,
        ),
        ['memory'],
      ),
    );
    expect(out).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('the default env reads the REAL globals live — including prototype getters, which a spread would lose', () => {
    // A real `navigator` exposes onLine / connection / deviceMemory as accessors on its PROTOTYPE, so
    // `{ ...navigator }` is `{}`; the producers must read the live object instead.
    const proto = {
      get onLine() {
        return false;
      },
      get connection() {
        return { type: 'cellular' };
      },
      get deviceMemory() {
        return 2;
      },
    };
    vi.stubGlobal('navigator', Object.create(proto));
    vi.stubGlobal('performance', { memory: heap(5, 50) });
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', angle: 0 } });
    const { out, stop } = startAll(createBrowserSystemTraceProducers());
    const byName = new Map(out.map((r) => [r.name, r.value]));
    expect(byName.get('connection')).toEqual({ type: 'not_reachable' });
    expect(byName.get('ram_system_advertised')).toBe(2 * 1024 ** 3);
    expect(byName.get('ram_js_heap_used')).toBe(5);
    expect(byName.get('orientation')).toBe(1);
    stop();
  });

  it('the default env tolerates missing globals (worker / node)', () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('performance', undefined);
    vi.stubGlobal('screen', undefined);
    expect(startAll(createBrowserSystemTraceProducers()).out).toEqual([]);
  });

  it('forwards onError to the connection tracker (a throwing navigator.connection getter)', () => {
    const onError = vi.fn();
    startAll(
      named(
        createBrowserSystemTraceProducers(
          {
            window: mkTarget(),
            navigator: {
              onLine: true,
              get connection(): never {
                throw new Error('getter');
              },
            },
          },
          onError,
        ),
        ['connection'],
      ),
    );
    expect(onError).toHaveBeenCalled();
  });

  it('the default env uses the global window for connectivity and orientation events', () => {
    const win = mkTarget();
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', { onLine: true });
    const { stop } = startAll(createBrowserSystemTraceProducers());
    expect(win.count()).toBe(3); // online, offline, orientationchange
    stop();
    expect(win.count()).toBe(0);
  });

  it('an unrecognised orientation type is Unknown even when the angle alone would say Portrait', () => {
    const orientation = { type: 'sideways', angle: 0 };
    const { out } = startAll([new OrientationProducer(new UiTracker({ screen: { orientation } }))]);
    expect(out).toEqual([{ name: 'orientation', value: 0 }]);
  });

  it('sensors:false builds the battery producer only (a custom sampler replaces the sensor traces)', () => {
    expect(
      createBrowserSystemTraceProducers({
        sensors: false,
        performance: { memory: heap(1, 3) },
        navigator: { onLine: true },
      }).map((p) => p.name),
    ).toEqual(['battery']);
  });
});
