import type { TraceSink } from '@bugsee/capture';
import { ElectronDisplayTracker, ElectronProcessTracker } from '@bugsee/trackers/electron';
import { describe, expect, it, vi } from 'vitest';
import { createElectronSystemTraceProducers } from './system-traces';

function fakeScheduler() {
  let cb: (() => void) | undefined;
  return {
    setInterval: (callback: () => void) => {
      cb = callback;
      return 1;
    },
    clearInterval: () => {
      cb = undefined;
    },
    tick: () => cb?.(),
    get armed() {
      return cb !== undefined;
    },
  };
}

const metric = (over: Record<string, unknown> = {}) => ({
  pid: 10,
  type: 'Browser',
  cpu: { percentCPUUsage: 3.5 },
  memory: { workingSetSize: 3 * 1024, peakWorkingSetSize: 5 * 1024 },
  ...over,
});

function setup(getAppMetrics: () => unknown) {
  const scheduler = fakeScheduler();
  const onError = vi.fn();
  const tracker = new ElectronProcessTracker({ app: { getAppMetrics }, scheduler }, onError);
  const emitted: Array<{ name: string; value: unknown; hold: boolean | undefined }> = [];
  const sink: TraceSink = {
    emit: (name, value, _display, options) => emitted.push({ name, value, hold: options?.hold }),
  };
  const producers = createElectronSystemTraceProducers({ process: tracker });
  return { tracker, scheduler, onError, emitted, sink, producers };
}

describe('createElectronSystemTraceProducers', () => {
  it('builds exactly the app_metrics producer', () => {
    const { producers, tracker } = setup(() => []);
    expect(producers.map((p) => p.name)).toEqual(['electron-app-metrics']);
    tracker.reset();
  });

  it('does not touch Electron until started, then arms the tracker stage (priming read, no start sample)', () => {
    const getAppMetrics = vi.fn(() => [metric()]);
    const { producers, scheduler, emitted, sink, tracker } = setup(getAppMetrics);
    expect(getAppMetrics).not.toHaveBeenCalled();
    producers[0]?.start(sink);
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
    expect(scheduler.armed).toBe(true);
    expect(emitted).toEqual([]);
    producers[0]?.stop();
    tracker.reset();
  });

  it('emits ONE app_metrics value per tick: integer MB, snake_case, polled (never held), absent fields omitted', () => {
    const { producers, scheduler, emitted, sink, tracker } = setup(() => [
      metric(),
      metric({
        pid: 11,
        type: 'GPU',
        cpu: undefined,
        memory: { workingSetSize: 2048 * 1024 + 512, privateBytes: 1024 },
      }),
    ]);
    producers[0]?.start(sink);
    scheduler.tick();
    expect(emitted).toStrictEqual([
      {
        name: 'app_metrics',
        hold: false,
        value: {
          processes: [
            {
              type: 'Browser',
              pid: 10,
              cpu_percent: 3.5,
              working_set_mb: 3,
              peak_working_set_mb: 5,
            },
            { type: 'GPU', pid: 11, working_set_mb: 2048, private_mb: 1 },
          ],
        },
      },
    ]);
    producers[0]?.stop();
    tracker.reset();
  });

  it('rounds cpu_percent to at most 2 decimals (and keeps a true 0)', () => {
    const { producers, scheduler, emitted, sink, tracker } = setup(() => [
      metric({ cpu: { percentCPUUsage: 12.3456 } }),
      metric({ pid: 2, cpu: { percentCPUUsage: 0 } }),
      metric({ pid: 3, cpu: { percentCPUUsage: 0.004 } }),
    ]);
    producers[0]?.start(sink);
    scheduler.tick();
    const procs = (emitted[0]?.value as { processes: Array<{ cpu_percent: number }> }).processes;
    expect(procs.map((p) => p.cpu_percent)).toEqual([12.35, 0, 0]);
    producers[0]?.stop();
    tracker.reset();
  });

  it('stop() releases the tracker stage (timer cleared) and a late emit writes nothing', () => {
    const { producers, scheduler, emitted, sink, tracker } = setup(() => [metric()]);
    producers[0]?.start(sink);
    producers[0]?.stop();
    expect(scheduler.armed).toBe(false);
    scheduler.tick();
    expect(emitted).toEqual([]);
    tracker.reset();
  });

  it('a getAppMetrics that throws yields no trace and reports through the tracker (other producers unaffected)', () => {
    const boom = new Error('boom');
    let throwing = false;
    const { producers, scheduler, emitted, sink, onError, tracker } = setup(() => {
      if (throwing) throw boom;
      return [metric()];
    });
    producers[0]?.start(sink);
    throwing = true;
    scheduler.tick();
    expect(emitted).toEqual([]);
    expect(onError).toHaveBeenCalledWith(boom);
    throwing = false;
    scheduler.tick();
    expect(emitted).toHaveLength(1);
    producers[0]?.stop();
    tracker.reset();
  });

  it('can be restarted after stop (the TraceProducer contract)', () => {
    const { producers, scheduler, emitted, sink, tracker } = setup(() => [metric()]);
    producers[0]?.start(sink);
    producers[0]?.stop();
    producers[0]?.start(sink);
    scheduler.tick();
    expect(emitted).toHaveLength(1);
    producers[0]?.stop();
    tracker.reset();
  });
});

// ---- electron_displays ----------------------------------------------------------------------------------------

describe('electron_displays producer', () => {
  type L = (...a: unknown[]) => void;
  const display = (over: Record<string, unknown> = {}) => ({
    id: 1,
    size: { width: 1440, height: 900 },
    scaleFactor: 2,
    rotation: 90,
    internal: true,
    displayFrequency: 120,
    label: 'secret',
    ...over,
  });
  function displays(list: () => unknown) {
    const table = new Map<string, L[]>();
    const screen = {
      getAllDisplays: vi.fn(list),
      on: vi.fn((e: string, l: L) => {
        table.set(e, [...(table.get(e) ?? []), l]);
      }),
      removeListener: vi.fn((e: string, l: L) => {
        table.set(
          e,
          (table.get(e) ?? []).filter((x) => x !== l),
        );
      }),
    };
    const onError = vi.fn();
    const tracker = new ElectronDisplayTracker({ screen }, onError);
    const emitted: Array<{ name: string; value: unknown; hold: boolean | undefined }> = [];
    const sink: TraceSink = {
      emit: (name, value, _d, options) => emitted.push({ name, value, hold: options?.hold }),
    };
    const [producer] = createElectronSystemTraceProducers({ display: tracker });
    return {
      screen,
      tracker,
      emitted,
      sink,
      producer: producer as NonNullable<typeof producer>,
      fire: (e: string) => {
        for (const l of [...(table.get(e) ?? [])]) l({}, display(), []);
      },
      listeners: () => [...table.values()].reduce((n, l) => n + l.length, 0),
      onError,
    };
  }

  it('builds exactly the displays producer for a display tracker, nothing for none', () => {
    const d = displays(() => [display()]);
    expect(createElectronSystemTraceProducers({ display: d.tracker }).map((p) => p.name)).toEqual([
      'electron-displays',
    ]);
    expect(createElectronSystemTraceProducers({})).toEqual([]);
  });

  it('touches nothing until started; then emits the baseline list as a HELD step trace with the documented shape', () => {
    const d = displays(() => [
      display(),
      display({ id: 2, size: { width: 10, height: 20 }, rotation: 7 }),
    ]);
    expect(d.screen.on).not.toHaveBeenCalled();
    d.producer.start(d.sink);
    expect(d.emitted).toStrictEqual([
      {
        name: 'electron_displays',
        hold: true,
        value: {
          displays: [
            {
              id: 1,
              width: 1440,
              height: 900,
              scale_factor: 2,
              rotation: 90,
              internal: true,
              refresh_rate_hz: 120,
            },
            { id: 2, width: 10, height: 20, scale_factor: 2, internal: true, refresh_rate_hz: 120 },
          ],
        },
      },
    ]);
    expect(JSON.stringify(d.emitted)).not.toContain('secret');
    d.producer.stop();
  });

  it('rounds the real-Electron float refresh rate and scale factor to at most 2 decimals', () => {
    // Real Electron 44.9.3 (macOS, LG 4K): displayFrequency is 59.996700286865234.
    const d = displays(() => [
      display({ displayFrequency: 59.996700286865234, scaleFactor: 1.2000000476837158 }),
      display({ id: 2, displayFrequency: 59.994, scaleFactor: 1.5 }),
      display({ id: 3, displayFrequency: 60, scaleFactor: 2 }),
    ]);
    d.producer.start(d.sink);
    const list = (d.emitted[0] as { value: { displays: Array<Record<string, unknown>> } }).value
      .displays;
    expect(list.map((x) => [x.refresh_rate_hz, x.scale_factor])).toEqual([
      [60, 1.2],
      [59.99, 1.5],
      [60, 2],
    ]);
    d.producer.stop();
  });

  it('re-emits only when the list changed (display added/removed/metrics-changed re-read it)', () => {
    let list: unknown[] = [display()];
    const d = displays(() => list);
    d.producer.start(d.sink);
    d.fire('display-metrics-changed'); // same list: not re-emitted
    expect(d.emitted).toHaveLength(1);
    list = [display(), display({ id: 2 })];
    d.fire('display-added');
    expect(d.emitted).toHaveLength(2);
    list = [display()];
    d.fire('display-removed');
    expect(d.emitted).toHaveLength(3);
    d.producer.stop();
  });

  it('emits NOTHING (never an empty list) when Electron cannot give a list; a later change still lands', () => {
    let list: unknown = [];
    const d = displays(() => list);
    d.producer.start(d.sink);
    expect(d.emitted).toEqual([]);
    list = [display()];
    d.fire('display-added');
    expect(d.emitted).toHaveLength(1);
    d.producer.stop();
  });

  it('a throwing getAllDisplays at start is reported and the producer still starts', () => {
    const d = displays(() => {
      throw new Error('displays');
    });
    expect(() => d.producer.start(d.sink)).not.toThrow();
    expect(d.emitted).toEqual([]);
    expect(d.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'displays' }));
    d.producer.stop();
  });

  it('stop() releases the screen listeners and a restart works', () => {
    const d = displays(() => [display()]);
    d.producer.start(d.sink);
    expect(d.listeners()).toBe(3);
    d.producer.stop();
    expect(d.listeners()).toBe(0);
    d.fire('display-added');
    expect(d.emitted).toHaveLength(1);
    d.producer.start(d.sink);
    expect(d.emitted).toHaveLength(2);
    d.producer.stop();
  });
});
