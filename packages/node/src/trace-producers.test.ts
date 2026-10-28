import { processTrackerFor } from '@bugsee/trackers/node';
import { describe, expect, it, vi } from 'vitest';
import {
  createNodeSystemTraceProducers,
  type NodeTraceProducerDeps,
  V8_HEAP_PRODUCER_NAME,
} from './trace-producers';

const harnessKey: object[] = [];
function harness(deps: NodeTraceProducerDeps) {
  const key = {};
  harnessKey.push(key);
  const got = new Map<string, unknown>();
  const spy = { set: 0, cleared: 0 };
  let tick: (() => void) | undefined;
  const producers = createNodeSystemTraceProducers({
    key, // a private tracker per test: the per-process singleton must not leak state between cases
    ...deps,
    scheduler: {
      setInterval: (cb) => {
        spy.set += 1;
        tick = cb;
        return 'h';
      },
      clearInterval: () => {
        spy.cleared += 1;
      },
    },
  });
  const sink = { emit: (n: string, v: unknown) => void got.set(n, v) };
  return {
    got,
    spy,
    producers,
    startAll: () => {
      for (const p of producers) p.start(sink);
    },
    stopAll: () => {
      for (const p of producers) p.stop();
    },
    tick: () => tick?.(),
  };
}

const constDeps = (over: NodeTraceProducerDeps = {}): NodeTraceProducerDeps => ({
  memoryUsage: () => ({ rss: 10, heapTotal: 20, heapUsed: 30, external: 40, arrayBuffers: 50 }),
  systemMemory: () => ({ total: 1000, free: 400 }),
  cpuUsage: () => ({ user: 100_000, system: 200_000 }),
  cpuCount: () => 2,
  monotonicNowMs: () => 1000,
  v8Heap: () => ({ limit: 1000, used: 300, available: 700, malloced: 11, peakMalloced: 12 }),
  memoryLimit: () => 500,
  ...over,
});

function fakePerfHooks(
  elu: (a?: unknown, b?: unknown) => unknown = () => ({ idle: 5, active: 5, utilization: 0.3 }),
) {
  const state = { monitor: 0, enabled: false, disables: 0 };
  const histogram = {
    count: 3, // samples taken; 0 = nothing measured yet
    enable() {
      state.enabled = true;
    },
    disable() {
      state.enabled = false;
      state.disables += 1;
    },
    reset() {},
    mean: 2e6,
    max: 9e6,
    percentile: () => 7e6,
  };
  return {
    state,
    histogram,
    perfHooks: {
      monitorEventLoopDelay: () => {
        state.monitor += 1;
        return histogram;
      },
      eventLoopUtilization: elu as never,
    },
  };
}

const eventLoop = {
  read: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }),
  start: () => {},
  stop: () => {},
};

describe('createNodeSystemTraceProducers', () => {
  // Per-call constant increments: every read advances one fixed step, so whichever reader takes the
  // baseline, each window is exactly one step — every producer sees the SAME window.
  const steppingCpu = () => {
    let calls = 0;
    return {
      cpuUsage: () => {
        calls += 1;
        return { user: calls * 100_000, system: calls * 50_000 };
      },
      monotonicNowMs: () => calls * 1000, // read right after cpuUsage: the same step
    };
  };

  it('emits the full node catalog with exact values (non-zero CPU window)', () => {
    const h = harness(constDeps({ ...steppingCpu(), eventLoop, eventLoopUtilization: () => 50 }));
    h.startAll();
    h.tick();
    expect([...h.got.entries()].sort(([x], [y]) => x.localeCompare(y))).toEqual([
      ['cpu_usage_process', 7.5],
      ['cpu_usage_system', 50000],
      ['cpu_usage_user', 100000],
      ['event_loop_lag_max_ms', 2],
      ['event_loop_lag_ms', 1],
      ['event_loop_lag_p99_ms', 3],
      ['event_loop_utilization', 50],
      ['process_memory_array_buffers', 50],
      ['process_memory_external', 40],
      ['process_memory_heap_total', 20],
      ['process_memory_heap_used', 30],
      ['process_memory_limit', 500],
      ['process_memory_rss', 10],
      ['ram_js_heap_free', 700],
      ['ram_js_heap_total', 1000],
      ['ram_js_heap_used', 300],
      ['ram_system_free', 400],
      ['ram_system_total', 1000],
      ['v8_heap_available', 700],
      ['v8_heap_malloced', 11],
      ['v8_heap_peak_malloced', 12],
      ['v8_heap_size_limit', 1000],
    ]);
  });

  describe('runtime-depth traces', () => {
    const run = (over: NodeTraceProducerDeps) => {
      const h = harness(constDeps({ eventLoop, eventLoopUtilization: () => 50, ...over }));
      h.startAll();
      return h;
    };

    it('ram_js_heap_* is the CEILING-based view: total = limit, used = used, free = limit - used', () => {
      const h = run({
        v8Heap: () => ({ limit: 900, used: 250, available: 1, malloced: 2, peakMalloced: 3 }),
      });
      expect(h.got.get('ram_js_heap_total')).toBe(900);
      expect(h.got.get('ram_js_heap_used')).toBe(250);
      expect(h.got.get('ram_js_heap_free')).toBe(650);
    });

    it('ram_js_heap_free never goes negative when used overshoots the limit', () => {
      const h = run({
        v8Heap: () => ({ limit: 100, used: 130, available: 0, malloced: 0, peakMalloced: 0 }),
      });
      expect(h.got.get('ram_js_heap_free')).toBe(0);
    });

    it('v8_heap_* carry their own quantities, distinct from ram_js_heap_* and process_memory_heap_*', () => {
      const h = run({
        v8Heap: () => ({ limit: 900, used: 250, available: 111, malloced: 22, peakMalloced: 33 }),
      });
      expect(h.got.get('v8_heap_size_limit')).toBe(900);
      expect(h.got.get('v8_heap_available')).toBe(111);
      expect(h.got.get('v8_heap_malloced')).toBe(22);
      expect(h.got.get('v8_heap_peak_malloced')).toBe(33);
      expect(h.got.get('process_memory_heap_total')).toBe(20); // committed heap, untouched
    });

    it('re-emits changed values on each tick', () => {
      let used = 300;
      const h = run({
        v8Heap: () => ({ limit: 1000, used, available: 700, malloced: 11, peakMalloced: 12 }),
      });
      used = 400;
      h.tick();
      expect(h.got.get('ram_js_heap_used')).toBe(400);
      expect(h.got.get('ram_js_heap_free')).toBe(600);
    });

    it('omits every v8/ram_js_heap trace when the heap reader answers undefined', () => {
      const h = run({ v8Heap: () => undefined });
      for (const k of h.got.keys()) expect(k).not.toMatch(/^(v8_heap_|ram_js_heap_)/);
      expect(h.got.has('process_memory_rss')).toBe(true);
    });

    it('omits process_memory_limit when its reader answers undefined', () => {
      const h = run({ memoryLimit: () => undefined });
      expect(h.got.has('process_memory_limit')).toBe(false);
      expect(h.got.has('process_uptime_s')).toBe(false); // retired: now environment.app.uptime_s
    });

    it('measuresV8Heap:false wires NO heap reader (Bun): nothing constructed, nothing emitted', () => {
      const { v8Heap: _off, ...base } = constDeps({ eventLoop });
      const h = harness({ ...base, measuresV8Heap: false });
      h.startAll();
      for (const k of h.got.keys()) expect(k).not.toMatch(/^(v8_heap_|ram_js_heap_)/);
    });

    it('measuresConstrainedMemory:false wires NO cap reader: no process_memory_limit even where the runtime would answer', () => {
      const spy = vi
        .spyOn(process as unknown as { constrainedMemory: () => number }, 'constrainedMemory')
        .mockReturnValue(1);
      try {
        const { memoryLimit: _off, ...base } = constDeps({ eventLoop });
        const h = harness({ ...base, measuresConstrainedMemory: false });
        h.startAll();
        expect(h.got.has('process_memory_limit')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('ram_system_free: os.freemem() (not on macOS), MemAvailable first for readsProcMeminfo, native first of all; total stays total', () => {
      const { systemMemory: _s, ...base } = constDeps({ eventLoop });
      const run1 = (over: NodeTraceProducerDeps) => {
        const h = harness({ ...base, memoryLimit: () => undefined, ...over });
        h.startAll();
        return h.got;
      };
      const meminfo = () => 'MemAvailable: 3 kB\n';
      expect(run1({ platform: 'linux', meminfo, freeMemory: () => 9 }).get('ram_system_free')).toBe(
        9,
      );
      expect(
        run1({ platform: 'darwin', freeMemory: () => 9, readsVmStat: false }).has(
          'ram_system_free',
        ),
      ).toBe(false); // os.freemem() is not a macOS source; vm_stat opted out
      expect(
        run1({
          platform: 'darwin',
          freeMemory: () => 9,
          vmStat: { read: () => 8, peek: () => 8, stop: () => {} },
        }).get('ram_system_free'),
      ).toBe(8); // macOS Node/Bun: the vm_stat-derived figure
      expect(
        run1({ platform: 'darwin', nativeAvailableMemory: () => 5 }).get('ram_system_free'),
      ).toBe(5);
      expect(
        run1({ platform: 'linux', readsProcMeminfo: true, meminfo, freeMemory: () => 9 }).get(
          'ram_system_free',
        ),
      ).toBe(3072);
      expect(
        run1({
          platform: 'linux',
          readsProcMeminfo: true,
          meminfo: () => undefined,
          freeMemory: () => 9,
        }).get('ram_system_free'),
      ).toBe(9);
      const none = run1({ platform: 'linux', freeMemory: () => Number.NaN });
      expect(none.has('ram_system_free')).toBe(false);
      expect(Number(none.get('ram_system_total'))).toBeGreaterThan(0);
    });

    it('an explicit undefined reader does not clobber the wired default (measures* true)', () => {
      const { v8Heap: _a, memoryLimit: _b, ...base } = constDeps({ eventLoop });
      const h = harness({
        ...base,
        v8Heap: undefined,
        memoryLimit: undefined,
      });
      h.startAll();
      expect(Number(h.got.get('v8_heap_size_limit'))).toBeGreaterThan(0); // the real node default, not absent
    });

    it('no runtime-depth trace is held for refresh: a value that later becomes unavailable must not be re-recorded as stale', () => {
      let limit: number | undefined = 500;
      const calls: Array<[string, unknown, { hold?: boolean } | undefined]> = [];
      const h = harness(constDeps({ eventLoop, memoryLimit: () => limit }));
      for (const p of h.producers) {
        p.start({ emit: (n, v, _d, o) => void calls.push([n, v, o]) });
      }
      h.tick();
      const per = (name: string) => calls.filter(([n]) => n === name);
      for (const name of ['v8_heap_size_limit', 'ram_js_heap_total', 'process_memory_limit']) {
        expect(per(name)).toHaveLength(2); // baseline + tick, even though the value did not change
        expect(per(name).every(([, , o]) => o?.hold === false)).toBe(true);
      }
      limit = undefined; // the cap is lifted
      h.tick();
      expect(per('process_memory_limit')).toHaveLength(2); // nothing further: omitted, not carried forward
    });

    it('wires the real process.constrainedMemory() by default (a real cap is reported, no cap is not)', () => {
      const proc = process as { constrainedMemory?: () => number };
      const original = Object.getOwnPropertyDescriptor(process, 'constrainedMemory');
      const set = (fn: () => number) =>
        Object.defineProperty(process, 'constrainedMemory', { value: fn, configurable: true });
      try {
        set(() => 1234);
        const { memoryLimit: _off, ...base } = constDeps({ eventLoop });
        const capped = harness(base);
        capped.startAll();
        expect(capped.got.get('process_memory_limit')).toBe(1234);
        set(() => 0);
        const free = harness(base);
        free.startAll();
        expect(free.got.has('process_memory_limit')).toBe(false);
      } finally {
        if (original) Object.defineProperty(process, 'constrainedMemory', original);
        else delete proc.constrainedMemory;
      }
    });

    it('stopping the producers releases the timer exactly once', () => {
      const h = run({});
      h.stopAll();
      expect(h.spy.cleared).toBe(1);
    });
  });

  it('CPU producer: user, system and process% are each their own value (distinct non-zero steps)', () => {
    let user = 0;
    let system = 0;
    let wall = 0;
    const h = harness(
      constDeps({
        cpuUsage: () => ({ user, system }),
        monotonicNowMs: () => wall,
        cpuCount: () => 2,
      }),
    );
    h.startAll();
    user += 100_000; // µs
    system += 50_000; // µs
    wall += 1000; // ms
    h.tick();
    expect(h.got.get('cpu_usage_user')).toBe(100_000);
    expect(h.got.get('cpu_usage_system')).toBe(50_000);
    // (100 000 + 50 000) µs busy / (1 000 ms * 1 000) µs wall / 2 cores * 100 = 7.5 %
    expect(h.got.get('cpu_usage_process')).toBe(7.5);
  });

  it('emits a baseline on start, before any tick', () => {
    const h = harness(constDeps(steppingCpu()));
    h.startAll();
    expect(h.got.get('process_memory_rss')).toBe(10);
    // no CPU baseline: no window has elapsed, so a start value would be invented
    expect(h.got.has('cpu_usage_user')).toBe(false);
    expect(h.got.has('cpu_usage_system')).toBe(false);
    expect(h.got.has('cpu_usage_process')).toBe(false);
    h.tick();
    expect(h.got.has('cpu_usage_process')).toBe(true);
  });

  it('a restart while the stage stays armed re-emits NO window (cpu, event-loop lag, utilization)', () => {
    const h = harness(
      constDeps({
        eventLoop: { start() {}, stop() {}, read: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }) },
        eventLoopUtilization: () => 50,
      }),
    );
    h.startAll();
    h.tick();
    expect(h.got.has('event_loop_lag_ms')).toBe(true);
    // keep every windowed stage armed through another subscriber, then restart the producers
    const tracker = processTrackerFor({ key: harnessKey.at(-1) as object });
    const keep = [
      tracker.on('cpu', () => {}),
      tracker.on('eventLoop', () => {}),
      tracker.on('utilization', () => {}),
    ];
    h.stopAll();
    h.got.clear();
    h.startAll();
    for (const name of [
      'cpu_usage_user',
      'cpu_usage_process',
      'event_loop_lag_ms',
      'event_loop_utilization',
    ]) {
      expect(h.got.has(name), name).toBe(false);
    }
    for (const off of keep) off();
  });

  it('a zero wall window omits cpu_usage_process (never 0) but still writes the real user/system deltas', () => {
    let calls = 0;
    const h = harness(
      constDeps({
        cpuUsage: () => {
          calls += 1;
          return { user: calls * 100, system: calls * 50 };
        },
        monotonicNowMs: () => 5, // the clock never advances: a zero-length window
      }),
    );
    h.startAll();
    h.tick();
    expect(h.got.has('cpu_usage_process')).toBe(false);
    expect(h.got.get('cpu_usage_user')).toBe(100);
    expect(h.got.get('cpu_usage_system')).toBe(50);
  });

  it.each([
    ['meanMs', { maxMs: 2, p99Ms: 3 }, ['event_loop_lag_max_ms', 'event_loop_lag_p99_ms']],
    ['maxMs', { meanMs: 1, p99Ms: 3 }, ['event_loop_lag_ms', 'event_loop_lag_p99_ms']],
    ['p99Ms', { meanMs: 1, maxMs: 2 }, ['event_loop_lag_ms', 'event_loop_lag_max_ms']],
    ['every field', {}, []],
  ])('with %s absent, only the measurable lag traces are written (never a 0)', (_n, reading, written) => {
    const h = harness(
      constDeps({ eventLoop: { read: () => reading, start: () => {}, stop: () => {} } }),
    );
    h.startAll();
    h.tick();
    const lag = ['event_loop_lag_ms', 'event_loop_lag_max_ms', 'event_loop_lag_p99_ms'];
    expect(lag.filter((n) => h.got.has(n)).sort()).toEqual([...written].sort());
  });

  it('omits lag and utilization when no eventLoop / utilization source answers', () => {
    const h = harness(
      constDeps({ measuresEventLoopDelay: false, eventLoopUtilization: () => undefined }),
    );
    h.startAll();
    h.tick();
    expect(h.got.has('event_loop_lag_ms')).toBe(false);
    expect(h.got.has('event_loop_lag_max_ms')).toBe(false);
    expect(h.got.has('event_loop_lag_p99_ms')).toBe(false);
    expect(h.got.has('event_loop_utilization')).toBe(false);
    expect(h.got.has('process_memory_rss')).toBe(true);
  });

  it('omits lag (never zero) when the source read() is undefined', () => {
    const h = harness(constDeps({ eventLoop: { ...eventLoop, read: () => undefined } }));
    h.startAll();
    h.tick();
    expect(h.got.has('event_loop_lag_ms')).toBe(false);
  });

  it('measuresEventLoopDelay:false never constructs a histogram; ELU still reported', () => {
    const { perfHooks, state } = fakePerfHooks();
    const h = harness({ ...constDeps(), perfHooks, measuresEventLoopDelay: false });
    h.startAll();
    h.tick();
    h.stopAll();
    expect(state.monitor).toBe(0);
    expect(h.got.has('event_loop_lag_ms')).toBe(false);
    expect(h.got.get('event_loop_utilization')).toBe(30);
  });

  it('default perfHooks path reports lag from a real-shaped histogram, lazily', () => {
    const { perfHooks, state } = fakePerfHooks();
    const h = harness({ ...constDeps(), perfHooks });
    expect(state.monitor).toBe(0);
    expect(h.spy.set).toBe(0);
    h.startAll();
    h.tick();
    expect(h.got.get('event_loop_lag_ms')).toBe(2);
    expect(h.got.get('event_loop_lag_max_ms')).toBe(9);
    expect(h.got.get('event_loop_lag_p99_ms')).toBe(7);
  });

  it('NO FABRICATED LAG BASELINE: lag is absent at start (empty histogram) and appears once it has sampled', () => {
    const { perfHooks, histogram } = fakePerfHooks();
    histogram.count = 0;
    histogram.mean = Number.NaN;
    const h = harness({ ...constDeps(), perfHooks });
    h.startAll();
    expect(h.got.has('process_memory_rss')).toBe(true); // the baseline itself was emitted
    expect(h.got.has('event_loop_lag_ms')).toBe(false);
    expect(h.got.has('event_loop_lag_max_ms')).toBe(false);
    expect(h.got.has('event_loop_lag_p99_ms')).toBe(false);
    histogram.count = 2;
    histogram.mean = 4e6;
    h.tick();
    expect(h.got.get('event_loop_lag_ms')).toBe(4);
    expect(h.got.get('event_loop_lag_max_ms')).toBe(9);
    expect(h.got.get('event_loop_lag_p99_ms')).toBe(7);
  });

  it('real node perf_hooks: the start baseline carries NO lag traces (nothing measured yet)', () => {
    const got = new Map<string, unknown>();
    const ps = createNodeSystemTraceProducers({ key: {} });
    for (const p of ps) p.start({ emit: (n, v) => void got.set(n, v) });
    for (const p of ps) p.stop();
    expect(got.has('event_loop_lag_ms')).toBe(false);
    expect(got.has('event_loop_lag_max_ms')).toBe(false);
    expect(got.has('event_loop_lag_p99_ms')).toBe(false);
  });

  it('gate: creating the producers constructs no histogram and starts no timer until start', () => {
    const { perfHooks, state } = fakePerfHooks();
    const h = harness({ ...constDeps(), perfHooks });
    expect(h.producers).toHaveLength(7);
    expect(state.monitor).toBe(0);
    expect(h.spy.set).toBe(0);
    h.producers[0]?.start({ emit: () => {} }); // memory: arms the shared timer only
    expect(h.spy.set).toBe(1);
    expect(state.monitor).toBe(0); // per-stage activation: nothing builds the histogram for a memory subscriber
    h.producers[3]?.start({ emit: () => {} }); // event-loop-lag
    expect(h.spy.set).toBe(1); // still ONE shared timer
    expect(state.monitor).toBe(1);
    expect(state.enabled).toBe(true);
  });

  it('stop of all producers disables the histogram and clears the interval', () => {
    const { perfHooks, state } = fakePerfHooks();
    const h = harness({ ...constDeps(), perfHooks });
    h.startAll();
    expect(h.spy.set).toBe(1); // one shared timer for five producers
    h.stopAll();
    expect(state.enabled).toBe(false);
    expect(state.disables).toBe(1);
    expect(h.spy.cleared).toBe(1);
  });

  it('a stopped producer no longer receives ticks', () => {
    const h = harness(constDeps());
    h.startAll();
    h.stopAll();
    h.got.clear();
    h.tick();
    expect(h.got.size).toBe(0);
  });

  it('shared tracker: three+ producers do not multiply the CPU baseline advance', () => {
    let u = 0;
    let w = 0;
    const h = harness(
      constDeps({
        cpuUsage: () => {
          u += 100_000;
          return { user: u, system: 0 };
        },
        monotonicNowMs: () => {
          w += 1000;
          return w;
        },
      }),
    );
    h.startAll();
    expect(h.got.has('cpu_usage_user')).toBe(false); // no start value
    h.tick();
    // arming reads 100k (the internal baseline); the single tick reads 200k => one window of
    // 100k no matter how many producers share the tracker
    expect(h.got.get('cpu_usage_user')).toBe(100_000);
  });

  it('a restart re-emits the baseline', () => {
    const h = harness(constDeps());
    h.startAll();
    h.stopAll();
    h.got.clear();
    h.startAll();
    expect(h.got.get('ram_system_free')).toBe(400);
    expect(h.spy.set).toBe(2);
  });

  it('a caller-supplied explicit reader wins over the guarded default', () => {
    const { perfHooks } = fakePerfHooks();
    const h = harness({ ...constDeps(), perfHooks, eventLoop, eventLoopUtilization: () => 90 });
    h.startAll();
    h.tick();
    expect(h.got.get('event_loop_lag_ms')).toBe(1);
    expect(h.got.get('event_loop_utilization')).toBe(90);
  });

  it('an explicit undefined reader does not clobber the guarded default', () => {
    const { perfHooks } = fakePerfHooks();
    const h = harness({
      ...constDeps(),
      perfHooks,
      eventLoopUtilization: undefined,
      eventLoop: undefined,
    });
    h.startAll();
    h.tick();
    expect(h.got.get('event_loop_utilization')).toBe(30);
    expect(h.got.get('event_loop_lag_ms')).toBe(2);
  });

  it('works with real node perf_hooks and no injected readers', () => {
    const got = new Map<string, unknown>();
    const ps = createNodeSystemTraceProducers({ key: {} });
    for (const p of ps) p.start({ emit: (n, v) => void got.set(n, v) });
    for (const p of ps) p.stop();
    expect(typeof got.get('process_memory_rss')).toBe('number');
  });

  it('with real node readers and one tick it emits the full catalog, each a finite number', async () => {
    const got = new Map<string, unknown>();
    let tick: (() => void) | undefined;
    const ps = createNodeSystemTraceProducers({
      key: {},
      scheduler: {
        setInterval: (cb) => {
          tick = cb;
          return 'h';
        },
        clearInterval: () => {},
      },
    });
    for (const p of ps) p.start({ emit: (n, v) => void got.set(n, v) });
    // let the real delay histogram take samples: an unsampled one is omitted by design, never reported as 0
    await new Promise((r) => setTimeout(r, 120));
    tick?.();
    for (const p of ps) p.stop();
    // `process_memory_limit` exists only inside a real cgroup cap, so it is checked for what the host can answer.
    // `ram_system_free` on macOS comes from an ASYNC vm_stat read, so the very first tick has no value yet.
    const optional = ['process_memory_limit', 'ram_system_free'];
    expect([...got.keys()].filter((k) => !optional.includes(k)).sort()).toEqual([
      'cpu_usage_process',
      'cpu_usage_system',
      'cpu_usage_user',
      'event_loop_lag_max_ms',
      'event_loop_lag_ms',
      'event_loop_lag_p99_ms',
      'event_loop_utilization',
      'process_memory_array_buffers',
      'process_memory_external',
      'process_memory_heap_total',
      'process_memory_heap_used',
      'process_memory_rss',
      'ram_js_heap_free',
      'ram_js_heap_total',
      'ram_js_heap_used',
      'ram_system_total',
      'v8_heap_available',
      'v8_heap_malloced',
      'v8_heap_peak_malloced',
      'v8_heap_size_limit',
    ]);
    expect(got.has('ram_system_available')).toBe(false); // retired
    if (got.has('ram_system_free')) {
      expect(Number(got.get('ram_system_free'))).toBeLessThanOrEqual(
        Number(got.get('ram_system_total')),
      );
    } else expect(process.platform).toBe('darwin'); // only macOS may lack it on the first tick
    expect(Number(got.get('v8_heap_size_limit'))).toBeGreaterThan(0);
    for (const v of got.values()) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('gc is NOT a trace (C15: it is the `gc` system event)', () => {
  it('no gc_* trace is produced, and the trace producers never construct a GC observer or start a gc source', () => {
    let constructed = 0;
    class Counting {
      constructor() {
        constructed += 1;
      }
      observe() {}
      disconnect() {}
    }
    const gc = {
      start: vi.fn(),
      stop: vi.fn(),
      read: vi.fn(() => ({ count: 3, pauseMs: 1, maxPauseMs: 1 })),
    };
    const h = harness({ ...constDeps({ eventLoop, gc }), performanceObserver: Counting as never });
    h.startAll();
    h.tick();
    h.stopAll();
    expect([...h.got.keys()].filter((k) => k.startsWith('gc_'))).toEqual([]);
    expect(h.producers.map((p) => p.name)).not.toContain('gc');
    expect(constructed).toBe(0);
    expect(gc.start).not.toHaveBeenCalled();
    expect(gc.read).not.toHaveBeenCalled();
  });
});

describe('V8_HEAP_PRODUCER_NAME', () => {
  it('names the producer that writes ram_js_heap_* (Electron main finds the heap owner by it)', () => {
    const h = harness(
      constDeps({
        eventLoop,
        eventLoopUtilization: () => 50,
        v8Heap: () => ({ limit: 900, used: 250, available: 1, malloced: 2, peakMalloced: 3 }),
      }),
    );
    const heap = h.producers.find((p) => p.name === V8_HEAP_PRODUCER_NAME);
    expect(heap).toBeDefined();
    heap?.start({ emit: (n, v) => void h.got.set(n, v) });
    expect([h.got.get('ram_js_heap_total'), h.got.get('ram_js_heap_used')]).toEqual([900, 250]);
    // no OTHER producer writes the heap names
    const others = h.producers.filter((p) => p !== heap);
    const names: string[] = [];
    for (const p of others) p.start({ emit: (n) => void names.push(n) });
    expect(names.some((n) => n.startsWith('ram_js_heap_'))).toBe(false);
  });
});
