import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type EventLoopSource,
  type ProcessStats,
  ProcessStatsTracker,
} from './process-stats-tracker';

// Every handle is unique, and clearInterval must be handed exactly a live handle setInterval returned —
// so clearing `undefined`/`null` (a handle dropped too early) or the same handle twice fails the test.
function fakeScheduler() {
  let cb: (() => void) | null = null;
  let cleared = 0;
  let sets = 0;
  const live = new Set<unknown>();
  const scheduler: Scheduler = {
    setInterval: (c) => {
      cb = c;
      sets += 1;
      const handle = { id: sets };
      live.add(handle);
      return handle;
    },
    clearInterval: (h) => {
      expect(live.has(h), `clearInterval(${JSON.stringify(h)}) is not a live handle`).toBe(true);
      live.delete(h);
      cleared += 1;
    },
  };
  return { scheduler, tick: () => cb?.(), cleared: () => cleared, sets: () => sets };
}
const mem = { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 };
function mk(over: Partial<ConstructorParameters<typeof ProcessStatsTracker>[0]> = {}) {
  let cpu = { user: 0, system: 0 };
  let wall = 0;
  const fs = fakeScheduler();
  const tracker = new ProcessStatsTracker({
    memoryUsage: () => mem,
    systemMemory: () => ({ total: 100, free: 40 }),
    cpuUsage: () => cpu,
    cpuCount: () => 2,
    monotonicNowMs: () => wall,
    scheduler: fs.scheduler,
    intervalMs: 1000,
    ...over,
  });
  return {
    tracker,
    fs,
    advance: (c: { user: number; system: number }, w: number) => {
      cpu = c;
      wall = w;
    },
  };
}

describe('ProcessStatsTracker', () => {
  it('attaches NOTHING at construction (no timer, no sources started)', () => {
    const started: string[] = [];
    const eventLoop: EventLoopSource = {
      read: () => undefined,
      start: () => void started.push('start'),
      stop: () => void started.push('stop'),
    };
    const { fs } = mk({ eventLoop });
    expect(fs.sets()).toBe(0);
    expect(started).toEqual([]);
  });

  it('the first subscriber activates it: one timer + event-loop source started; the last one leaves → released', () => {
    const calls: string[] = [];
    const eventLoop: EventLoopSource = {
      read: () => undefined,
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
    };
    const { tracker, fs } = mk({ eventLoop });
    const off1 = tracker.on('stats', () => {});
    const off2 = tracker.on('stats', () => {});
    expect(fs.sets()).toBe(1);
    expect(calls).toEqual(['start']);
    off1();
    expect(fs.cleared()).toBe(0); // still one subscriber
    off2();
    expect(fs.cleared()).toBe(1);
    expect(calls).toEqual(['start', 'stop']);
  });

  it('emits stats on each tick with cpu deltas over the wall window (normalized by cores)', () => {
    const { tracker, fs, advance } = mk();
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    advance({ user: 400_000, system: 200_000 }, 1000); // 600 000 µs busy over 1 000 ms on 2 cores
    fs.tick();
    expect(got).toHaveLength(1);
    expect(got[0]?.memory).toEqual(mem);
    expect(got[0]?.systemMemory).toEqual({ total: 100, free: 40 });
    expect(got[0]?.cpu).toEqual({ userDelta: 400_000, systemDelta: 200_000, processPct: 30 });
  });

  it('current() returns the cached stats and does NOT advance the cpu baseline (shared by many producers)', () => {
    const { tracker, advance } = mk();
    tracker.on('stats', () => {});
    const a = tracker.current();
    advance({ user: 500_000, system: 0 }, 1000);
    const b = tracker.current();
    const c = tracker.current();
    expect(b).toBe(a);
    expect(c).toBe(a); // same object until the next poll
    expect(a.cpu.userDelta).toBe(0); // baseline: no delta yet
  });

  it('a zero wall window yields processPct 0 (no divide by zero)', () => {
    const { tracker, fs } = mk();
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    fs.tick(); // wall unchanged
    expect(got[0]?.cpu.processPct).toBe(0);
  });

  it('includes eventLoop / utilization only when their sources answer (omitted, never zeroed)', () => {
    const { tracker, fs } = mk({
      eventLoop: {
        read: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }),
        start: () => {},
        stop: () => {},
      },
      eventLoopUtilization: () => undefined,
    });
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    fs.tick();
    expect(got[0]?.eventLoop).toEqual({ meanMs: 1, maxMs: 2, p99Ms: 3 });
    expect('utilization' in (got[0] ?? {})).toBe(false);
  });

  it('restart: re-attaches and re-baselines (no stale cache)', () => {
    const { tracker, fs, advance } = mk();
    const off = tracker.on('stats', () => {});
    advance({ user: 1, system: 1 }, 10);
    off();
    tracker.on('stats', () => {});
    expect(fs.sets()).toBe(2);
    expect(tracker.current().cpu.userDelta).toBe(0);
  });

  it('a throwing reader is reported via onError and does not break the timer', () => {
    const errors: unknown[] = [];
    let boom = false;
    const { tracker, fs } = mk({
      memoryUsage: () => {
        if (boom) throw new Error('read boom');
        return mem;
      },
      onError: (e) => errors.push(e),
    });
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    boom = true;
    expect(() => fs.tick()).not.toThrow();
    expect(got).toHaveLength(0);
    expect((errors[0] as Error).message).toBe('read boom');
  });

  it('an explicit undefined dep falls back to the default (not clobbered)', () => {
    const { tracker } = mk({ memoryUsage: undefined, cpuCount: undefined });
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    const s = tracker.current();
    expect(s.memory.rss).not.toBe(1); // the injected-default 'mem' is not used; real reader is
    expect(typeof s.memory.heapUsed).toBe('number');
  });

  it("uses real defaults (os/perf_hooks/process) and an unref'd default scheduler", () => {
    const tracker = new ProcessStatsTracker({ intervalMs: 5 });
    const off = tracker.on('stats', () => {});
    const s = tracker.current();
    expect(s.systemMemory.total).toBeGreaterThan(0);
    expect(s.cpu.processPct).toBeGreaterThanOrEqual(0);
    off(); // clears the real interval
  });

  it('the default scheduler delivers ticks, and is silent after the last unsubscribe', () => {
    vi.useFakeTimers();
    try {
      const tracker = new ProcessStatsTracker({ intervalMs: 5 });
      const got: ProcessStats[] = [];
      const off = tracker.on('stats', (s) => got.push(s));
      vi.advanceTimersByTime(5);
      expect(got).toHaveLength(1);
      vi.advanceTimersByTime(10);
      expect(got).toHaveLength(3);
      off();
      expect(vi.getTimerCount()).toBe(0); // the real interval was cleared
      vi.advanceTimersByTime(100);
      expect(got).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports utilization when the source answers', () => {
    const { tracker, fs } = mk({ eventLoopUtilization: () => 0.5 });
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    fs.tick();
    expect(got[0]?.utilization).toBe(0.5);
  });

  it('onError is optional: a throwing reader without onError is swallowed', () => {
    let boom = false;
    const { tracker, fs } = mk({
      memoryUsage: () => {
        if (boom) throw new Error('x');
        return mem;
      },
    });
    tracker.on('stats', () => {});
    boom = true;
    expect(() => fs.tick()).not.toThrow();
  });

  it('a deactivate with no event-loop source is fine', () => {
    const { tracker, fs } = mk();
    tracker.on('stats', () => {})();
    expect(fs.cleared()).toBe(1);
  });

  it('current() inside a stats listener already returns the emitted stats (cached before emit)', () => {
    const { tracker, fs } = mk({ memoryUsage: () => ({ ...mem }) });
    let seen: ProcessStats | undefined;
    let inside: ProcessStats | undefined;
    tracker.on('stats', (s) => {
      seen = s;
      inside = tracker.current();
    });
    fs.tick();
    expect(inside).toBe(seen);
  });

  it('deactivation drops the cache: current() afterwards is a fresh read', () => {
    const { tracker, fs } = mk({ memoryUsage: () => ({ ...mem }) });
    const off = tracker.on('stats', () => {});
    fs.tick();
    const before = tracker.current();
    off();
    expect(tracker.current()).not.toBe(before);
  });

  it('activation discards a cache taken before any subscriber', () => {
    const { tracker } = mk({ memoryUsage: () => ({ ...mem }) });
    const early = tracker.current();
    tracker.on('stats', () => {});
    expect(tracker.current()).not.toBe(early);
  });

  it('a throwing reader AT ACTIVATION: reported via onError, on() does not throw, nothing left attached, and a later activation retries', () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    let broken = true;
    const eventLoop: EventLoopSource = {
      read: () => undefined,
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
    };
    const { tracker, fs } = mk({
      cpuUsage: () => {
        if (broken) throw new Error('cpu boom');
        return { user: 0, system: 0 };
      },
      eventLoop,
      onError: (e) => errors.push(e),
    });
    let off: (() => void) | undefined;
    expect(() => {
      off = tracker.on('stats', () => {});
    }).not.toThrow();
    expect((errors[0] as Error).message).toBe('cpu boom');
    expect(fs.sets()).toBe(0); // no timer was registered
    off?.();
    broken = false;
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    expect(fs.sets()).toBe(1);
    expect(calls).toEqual(['start']);
    fs.tick();
    expect(got).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('a throwing setInterval at activation stops the already-started event-loop source', () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    let refuse = true;
    const eventLoop: EventLoopSource = {
      read: () => undefined,
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
    };
    let sets = 0;
    let cleared = 0;
    const scheduler: Scheduler = {
      setInterval: () => {
        if (refuse) throw new Error('no timers');
        sets += 1;
        return 'h';
      },
      clearInterval: () => {
        cleared += 1;
      },
    };
    const { tracker } = mk({ eventLoop, scheduler, onError: (e) => errors.push(e) });
    const off = tracker.on('stats', () => {});
    expect((errors[0] as Error).message).toBe('no timers');
    expect(calls).toEqual(['start', 'stop']);
    off();
    refuse = false;
    tracker.on('stats', () => {});
    expect(sets).toBe(1);
    expect(calls).toEqual(['start', 'stop', 'start']); // the unwound source is not stopped twice
    expect(cleared).toBe(0); // the failed activation registered no timer, so there was none to clear
  });

  it('an activation failure before the event-loop source started does not stop it, and onError is optional', () => {
    const calls: string[] = [];
    const eventLoop: EventLoopSource = {
      read: () => undefined,
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
    };
    const { tracker } = mk({
      monotonicNowMs: () => {
        throw new Error('clock boom');
      },
      eventLoop,
    });
    expect(() => tracker.on('stats', () => {})).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('a throwing event-loop stop() during the activation unwind is swallowed (the original error is reported)', () => {
    const errors: unknown[] = [];
    const eventLoop: EventLoopSource = {
      read: () => undefined,
      start: () => {},
      stop: () => {
        throw new Error('stop boom');
      },
    };
    const scheduler: Scheduler = {
      setInterval: () => {
        throw new Error('no timers');
      },
      clearInterval: () => {},
    };
    const { tracker } = mk({ eventLoop, scheduler, onError: (e) => errors.push(e) });
    expect(() => tracker.on('stats', () => {})).not.toThrow();
    expect(errors.map((e) => (e as Error).message)).toEqual(['no timers']);
  });

  it('an event-loop source whose start() throws is reported and is NOT stopped (it never started)', () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const eventLoop: EventLoopSource = {
      read: () => undefined,
      start: () => {
        calls.push('start');
        throw new Error('start boom');
      },
      stop: () => void calls.push('stop'),
    };
    const { tracker, fs } = mk({ eventLoop, onError: (e) => errors.push(e) });
    tracker.on('stats', () => {})();
    expect((errors[0] as Error).message).toBe('start boom');
    expect(calls).toEqual(['start']);
    expect(fs.sets()).toBe(0);
  });
});
