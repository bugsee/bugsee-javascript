import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createEventLoopWatchdog,
  evaluateHang,
  type HangThresholds,
  spawnWatchdogWorker,
  validateThresholds,
  type WatchdogMessage,
  type WatchdogWorker,
} from './event-loop-watchdog';

const T: HangThresholds = { fairMs: 3000, mediumMs: 5000, severeMs: 10000 };

function fakeWorkerSetup() {
  const captured: {
    sab?: SharedArrayBuffer;
    config?: { pollMs: number; fairMs: number };
    listener?: (m: WatchdogMessage) => void;
    terminated: boolean;
    created: number;
  } = { terminated: false, created: 0 };
  const factory = (sab: SharedArrayBuffer, config: { pollMs: number; fairMs: number }) => {
    captured.sab = sab;
    captured.config = config;
    captured.created += 1;
    return {
      on: (_e: 'message', l: (m: WatchdogMessage) => void) => {
        captured.listener = l;
      },
      unref: () => {},
      terminate: () => {
        captured.terminated = true;
      },
    } satisfies WatchdogWorker;
  };
  return { factory, captured, post: (m: WatchdogMessage) => captured.listener?.(m) };
}

function fakeScheduler() {
  let cb: (() => void) | undefined;
  let ms: number | undefined;
  let cleared = false;
  const scheduler: Scheduler = {
    setInterval: (fn, interval) => {
      cb = fn as () => void;
      ms = interval;
      return 'h';
    },
    clearInterval: (h) => {
      if (h === 'h') {
        cleared = true;
      }
    },
  };
  return { scheduler, fire: () => cb?.(), intervalMs: () => ms, cleared: () => cleared };
}

const beat = (sab: SharedArrayBuffer): number => Number(new BigInt64Array(sab)[0]);

describe('evaluateHang', () => {
  it('returns the highest crossed level, or undefined below fair (Android thresholds)', () => {
    expect(evaluateHang(2999, T)).toBeUndefined();
    expect(evaluateHang(3000, T)).toBe('fair');
    expect(evaluateHang(4999, T)).toBe('fair');
    expect(evaluateHang(5000, T)).toBe('medium');
    expect(evaluateHang(9999, T)).toBe('medium');
    expect(evaluateHang(10_000, T)).toBe('severe');
  });
});

describe('validateThresholds', () => {
  it('passes through a strictly-increasing, positive set', () => {
    expect(validateThresholds({ fairMs: 100, mediumMs: 200, severeMs: 300 })).toEqual({
      fairMs: 100,
      mediumMs: 200,
      severeMs: 300,
    });
  });

  it('falls back to Android defaults on a mis-ordered or non-positive set', () => {
    const defaults = { fairMs: 3000, mediumMs: 5000, severeMs: 10_000 };
    expect(validateThresholds({ fairMs: 5000, mediumMs: 3000, severeMs: 10_000 })).toEqual(
      defaults,
    ); // out of order
    expect(validateThresholds({ fairMs: 0, mediumMs: 5000, severeMs: 10_000 })).toEqual(defaults); // non-positive
    expect(validateThresholds({ fairMs: 3000, mediumMs: 5000, severeMs: 5000 })).toEqual(defaults); // medium == severe
  });
});

describe('spawnWatchdogWorker', () => {
  it('constructs a worker and unrefs it (so it never blocks a clean process exit)', () => {
    let unrefed = false;
    class OkWorker {
      on() {}
      unref() {
        unrefed = true;
      }
      terminate() {}
    }
    expect(spawnWatchdogWorker({}, OkWorker as never)).toBeInstanceOf(OkWorker);
    expect(unrefed).toBe(true);
  });

  it('returns undefined when worker construction throws (no worker_threads)', () => {
    class ThrowingWorker {
      constructor() {
        throw new Error('worker_threads unsupported');
      }
    }
    expect(spawnWatchdogWorker({}, ThrowingWorker as never)).toBeUndefined();
  });
});

describe('createEventLoopWatchdog', () => {
  it('start() spawns the worker over a heart-beaten buffer and schedules the heartbeat', () => {
    const fw = fakeWorkerSetup();
    const fs = fakeScheduler();
    let t = 1000;
    const wd = createEventLoopWatchdog({
      thresholds: T,
      onHang: vi.fn(),
      now: () => t,
      scheduler: fs.scheduler,
      workerFactory: fw.factory,
      heartbeatIntervalMs: 1000,
    });
    wd.start();
    expect(fw.captured.sab).toBeDefined();
    expect(beat(fw.captured.sab as SharedArrayBuffer)).toBe(1000); // initial beat
    expect(fw.captured.config).toEqual({ pollMs: 1000, fairMs: 3000 });
    expect(fs.intervalMs()).toBe(1000);
    // each heartbeat tick writes the current wall clock
    t = 2500;
    fs.fire();
    expect(beat(fw.captured.sab as SharedArrayBuffer)).toBe(2500);
  });

  it('validates mis-ordered thresholds to the Android defaults before arming the worker', () => {
    const fw = fakeWorkerSetup();
    const wd = createEventLoopWatchdog({
      thresholds: { fairMs: 9000, mediumMs: 1000, severeMs: 500 }, // mis-ordered → invalid
      onHang: vi.fn(),
      scheduler: fakeScheduler().scheduler,
      workerFactory: fw.factory,
    });
    wd.start();
    expect(fw.captured.config?.fairMs).toBe(3000); // validated → Android-canonical default, not 9000
  });

  it('clamps the heartbeat interval below fairMs so normal staleness cannot false-positive', () => {
    const fw = fakeWorkerSetup();
    const wd = createEventLoopWatchdog({
      thresholds: { fairMs: 100, mediumMs: 200, severeMs: 300 },
      onHang: vi.fn(),
      heartbeatIntervalMs: 1000, // bigger than fairMs → must be clamped to ≤ fairMs/2
      scheduler: fakeScheduler().scheduler,
      workerFactory: fw.factory,
    });
    wd.start();
    expect(fw.captured.config?.pollMs).toBe(50); // min(1000, floor(100 / 2))
  });

  it('escalates onHang once per newly-crossed level (dedup) and re-arms after recovery', () => {
    const onHang = vi.fn();
    const fw = fakeWorkerSetup();
    const wd = createEventLoopWatchdog({
      thresholds: T,
      onHang,
      scheduler: fakeScheduler().scheduler,
      workerFactory: fw.factory,
    });
    wd.start();
    fw.post({ durationMs: 3200 }); // fair → report
    fw.post({ durationMs: 4000 }); // still fair → dedup
    fw.post({ durationMs: 6000 }); // medium → report
    fw.post({ durationMs: 11_000 }); // severe → report
    fw.post({ durationMs: 12_000 }); // still severe → dedup
    expect(onHang.mock.calls).toEqual([
      ['fair', 3200],
      ['medium', 6000],
      ['severe', 11_000],
    ]);
    fw.post({ durationMs: 0, recovered: true }); // episode over → re-arm
    fw.post({ durationMs: 3500 }); // new episode → fair again
    expect(onHang).toHaveBeenCalledTimes(4);
    expect(onHang.mock.calls[3]).toEqual(['fair', 3500]);
  });

  it('ignores a below-fair stall message', () => {
    const onHang = vi.fn();
    const fw = fakeWorkerSetup();
    const wd = createEventLoopWatchdog({
      thresholds: T,
      onHang,
      scheduler: fakeScheduler().scheduler,
      workerFactory: fw.factory,
    });
    wd.start();
    fw.post({ durationMs: 1000 }); // below fair → nothing
    expect(onHang).not.toHaveBeenCalled();
  });

  it('start() is idempotent (one worker)', () => {
    const fw = fakeWorkerSetup();
    const wd = createEventLoopWatchdog({
      thresholds: T,
      onHang: vi.fn(),
      scheduler: fakeScheduler().scheduler,
      workerFactory: fw.factory,
    });
    wd.start();
    wd.start();
    expect(fw.captured.created).toBe(1);
  });

  it('stop() clears the heartbeat timer and terminates the worker', () => {
    const fw = fakeWorkerSetup();
    const fs = fakeScheduler();
    const wd = createEventLoopWatchdog({
      thresholds: T,
      onHang: vi.fn(),
      scheduler: fs.scheduler,
      workerFactory: fw.factory,
    });
    wd.start();
    wd.stop();
    expect(fs.cleared()).toBe(true);
    expect(fw.captured.terminated).toBe(true);
  });

  it('is a no-op when worker_threads is unavailable (factory returns undefined)', () => {
    const fs = fakeScheduler();
    const wd = createEventLoopWatchdog({
      thresholds: T,
      onHang: vi.fn(),
      scheduler: fs.scheduler,
      workerFactory: () => undefined,
    });
    expect(() => wd.start()).not.toThrow();
    expect(fs.intervalMs()).toBeUndefined(); // no heartbeat scheduled
    expect(() => wd.stop()).not.toThrow(); // stop safe with no worker/timer
  });

  it('detects a REAL event-loop block via a real worker thread (end-to-end)', async () => {
    const onHang = vi.fn();
    const wd = createEventLoopWatchdog({
      thresholds: { fairMs: 60, mediumMs: 120, severeMs: 1_000 },
      onHang,
      heartbeatIntervalMs: 20, // < fairMs
    });
    wd.start();
    // The worker is spawned ASYNCHRONOUSLY (worker_threads startup) and can only observe a block
    // that happens AFTER it is polling. A single fixed "spin-up" wait is racy on a loaded CI runner
    // where startup routinely exceeds it (the block then lands before monitoring begins and is never
    // seen). So block the loop in ~120ms bursts and retry until one burst is caught — converging as
    // soon as the worker is alive, whenever that is, while staying fast on a healthy runner.
    await vi.waitFor(
      () => {
        if (onHang.mock.calls.length === 0) {
          const end = Date.now() + 120; // > fairMs (60): a live worker MUST see this stall
          while (Date.now() < end) {
            // busy spin — freeze the loop so the heartbeat timer can't refresh the shared buffer
          }
        }
        expect(onHang).toHaveBeenCalled();
      },
      { timeout: 8000, interval: 50 },
    );
    expect(['fair', 'medium', 'severe']).toContain(onHang.mock.calls[0]?.[0]);
    wd.stop();
  }, 12_000);
});
