import { describe, expect, it } from 'vitest';
import { createNodeSystemTraceProducers, type NodeTraceProducerDeps } from './trace-producers';

function harness(deps: NodeTraceProducerDeps) {
  const got = new Map<string, unknown>();
  const spy = { set: 0, cleared: 0 };
  let tick: (() => void) | undefined;
  const producers = createNodeSystemTraceProducers({
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
    const h = harness(constDeps({ ...steppingCpu(), eventLoop, eventLoopUtilization: () => 0.5 }));
    h.startAll();
    h.tick();
    expect([...h.got.entries()].sort(([x], [y]) => x.localeCompare(y))).toEqual([
      ['cpu_usage_process', 7.5],
      ['cpu_usage_system', 50000],
      ['cpu_usage_user', 100000],
      ['event_loop_lag_max_ms', 2],
      ['event_loop_lag_ms', 1],
      ['event_loop_lag_p99_ms', 3],
      ['event_loop_utilization', 0.5],
      ['process_memory_array_buffers', 50],
      ['process_memory_external', 40],
      ['process_memory_heap_total', 20],
      ['process_memory_heap_used', 30],
      ['process_memory_rss', 10],
      ['ram_system_free', 400],
      ['ram_system_total', 1000],
    ]);
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
    const h = harness(constDeps());
    h.startAll();
    expect(h.got.get('process_memory_rss')).toBe(10);
    expect(h.got.get('cpu_usage_process')).toBe(0);
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
    expect(h.got.get('event_loop_utilization')).toBe(0.3);
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
    const ps = createNodeSystemTraceProducers();
    for (const p of ps) p.start({ emit: (n, v) => void got.set(n, v) });
    for (const p of ps) p.stop();
    expect(got.has('event_loop_lag_ms')).toBe(false);
    expect(got.has('event_loop_lag_max_ms')).toBe(false);
    expect(got.has('event_loop_lag_p99_ms')).toBe(false);
  });

  it('gate: creating the producers constructs no histogram and starts no timer until start', () => {
    const { perfHooks, state } = fakePerfHooks();
    const h = harness({ ...constDeps(), perfHooks });
    expect(h.producers).toHaveLength(5);
    expect(state.monitor).toBe(0);
    expect(h.spy.set).toBe(0);
    h.producers[0]?.start({ emit: () => {} });
    expect(h.spy.set).toBe(1);
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
    const baselineUser = h.got.get('cpu_usage_user');
    h.tick();
    // activation read 100k; the single first read (baseline) is 200k, tick is 300k => one window of 100k each
    expect(baselineUser).toBe(100_000);
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
    const h = harness({ ...constDeps(), perfHooks, eventLoop, eventLoopUtilization: () => 0.9 });
    h.startAll();
    h.tick();
    expect(h.got.get('event_loop_lag_ms')).toBe(1);
    expect(h.got.get('event_loop_utilization')).toBe(0.9);
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
    expect(h.got.get('event_loop_utilization')).toBe(0.3);
    expect(h.got.get('event_loop_lag_ms')).toBe(2);
  });

  it('works with real node perf_hooks and no injected readers', () => {
    const got = new Map<string, unknown>();
    const ps = createNodeSystemTraceProducers();
    for (const p of ps) p.start({ emit: (n, v) => void got.set(n, v) });
    for (const p of ps) p.stop();
    expect(typeof got.get('process_memory_rss')).toBe('number');
  });

  it('with real node readers and one tick it emits the full 14-trace catalog, each a finite number', async () => {
    const got = new Map<string, unknown>();
    let tick: (() => void) | undefined;
    const ps = createNodeSystemTraceProducers({
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
    expect([...got.keys()].sort()).toEqual([
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
      'ram_system_free',
      'ram_system_total',
    ]);
    for (const v of got.values()) expect(Number.isFinite(v)).toBe(true);
  });
});
