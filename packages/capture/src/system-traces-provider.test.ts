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
import { describe, expect, it, vi } from 'vitest';
import { createSystemTracesProvider, type TraceSample } from './system-traces-provider';

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
    expect(p.controllingOption).toBe('captureSystemTraces');
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
