import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureCoordinator,
  createCaptureExporter,
  createMemoryCaptureStore,
  createOperationDispatcher,
  createOptionsContainer,
  type OptionsContainer,
  type Scheduler,
} from '@bugsee/core';
import type { TraceName } from '@bugsee/protocol';
import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createSystemTracesProvider,
  deriveRefreshMs,
  type TraceSample,
} from './system-traces-provider';
import { type TraceProducer, TraceProducerBase, type TraceSink } from './trace-producer';

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const drainSystem = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('traces.system');

// A fake scheduler that captures the callback + interval and lets the test fire it manually.
function fakeScheduler() {
  let callback: (() => void) | null = null;
  let interval = 0;
  let cleared = 0;
  const scheduler: Scheduler = {
    setInterval: (cb, ms) => {
      callback = cb;
      interval = ms;
      return 'handle';
    },
    clearInterval: () => {
      cleared += 1;
    },
  };
  return { scheduler, tick: () => callback?.(), interval: () => interval, cleared: () => cleared };
}

describe('createSystemTracesProvider', () => {
  it('is named "traces.system" and gated by captureSystemTraces', () => {
    const p = createSystemTracesProvider({ sample: () => [] });
    expect(p.name).toBe('traces.system');
    expect(p.controllingOption).toBe(BugseeOption.CaptureSystemTraces);
  });

  it('emits an initial snapshot on start and registers the interval (default 1000ms)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const sample = (): TraceSample[] => [
      { name: 'mem', value: 10 },
      { name: 'cpu', value: 5 },
    ];
    const p = createSystemTracesProvider({ sample, scheduler: fs.scheduler, now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);
    expect((await drainSystem(store))?.map((e) => e.data)).toEqual([
      { timestamp: 1000, name: 'mem', value: 10 },
      { timestamp: 1000, name: 'cpu', value: 5 },
    ]);
    expect(await drainSystem(store)).toHaveLength(2);
    expect(fs.interval()).toBe(1000);
  });

  it('emits another sample on each interval tick (clock advances)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const sample = (): TraceSample[] => [{ name: 'mem', value: t }];
    const p = createSystemTracesProvider({ sample, scheduler: fs.scheduler, now: () => (t += 1) });
    p.init(buildInit(store));
    p.start(options); // initial sample (t→1)
    fs.tick(); // second sample (t→2)
    fs.tick(); // third sample (t→3)
    expect((await drainSystem(store))?.map((e) => (e.data as { value: number }).value)).toEqual([
      1, 2, 3,
    ]);
  });

  it('honors a custom interval', () => {
    const fs = fakeScheduler();
    const p = createSystemTracesProvider({
      sample: () => [],
      scheduler: fs.scheduler,
      intervalMs: 500,
    });
    p.init(buildInit(mkStore()));
    p.start(options);
    expect(fs.interval()).toBe(500);
  });

  it('emits nothing for an empty sample', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const p = createSystemTracesProvider({ sample: () => [], scheduler: fs.scheduler });
    p.init(buildInit(store));
    p.start(options);
    fs.tick();
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('clears the interval on stop', () => {
    const fs = fakeScheduler();
    const p = createSystemTracesProvider({ sample: () => [], scheduler: fs.scheduler });
    p.init(buildInit(mkStore()));
    p.start(options);
    p.stop();
    expect(fs.cleared()).toBe(1);
  });

  it('integrates through the coordinator (disabled → no sampling)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(
      createSystemTracesProvider({
        sample: () => [{ name: 'm', value: 1 }],
        scheduler: fs.scheduler,
      }),
    );
    coordinator.start(options, () => false); // captureSystemTraces disabled
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
    expect(fs.interval()).toBe(0); // never started → no interval
  });

  it('uses the default (global, unref-ed) scheduler when none is injected', async () => {
    vi.useFakeTimers();
    try {
      const store = mkStore();
      let n = 0;
      const p = createSystemTracesProvider({
        sample: () => [{ name: 't', value: n++ }],
        now: () => 1,
      });
      p.init(buildInit(store));
      p.start(options); // initial (value 0)
      vi.advanceTimersByTime(1000); // tick → value 1
      p.stop(); // clearInterval
      vi.advanceTimersByTime(3000); // no further emits
      expect((await drainSystem(store))?.map((e) => (e.data as { value: number }).value)).toEqual([
        0, 1,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

class Fixed extends TraceProducerBase {
  readonly name: string;
  startedCount = 0;
  stoppedCount = 0;
  constructor(
    name: string,
    readonly seed: Array<[string, unknown, number?]>,
    private readonly opts: { throwStart?: boolean; throwStop?: boolean; held?: boolean } = {},
  ) {
    super();
    this.name = name;
  }
  #out(n: string, v: unknown, d?: number): void {
    // the provider's own tests drive it with arbitrary names (it is name-agnostic); only real producers are typed
    if (this.opts.held) this.emitIfChanged(n as TraceName, v, d);
    else this.emit(n as TraceName, v, d);
  }
  protected onStart(): void {
    this.startedCount += 1;
    for (const [n, v, d] of this.seed) this.#out(n, v, d);
    if (this.opts.throwStart) throw new Error(`${this.name} start boom`);
  }
  protected override onStop(): void {
    this.stoppedCount += 1;
    if (this.opts.throwStop) throw new Error(`${this.name} stop boom`);
  }
  push(n: string, v: unknown): void {
    this.#out(n, v);
  }
}
const values = async (store: CaptureStore) =>
  (await drainSystem(store))?.map(
    (e) => e.data as { name: string; value: unknown; timestamp: number; displayId?: number },
  ) ?? [];

describe('createSystemTracesProvider — producers', () => {
  it('starts every producer, routing their emits to traces.system with the provider timestamp', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const a = new Fixed('a', [['x', 1]]);
    const b = new Fixed('b', [['y', 2, 0]]);
    const p = createSystemTracesProvider({
      producers: [a, b],
      scheduler: fs.scheduler,
      now: () => 1000,
    });
    p.init(buildInit(store));
    p.start(options);
    expect(await values(store)).toEqual([
      { timestamp: 1000, name: 'x', value: 1 },
      { timestamp: 1000, name: 'y', value: 2, displayId: 0 },
    ]);
  });

  it('isolates a producer whose start() throws: reports, stops it, the others still start', () => {
    const fs = fakeScheduler();
    const errors: unknown[] = [];
    const bad = new Fixed('bad', [], { throwStart: true });
    const good = new Fixed('good', [['x', 1]]);
    const p = createSystemTracesProvider({
      producers: [bad, good],
      scheduler: fs.scheduler,
      onError: (e) => errors.push(e),
    });
    p.init(buildInit(mkStore()));
    expect(() => p.start(options)).not.toThrow();
    expect(good.startedCount).toBe(1);
    expect(bad.stoppedCount).toBe(1);
    expect((errors[0] as Error).message).toBe('bad start boom');
  });

  it('isolates a producer whose stop() throws: the rest still stop, the timer is cleared', () => {
    const fs = fakeScheduler();
    const errors: unknown[] = [];
    const bad = new Fixed('bad', [], { throwStop: true });
    const good = new Fixed('good', []);
    const p = createSystemTracesProvider({
      producers: [bad, good],
      scheduler: fs.scheduler,
      onError: (e) => errors.push(e),
    });
    p.init(buildInit(mkStore()));
    p.start(options);
    expect(() => p.stop()).not.toThrow();
    expect(good.stoppedCount).toBe(1);
    expect(fs.cleared()).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('never starts a producer when captureSystemTraces is off (coordinator gate)', () => {
    const fs = fakeScheduler();
    const a = new Fixed('a', [['x', 1]]);
    const coordinator = createCaptureCoordinator(buildInit(mkStore()));
    coordinator.addProvider(
      createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler }),
    );
    coordinator.start(options, () => false);
    expect(a.startedCount).toBe(0);
    coordinator.stop();
    expect(a.stoppedCount).toBe(0);
  });

  it('drops a producer emit that arrives after stop() (a late tracker callback)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const a = new Fixed('a', []);
    const p = createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler, now: () => 1 });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    a.push('x', 1);
    expect(await values(store)).toEqual([]);
  });

  it('restart: producers start again and the baseline re-emits', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const a = new Fixed('a', [['x', 1]]);
    const p = createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler, now: () => 1 });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    p.start(options);
    expect(a.startedCount).toBe(2);
    expect((await values(store)).map((v) => v.name)).toEqual(['x', 'x']);
  });

  it('REFRESH: re-emits a held value once it is older than refreshMs, and not before', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const a = new Fixed('a', [['battery', 50]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10_000,
    });
    p.init(buildInit(store));
    p.start(options);
    t = 9_999;
    fs.tick();
    t = 10_000;
    fs.tick();
    t = 10_500;
    fs.tick();
    expect((await values(store)).map((v) => [v.name, v.timestamp])).toEqual([
      ['battery', 0],
      ['battery', 10_000],
    ]);
  });

  it('REFRESH keeps displayId so per-display values are distinct and re-emitted with it', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const a = new Fixed(
      'a',
      [
        ['o', 1, 0],
        ['o', 2, 1],
      ],
      { held: true },
    );
    const p = createSystemTracesProvider({
      producers: [a],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10,
    });
    p.init(buildInit(store));
    p.start(options);
    t = 10;
    fs.tick();
    expect((await values(store)).map((v) => [v.value, v.displayId, v.timestamp])).toEqual([
      [1, 0, 0],
      [2, 1, 0],
      [1, 0, 10],
      [2, 1, 10],
    ]);
  });

  it('NO REFRESH for a polled (non-held) value: a producer whose poll fails stops appearing, never frozen at its last value', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const cpu = new Fixed('cpu', [
      ['cpu_usage_process', 12],
      ['memory_process', 3],
    ]);
    const p = createSystemTracesProvider({
      producers: [cpu],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10_000,
    });
    p.init(buildInit(store));
    p.start(options);
    // the tracker's poll now throws, so the producer emits nothing more — for well past refreshMs
    for (t = 1_000; t <= 35_000; t += 1_000) fs.tick();
    expect((await values(store)).map((v) => [v.name, v.timestamp])).toEqual([
      ['cpu_usage_process', 0],
      ['memory_process', 0],
    ]);
  });

  it('NO REFRESH for legacy sample() entries (they are re-read each tick, never held)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    let rows: TraceSample[] = [{ name: 'm', value: 1 }];
    const p = createSystemTracesProvider({
      sample: () => rows,
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10,
    });
    p.init(buildInit(store));
    p.start(options);
    rows = []; // the sampler has nothing to say any more
    t = 100;
    fs.tick();
    t = 200;
    fs.tick();
    expect((await values(store)).map((v) => v.timestamp)).toEqual([0]);
  });

  it('the sink holds ONLY an explicit hold: true (an emit without options is not refreshed)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const raw: TraceProducer = {
      name: 'raw',
      start: (sink) => {
        sink.emit('plain' as TraceName, 1);
        sink.emit('truthy' as TraceName, 2, undefined, { hold: 1 as unknown as boolean });
        sink.emit('held' as TraceName, 3, undefined, { hold: true });
      },
      stop: () => {},
    };
    const p = createSystemTracesProvider({
      producers: [raw],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10,
    });
    p.init(buildInit(store));
    p.start(options);
    t = 10;
    fs.tick();
    expect((await values(store)).map((v) => [v.name, v.timestamp])).toEqual([
      ['plain', 0],
      ['truthy', 0],
      ['held', 0],
      ['held', 10],
    ]);
  });

  it('refreshMs: Infinity disables the refresh', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const a = new Fixed('a', [['x', 1]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: Number.POSITIVE_INFINITY,
    });
    p.init(buildInit(store));
    p.start(options);
    t = 1e9;
    fs.tick();
    expect(await values(store)).toHaveLength(1);
  });

  it('a value that keeps changing is not refreshed (its latest timestamp is fresh)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const a = new Fixed('a', [['x', 0]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10_000,
    });
    p.init(buildInit(store));
    p.start(options);
    t = 9_000;
    a.push('x', 1);
    t = 12_000;
    fs.tick();
    expect((await values(store)).map((v) => v.value)).toEqual([0, 1]);
  });

  it('the snapshot is cleared on stop and on restart (no stale refresh)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const a = new Fixed('a', [['x', 1]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10,
    });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    a.seed.length = 0;
    t = 100;
    p.start(options);
    t = 200;
    fs.tick();
    expect((await values(store)).map((v) => v.timestamp)).toEqual([0]);
  });

  it('stop() clears the snapshot: a stray tick after stop does not refresh', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const a = new Fixed('a', [['x', 1]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10,
    });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    t = 100;
    fs.tick();
    expect(await values(store)).toHaveLength(1);
  });

  it('a failed start (initial sample threw) leaves no stale snapshot for the next start', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    let fail = true;
    const a = new Fixed('a', [['x', 1]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      sample: () => {
        if (fail) throw new Error('boom');
        return [];
      },
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10,
    });
    p.init(buildInit(store));
    expect(() => p.start(options)).toThrow('boom');
    fail = false;
    a.seed.length = 0;
    t = 100;
    p.start(options);
    t = 200;
    fs.tick();
    expect((await values(store)).map((v) => v.timestamp)).toEqual([0]);
  });

  it('drops an emit from a producer that kept the sink past stop() (provider-side guard)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let kept: TraceSink | undefined;
    const rogue: TraceProducer = {
      name: 'rogue',
      start: (sink) => {
        kept = sink;
      },
      stop: () => {},
    };
    const p = createSystemTracesProvider({
      producers: [rogue],
      scheduler: fs.scheduler,
      now: () => 1,
    });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    kept?.emit('x' as TraceName, 1);
    expect(await values(store)).toEqual([]);
  });

  it('without onError a producer failure is swallowed silently (default no-op reporter)', () => {
    const fs = fakeScheduler();
    const bad = new Fixed('bad', [], { throwStart: true });
    const p = createSystemTracesProvider({ producers: [bad], scheduler: fs.scheduler });
    p.init(buildInit(mkStore()));
    expect(() => p.start(options)).not.toThrow();
    expect(bad.stoppedCount).toBe(1);
  });

  it('the timer never lets an exception escape: a throwing legacy sample() goes to onError', () => {
    const fs = fakeScheduler();
    const errors: unknown[] = [];
    let n = 0;
    const p = createSystemTracesProvider({
      sample: () => {
        n += 1;
        if (n > 1) throw new Error('tick boom');
        return [];
      },
      scheduler: fs.scheduler,
      onError: (e) => errors.push(e),
    });
    p.init(buildInit(mkStore()));
    p.start(options);
    expect(() => fs.tick()).not.toThrow();
    expect((errors[0] as Error).message).toBe('tick boom');
  });

  it('a throwing INITIAL legacy sample stops the started producers and rethrows (launch routes it to onError)', () => {
    const fs = fakeScheduler();
    const a = new Fixed('a', []);
    const p = createSystemTracesProvider({
      producers: [a],
      sample: () => {
        throw new Error('sample boom');
      },
      scheduler: fs.scheduler,
    });
    p.init(buildInit(mkStore()));
    expect(() => p.start(options)).toThrow('sample boom');
    expect(a.stoppedCount).toBe(1);
    expect(fs.interval()).toBe(0);
  });

  it('legacy: `sample` alone still behaves exactly as before (initial snapshot + interval)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const p = createSystemTracesProvider({
      sample: () => [{ name: 'm', value: 1 }],
      scheduler: fs.scheduler,
      now: () => 5,
    });
    p.init(buildInit(store));
    p.start(options);
    fs.tick();
    expect(await values(store)).toHaveLength(2);
    expect(fs.interval()).toBe(1000);
  });

  it('requires producers or sample (a provider with neither is a programming error)', () => {
    expect(() => createSystemTracesProvider({} as never)).toThrow(/producers or sample/);
  });
});

describe('createSystemTracesProvider — hardening', () => {
  it('a throwing legacy sample() does not stop the refresh of held values on the same tick', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const errors: unknown[] = [];
    let t = 0;
    let n = 0;
    const a = new Fixed('a', [['battery', 50]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      sample: () => {
        n += 1;
        if (n > 1) throw new Error('sample boom');
        return [];
      },
      scheduler: fs.scheduler,
      now: () => t,
      refreshMs: 10,
      onError: (e) => errors.push(e),
    });
    p.init(buildInit(store));
    p.start(options);
    t = 10;
    fs.tick();
    expect((errors[0] as Error).message).toBe('sample boom');
    expect((await values(store)).map((v) => [v.name, v.timestamp])).toEqual([
      ['battery', 0],
      ['battery', 10],
    ]);
  });

  it('a throwing scheduler.setInterval on start unwinds like a failed initial sample (stop producers, not running, rethrow)', async () => {
    const store = mkStore();
    let refuse = true;
    let cb: (() => void) | undefined;
    const scheduler: Scheduler = {
      setInterval: (c) => {
        if (refuse) throw new Error('no timers');
        cb = c;
        return 'h';
      },
      clearInterval: () => {},
    };
    let t = 0;
    const a = new Fixed('a', [['x', 1]], { held: true });
    const p = createSystemTracesProvider({
      producers: [a],
      scheduler,
      now: () => t,
      refreshMs: 10,
    });
    p.init(buildInit(store));
    expect(() => p.start(options)).toThrow('no timers');
    expect(a.stoppedCount).toBe(1);
    a.push('x', 2); // the producer is stopped: dropped
    refuse = false;
    a.seed.length = 0;
    t = 100;
    p.start(options);
    t = 200;
    cb?.();
    // only the first baseline exists; nothing held from the failed start is refreshed
    expect((await values(store)).map((v) => [v.value, v.timestamp])).toEqual([[1, 0]]);
  });

  it('the timer never lets an exception escape: a throwing clock on a tick goes to onError', () => {
    const fs = fakeScheduler();
    const errors: unknown[] = [];
    let calls = 0;
    const p = createSystemTracesProvider({
      producers: [new Fixed('a', [])],
      scheduler: fs.scheduler,
      now: () => {
        calls += 1;
        if (calls > 1) throw new Error('clock boom');
        return 0;
      },
      onError: (e) => errors.push(e),
    });
    p.init(buildInit(mkStore()));
    p.start(options);
    expect(() => fs.tick()).not.toThrow();
    expect((errors[0] as Error).message).toBe('clock boom');
  });

  it('a tick that fires after stop() records nothing (not running)', async () => {
    const store = mkStore();
    const fs = fakeScheduler();
    let t = 0;
    const p = createSystemTracesProvider({
      sample: () => [{ name: 'm', value: 1 }],
      scheduler: fs.scheduler,
      now: () => t,
    });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    t = 5;
    fs.tick();
    expect((await values(store)).map((v) => v.timestamp)).toEqual([0]);
  });

  it('one timer per start and one clearInterval per stop across restarts', () => {
    let sets = 0;
    let cleared = 0;
    const handles: unknown[] = [];
    const scheduler: Scheduler = {
      setInterval: () => {
        sets += 1;
        const h = `h${sets}`;
        handles.push(h);
        return h;
      },
      clearInterval: (h) => {
        cleared += 1;
        expect(h).toBe(handles[cleared - 1]); // clears exactly the handle that start registered
      },
    };
    const p = createSystemTracesProvider({ producers: [new Fixed('a', [])], scheduler });
    p.init(buildInit(mkStore()));
    p.start(options);
    expect([sets, cleared]).toEqual([1, 0]);
    p.stop();
    expect([sets, cleared]).toEqual([1, 1]);
    p.start(options);
    expect([sets, cleared]).toEqual([2, 1]);
    p.stop();
    expect([sets, cleared]).toEqual([2, 2]);
  });
});

describe('deriveRefreshMs', () => {
  it.each([
    [600_000, 10_000], // 150 s clamped down to the 10 s ceiling
    [40_000, 10_000], // exactly the ceiling
    [20_000, 5_000], // a quarter of the window
    [8_000, 2_000], // exactly the floor
    [2_000, 2_000], // 0.5 s clamped up to 2 x the 1 s provider interval
    [1, 2_000],
  ])('window %d ms -> %d ms', (windowMs, expected) => {
    expect(deriveRefreshMs(windowMs)).toBe(expected);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('a non-finite or non-positive window (%d) falls back to the 10 s default', (windowMs) => {
    expect(deriveRefreshMs(windowMs)).toBe(10_000);
  });
});
