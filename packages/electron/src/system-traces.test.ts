import type { TraceSink } from '@bugsee/capture';
import { ElectronProcessTracker } from '@bugsee/trackers/electron';
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
  const producers = createElectronSystemTraceProducers(tracker);
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
