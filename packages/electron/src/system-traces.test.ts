import type { TraceSink } from '@bugsee/capture';
import {
  ElectronApplicationTracker,
  ElectronDisplayTracker,
  ElectronProcessTracker,
} from '@bugsee/trackers/electron';
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

// ---- displays ----------------------------------------------------------------------------------------

describe('displays producer', () => {
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
      getPrimaryDisplay: vi.fn(() => (list() as unknown[])[0]),
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
      'displays',
    ]);
    expect(createElectronSystemTraceProducers({})).toEqual([]);
  });

  it('touches nothing until started; then emits the baseline list as a HELD step trace in the mobile layout (a bare array, snake_case)', () => {
    const d = displays(() => [
      display(),
      display({ id: 2779098405, size: { width: 10, height: 20 }, rotation: 7, internal: false }),
    ]);
    expect(d.screen.on).not.toHaveBeenCalled();
    d.producer.start(d.sink);
    expect(d.emitted).toStrictEqual([
      {
        name: 'displays',
        hold: true,
        value: [
          {
            id: 0,
            native_id: 1,
            state: 'on',
            type: 'internal',
            width: 2880,
            height: 1800,
            natural_width: 1800,
            natural_height: 2880,
            scale: 2,
            max_fps: 120,
            rotation: 1,
          },
          {
            id: 1,
            native_id: 2779098405,
            type: 'external',
            width: 20,
            height: 40,
            scale: 2,
            max_fps: 120,
          },
        ],
      },
    ]);
    expect(JSON.stringify(d.emitted)).not.toContain('secret');
    d.producer.stop();
  });

  it('rounds the real-Electron float refresh rate to an integer and the scale factor to 2 decimals', () => {
    // Real Electron 44.9.3 (macOS, LG 4K): displayFrequency is 59.996700286865234.
    const d = displays(() => [
      display({ displayFrequency: 59.996700286865234, scaleFactor: 1.2000000476837158 }),
      display({ id: 2, displayFrequency: 59.4, scaleFactor: 1.5 }),
      display({ id: 3, displayFrequency: 60, scaleFactor: 2 }),
    ]);
    d.producer.start(d.sink);
    const list = (d.emitted[0] as { value: Array<Record<string, unknown>> }).value;
    expect(list.map((x) => [x.max_fps, x.scale])).toEqual([
      [60, 1.2],
      [59, 1.5],
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

describe('displays producer follows the key window (C26)', () => {
  type L = (...a: unknown[]) => void;
  class Emitter {
    table = new Map<string, L[]>();
    on = (e: string, l: L) => void this.table.set(e, [...(this.table.get(e) ?? []), l]);
    removeListener = (e: string, l: L) =>
      void this.table.set(
        e,
        (this.table.get(e) ?? []).filter((x) => x !== l),
      );
    emit(e: string) {
      for (const l of [...(this.table.get(e) ?? [])]) l({});
    }
    total() {
      return [...this.table.values()].reduce((n, l) => n + l.length, 0);
    }
  }
  class Win extends Emitter {
    gone = false;
    constructor(
      readonly id: number,
      public x: number,
    ) {
      super();
    }
    isDestroyed = () => this.gone;
    getBounds = () => ({ x: this.x, y: 0, width: 100, height: 100 });
  }
  const mkDisplay = (id: number) => ({
    id,
    size: { width: 1000, height: 500 },
    scaleFactor: 1,
  });

  function world(wins: Win[]) {
    let focused: Win | null = null;
    const app = new Emitter();
    const screen = Object.assign(new Emitter(), {
      getAllDisplays: () => [mkDisplay(1), mkDisplay(2)],
      getPrimaryDisplay: () => mkDisplay(1),
      getDisplayMatching: (r: { x: number }) => mkDisplay(r.x < 1000 ? 1 : 2),
    });
    const application = new ElectronApplicationTracker({
      app,
      BrowserWindow: { getAllWindows: () => wins, getFocusedWindow: () => focused },
    });
    const display = new ElectronDisplayTracker({
      screen,
      keyWindowBounds: () => application.keyWindowBounds(),
    });
    const clock = { now: 0, next: 1, timers: new Map<number, { at: number; cb: () => void }>() };
    const scheduler = {
      setInterval: (cb: () => void, ms: number) => {
        const id = clock.next++;
        clock.timers.set(id, { at: clock.now + ms, cb });
        return id;
      },
      clearInterval: (id: unknown) => void clock.timers.delete(id as number),
    };
    const advance = (ms: number) => {
      clock.now += ms;
      for (const [id, t] of [...clock.timers]) {
        if (t.at <= clock.now) {
          clock.timers.delete(id);
          t.cb();
        }
      }
    };
    const [producer] = createElectronSystemTraceProducers({ display, application, scheduler });
    const emitted: Array<{ name: string; value: unknown }> = [];
    const sink: TraceSink = { emit: (name, value) => emitted.push({ name, value }) };
    const nativeIds = () =>
      (emitted.at(-1)?.value as Array<{ native_id: number }>).map((d) => d.native_id);
    return {
      advance,
      pendingTimers: () => clock.timers.size,
      app,
      screen,
      application,
      producer: producer as NonNullable<typeof producer>,
      emitted,
      sink,
      nativeIds,
      focus: (w: Win | null) => {
        focused = w;
        w?.emit('focus');
      },
    };
  }

  it('id 0 is the key window display; the list is re-emitted when focus moves it to another display, and not when it does not', () => {
    const a = new Win(1, 10); // on display 1
    const b = new Win(2, 2000); // on display 2
    const w = world([a, b]);
    w.producer.start(w.sink);
    expect(w.nativeIds()).toEqual([1, 2]); // no focus yet: the first created (a) is the key window
    w.focus(b);
    expect(w.nativeIds()).toEqual([2, 1]);
    expect(w.emitted).toHaveLength(2);
    expect(w.emitted.at(-1)?.value).toMatchObject([{ id: 0, state: 'on' }, { id: 1 }]);
    w.focus(a);
    expect(w.nativeIds()).toEqual([1, 2]);
    w.focus(null); // blur: the most recently focused (a) stays the key window
    a.emit('blur');
    expect(w.emitted).toHaveLength(3);
    w.producer.stop();
  });

  it('re-emits when the key window is moved to another display (windowMoved)', () => {
    const a = new Win(1, 10);
    const w = world([a]);
    w.producer.start(w.sink);
    expect(w.nativeIds()).toEqual([1, 2]);
    a.x = 1500;
    a.emit('moved');
    expect(w.nativeIds()).toEqual([1, 2]); // debounced: not yet
    w.advance(199);
    expect(w.nativeIds()).toEqual([1, 2]);
    w.advance(1);
    expect(w.nativeIds()).toEqual([2, 1]);
    w.producer.stop();
  });

  it('a drag (many `moved` events) is debounced to ONE re-read after the window is still for 200 ms; stop cancels a pending one', () => {
    const a = new Win(1, 10);
    const w = world([a]);
    w.producer.start(w.sink);
    const reads = vi.spyOn(w.screen, 'getAllDisplays');
    for (let i = 0; i < 10; i++) {
      a.x = 1500;
      a.emit('moved');
      w.advance(100); // each event restarts the timer
    }
    expect(reads).not.toHaveBeenCalled();
    w.advance(100);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(w.nativeIds()).toEqual([2, 1]);
    a.emit('moved');
    expect(w.pendingTimers()).toBe(1);
    w.producer.stop();
    expect(w.pendingTimers()).toBe(0);
    w.advance(1000);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('the default scheduler is the global timers', () => {
    vi.useFakeTimers();
    try {
      const a = new Win(1, 10);
      const app = new Emitter();
      const screen = Object.assign(new Emitter(), {
        getAllDisplays: () => [mkDisplay(1), mkDisplay(2)],
        getPrimaryDisplay: () => mkDisplay(1),
        getDisplayMatching: (r: { x: number }) => mkDisplay(r.x < 1000 ? 1 : 2),
      });
      const application = new ElectronApplicationTracker({
        app,
        BrowserWindow: { getAllWindows: () => [a] },
      });
      const display = new ElectronDisplayTracker({
        screen,
        keyWindowBounds: () => application.keyWindowBounds(),
      });
      const [producer] = createElectronSystemTraceProducers({ display, application });
      const emitted: Array<{ value: unknown }> = [];
      producer?.start({ emit: (_n, value) => emitted.push({ value }) });
      a.x = 1500;
      a.emit('moved');
      vi.advanceTimersByTime(200);
      expect(emitted).toHaveLength(2);
      a.emit('moved');
      producer?.stop();
      vi.advanceTimersByTime(1000);
      expect(emitted).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() releases the window listeners too (focus and moved) and nothing re-emits afterwards', () => {
    const a = new Win(1, 10);
    const w = world([a]);
    w.producer.start(w.sink);
    expect(a.total()).toBeGreaterThan(0);
    w.producer.stop();
    expect(a.total()).toBe(0);
    expect(w.app.total()).toBe(0);
    expect(w.screen.total()).toBe(0);
    a.x = 1500;
    a.emit('moved');
    expect(w.emitted).toHaveLength(1);
  });

  it('without an application tracker the list follows the primary display only; with no readable list nothing is emitted', () => {
    const screen = Object.assign(new Emitter(), {
      getAllDisplays: () => [mkDisplay(1), mkDisplay(2)],
      getPrimaryDisplay: () => mkDisplay(2),
    });
    const [producer] = createElectronSystemTraceProducers({
      display: new ElectronDisplayTracker({ screen }),
    });
    const emitted: Array<{ name: string; value: unknown }> = [];
    producer?.start({ emit: (name, value) => emitted.push({ name, value }) });
    expect((emitted[0]?.value as Array<{ native_id: number }>).map((d) => d.native_id)).toEqual([
      2, 1,
    ]);
    producer?.stop();

    const lone = new Win(1, 10);
    const w = world([lone]);
    (w.screen as { getAllDisplays: () => unknown }).getAllDisplays = () => {
      throw new Error('hostile');
    };
    w.producer.start(w.sink);
    w.focus(lone);
    expect(w.emitted).toEqual([]);
    w.producer.stop();
  });
});
