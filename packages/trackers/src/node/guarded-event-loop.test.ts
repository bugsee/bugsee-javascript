import { describe, expect, it } from 'vitest';
import {
  createGuardedElu,
  createGuardedEventLoopSource,
  eluUnavailable,
  realPerfHooks,
} from './guarded-event-loop';

// A controllable event-loop delay histogram (readings in ns).
// `count` is the number of samples the histogram has taken (a real Node histogram exposes it).
function fakePerfHooks(
  readings: { mean: number; max: number; p99: number; count?: number } = {
    mean: 2e6,
    max: 9e6,
    p99: 7e6,
    count: 3,
  },
  opts: { disable?: boolean } = {},
) {
  const state = { monitor: 0, enabled: false, enables: 0, disables: 0, resets: 0 };
  const histogram = {
    enable() {
      state.enabled = true;
      state.enables += 1;
    },
    ...(opts.disable === false
      ? {}
      : {
          disable() {
            state.enabled = false;
            state.disables += 1;
          },
        }),
    reset() {
      state.resets += 1;
    },
    get mean() {
      return readings.mean;
    },
    get max() {
      return readings.max;
    },
    percentile() {
      return readings.p99;
    },
  };
  // a LIVE getter (a spread would snapshot it), absent entirely when the runtime has no count
  if (readings.count !== undefined) {
    Object.defineProperty(histogram, 'count', { get: () => readings.count, enumerable: true });
  }
  const monitor = () => {
    state.monitor += 1;
    return histogram;
  };
  return { state, monitor, histogram };
}

describe('createGuardedEventLoopSource', () => {
  it('constructs nothing and enables nothing until start()', () => {
    const { state, monitor } = fakePerfHooks();
    createGuardedEventLoopSource(monitor);
    expect(state.monitor).toBe(0);
    expect(state.enables).toBe(0);
  });

  it('start() constructs + enables once and is idempotent on the histogram; restart reuses it', () => {
    const { state, monitor } = fakePerfHooks();
    const src = createGuardedEventLoopSource(monitor);
    src.start();
    src.start();
    expect(state.monitor).toBe(1);
    expect(state.enabled).toBe(true);
    src.stop();
    expect(state.enabled).toBe(false);
    expect(state.disables).toBe(1);
    src.start();
    expect(state.monitor).toBe(1);
    expect(state.enabled).toBe(true);
  });

  it('start() resets the histogram so stale samples are not read', () => {
    const { state, monitor } = fakePerfHooks();
    createGuardedEventLoopSource(monitor).start();
    expect(state.resets).toBe(1);
  });

  it('stop() tolerates a histogram without disable() and one whose disable throws', () => {
    const a = fakePerfHooks(undefined, { disable: false });
    const s1 = createGuardedEventLoopSource(a.monitor);
    s1.start();
    expect(() => s1.stop()).not.toThrow();
    const b = fakePerfHooks();
    b.histogram.disable = () => {
      throw new Error('boom');
    };
    const s2 = createGuardedEventLoopSource(b.monitor);
    s2.start();
    expect(() => s2.stop()).not.toThrow();
  });

  it('stop() before start() is a no-op', () => {
    const { monitor } = fakePerfHooks();
    expect(() => createGuardedEventLoopSource(monitor).stop()).not.toThrow();
  });

  it('read() is undefined before start(), then ns to ms, and resets the histogram', () => {
    const { state, monitor } = fakePerfHooks({ mean: 2e6, max: 9e6, p99: 7e6, count: 1 });
    const src = createGuardedEventLoopSource(monitor);
    expect(src.read()).toBeUndefined();
    src.start();
    const before = state.resets;
    expect(src.read()).toEqual({ meanMs: 2, maxMs: 9, p99Ms: 7 });
    expect(state.resets).toBe(before + 1);
  });

  it('treats a non-finite reading of a SAMPLED histogram as zero lag', () => {
    const { monitor } = fakePerfHooks({ mean: 5e6, max: Number.NaN, p99: Number.NaN, count: 1 });
    const src = createGuardedEventLoopSource(monitor);
    src.start();
    expect(src.read()).toEqual({ meanMs: 5, maxMs: 0, p99Ms: 0 });
  });

  it('treats an infinite reading as zero lag too (not only NaN)', () => {
    const { monitor } = fakePerfHooks({
      mean: Number.POSITIVE_INFINITY,
      max: 4e6,
      p99: Number.POSITIVE_INFINITY,
      count: 1,
    });
    const src = createGuardedEventLoopSource(monitor);
    src.start();
    expect(src.read()).toEqual({ meanMs: 0, maxMs: 4, p99Ms: 0 });
  });

  it('NO FABRICATED BASELINE: read() is undefined until the histogram has a sample (count 0), and does not reset it', () => {
    const readings = { mean: Number.NaN, max: 0, p99: 0, count: 0 };
    const { state, monitor } = fakePerfHooks(readings);
    const src = createGuardedEventLoopSource(monitor);
    src.start();
    const resets = state.resets;
    expect(src.read()).toBeUndefined();
    expect(state.resets).toBe(resets);
    // count is authoritative even when mean is finite
    readings.mean = 1e6;
    expect(src.read()).toBeUndefined();
    Object.assign(readings, { count: 4, mean: 3e6, max: 8e6, p99: 6e6 });
    expect(src.read()).toEqual({ meanMs: 3, maxMs: 8, p99Ms: 6 });
  });

  it('NO FABRICATED BASELINE without a count property: a non-finite mean means "no sample yet"', () => {
    const readings = { mean: Number.NaN, max: 0, p99: 0 };
    const { monitor } = fakePerfHooks(readings);
    const src = createGuardedEventLoopSource(monitor);
    src.start();
    expect(src.read()).toBeUndefined();
    readings.mean = 2e6;
    expect(src.read()).toEqual({ meanMs: 2, maxMs: 0, p99Ms: 0 });
  });

  it('real node histogram: undefined right after start(), real values once it has sampled', async () => {
    const src = createGuardedEventLoopSource(realPerfHooks.monitorEventLoopDelay);
    src.start();
    try {
      expect(src.read()).toBeUndefined();
      let out = src.read();
      for (let i = 0; i < 100 && out === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        out = src.read();
      }
      expect(out).toBeDefined();
      expect(out?.meanMs).toBeGreaterThan(0);
      expect(Number.isFinite(out?.maxMs)).toBe(true);
      expect(Number.isFinite(out?.p99Ms)).toBe(true);
    } finally {
      src.stop();
    }
  });

  it('enable() succeeded but reset() threw: the histogram is disabled before it is dropped', () => {
    const { state, histogram } = fakePerfHooks();
    histogram.reset = () => {
      throw new Error('reset refused');
    };
    const src = createGuardedEventLoopSource(() => histogram);
    expect(() => src.start()).not.toThrow();
    expect(state.enables).toBe(1);
    expect(state.disables).toBe(1);
    expect(state.enabled).toBe(false);
    expect(src.read()).toBeUndefined();
  });

  it('a failed start tolerates a disable() that also throws (and one that is absent)', () => {
    const a = fakePerfHooks();
    a.histogram.reset = () => {
      throw new Error('reset refused');
    };
    a.histogram.disable = () => {
      throw new Error('disable refused');
    };
    expect(() => createGuardedEventLoopSource(() => a.histogram).start()).not.toThrow();
    const b = fakePerfHooks(undefined, { disable: false });
    b.histogram.reset = () => {
      throw new Error('reset refused');
    };
    const src = createGuardedEventLoopSource(() => b.histogram);
    expect(() => src.start()).not.toThrow();
    expect(src.read()).toBeUndefined();
  });

  it('a throwing monitorEventLoopDelay: start() does not throw, read() stays undefined, no retry', () => {
    let calls = 0;
    const src = createGuardedEventLoopSource(() => {
      calls += 1;
      throw new Error('unsupported');
    });
    expect(() => src.start()).not.toThrow();
    expect(src.read()).toBeUndefined();
    src.start();
    expect(calls).toBe(1);
    expect(() => src.stop()).not.toThrow();
  });

  it('a throwing enable(): start() does not throw and read() stays undefined', () => {
    const { histogram } = fakePerfHooks();
    histogram.enable = () => {
      throw new Error('refused');
    };
    const src = createGuardedEventLoopSource(() => histogram);
    expect(() => src.start()).not.toThrow();
    expect(src.read()).toBeUndefined();
  });

  it('a histogram READ that throws yields undefined, not a throw', () => {
    const throwing = {
      enable() {},
      reset() {},
      get mean(): number {
        throw new Error('read failed');
      },
      get max() {
        return 0;
      },
      percentile() {
        return 0;
      },
    };
    const src = createGuardedEventLoopSource(() => throwing);
    src.start();
    expect(src.read()).toBeUndefined();
  });
});

describe('createGuardedElu', () => {
  const fakeElu =
    (delta: number) =>
    (a?: { utilization: number }): { utilization: number; idle: number; active: number } =>
      a === undefined
        ? { utilization: 0, idle: 5, active: 5 }
        : { utilization: delta, idle: 5, active: 5 };

  it('returns the utilization delta when the runtime answers honestly', () => {
    expect(createGuardedElu(fakeElu(0.42))()).toBe(0.42);
  });

  it('is undefined on the Bun/Deno shape (idle and active both 0)', () => {
    expect(createGuardedElu(() => ({ idle: 0, active: 0, utilization: 0 }))()).toBeUndefined();
  });

  it('keeps a genuine zero when idle time actually passed', () => {
    expect(createGuardedElu(() => ({ idle: 1000, active: 0, utilization: 0 }))()).toBe(0);
  });

  it('is undefined when the initial call throws', () => {
    expect(
      createGuardedElu(() => {
        throw new Error('unsupported');
      })(),
    ).toBeUndefined();
  });

  it('is undefined when the delta READ throws', () => {
    const elu = (a?: { utilization: number }): { utilization: number } => {
      if (a !== undefined) throw new Error('delta failed');
      return { utilization: 0 };
    };
    expect(createGuardedElu(elu)()).toBeUndefined();
  });

  it('advances the baseline between reads', () => {
    const snapshots: Array<{ utilization: number; idle: number; active: number }> = [];
    const prevSeen: unknown[] = [];
    const elu = (a?: { utilization: number }, b?: { utilization: number }) => {
      if (a !== undefined) {
        prevSeen.push(b);
        return { utilization: 0.5, idle: 1, active: 1 };
      }
      const snap = { utilization: snapshots.length, idle: 1, active: 1 };
      snapshots.push(snap);
      return snap;
    };
    const read = createGuardedElu(elu);
    read();
    read();
    // init snapshot[0]; read1 takes snapshot[1] (prev = [0]); read2 takes snapshot[2] (prev = [1]).
    expect(prevSeen[0]).toBe(snapshots[0]);
    expect(prevSeen[1]).toBe(snapshots[1]);
  });
});

describe('realPerfHooks + eluUnavailable', () => {
  it('wraps the live node:perf_hooks', () => {
    const h = realPerfHooks.monitorEventLoopDelay();
    expect(typeof h.enable).toBe('function');
    const e = realPerfHooks.eventLoopUtilization();
    expect(typeof e.utilization).toBe('number');
    expect(
      typeof realPerfHooks.eventLoopUtilization(realPerfHooks.eventLoopUtilization(), e)
        .utilization,
    ).toBe('number');
  });
  it('eluUnavailable is true only for an all-zero delta (idle AND active zero)', () => {
    expect(eluUnavailable({ idle: 0, active: 0 })).toBe(true);
    expect(eluUnavailable({ idle: 1, active: 0 })).toBe(false);
    expect(eluUnavailable({ idle: 0, active: 1 })).toBe(false); // busy with no idle is a real reading
    expect(eluUnavailable({ active: 0 })).toBe(false); // no `idle` field: cannot claim unavailable
  });
});
