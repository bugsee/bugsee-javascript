import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import type { GcSource } from './gc-observer';
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

  it('current() after a failed activation RETRIES it (timer + event-loop source) instead of accepting a baseline from an unarmed tracker', () => {
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
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s)); // activation fails, subscriber stays registered
    expect(fs.sets()).toBe(0);
    broken = false;
    expect(tracker.current().memory).toEqual(mem); // the retry succeeds before the baseline is read
    expect(fs.sets()).toBe(1);
    expect(calls).toEqual(['start']);
    fs.tick();
    expect(got).toHaveLength(1); // the already-registered subscriber now receives ticks
    expect(tracker.current()).toBe(got[0]);
    expect(errors).toHaveLength(1);
    // the retry happens once: a further current() does not re-activate
    tracker.current();
    expect(fs.sets()).toBe(1);
    expect(calls).toEqual(['start']);
  });

  it('current() after a failed activation whose retry ALSO fails propagates the failure (and a later current() retries again)', () => {
    const errors: unknown[] = [];
    let broken = true;
    const { tracker, fs } = mk({
      cpuUsage: () => {
        if (broken) throw new Error('cpu boom');
        return { user: 0, system: 0 };
      },
      onError: (e) => errors.push(e),
    });
    tracker.on('stats', () => {});
    expect(() => tracker.current()).toThrow('cpu boom');
    expect(fs.sets()).toBe(0);
    broken = false;
    expect(() => tracker.current()).not.toThrow();
    expect(fs.sets()).toBe(1);
  });

  it('a pending activation failure is cleared on deactivation: current() with no subscribers does not activate', () => {
    let broken = true;
    const { tracker, fs } = mk({
      cpuUsage: () => {
        if (broken) throw new Error('cpu boom');
        return { user: 0, system: 0 };
      },
      onError: () => {},
    });
    const off = tracker.on('stats', () => {});
    off();
    broken = false;
    tracker.current();
    expect(fs.sets()).toBe(0); // no subscriber → no retry, no timer
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

  it('a throwing event-loop stop() during the activation unwind is reported and the original error is too', () => {
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
    expect(errors.map((e) => (e as Error).message).sort()).toEqual(['no timers', 'stop boom']);
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

  describe('gc source', () => {
    const interval = { count: 2, pauseMs: 9, maxPauseMs: 6 };
    const mkGc = (over: Partial<GcSource> = {}) => {
      const calls: string[] = [];
      const gc: GcSource = {
        start: () => void calls.push('start'),
        stop: () => void calls.push('stop'),
        read: () => interval,
        ...over,
      };
      return { gc, calls };
    };

    it('starts on the first subscriber, stops on the last, and starts nothing before', () => {
      const { gc, calls } = mkGc();
      const { tracker } = mk({ gc });
      expect(calls).toEqual([]);
      const off = tracker.on('stats', () => {});
      expect(calls).toEqual(['start']);
      off();
      expect(calls).toEqual(['start', 'stop']);
    });

    it('carries the interval on the baseline and on every poll; absent when the source answers undefined or is not wired', () => {
      const { gc } = mkGc();
      const { tracker, fs } = mk({ gc });
      const got: ProcessStats[] = [];
      tracker.on('stats', (st) => got.push(st));
      expect(tracker.current().gc).toEqual(interval);
      fs.tick();
      expect(got[0]?.gc).toEqual(interval);

      const none = mk({ gc: mkGc({ read: () => undefined }).gc });
      none.tracker.on('stats', () => {});
      expect('gc' in none.tracker.current()).toBe(false);
      const unwired = mk();
      unwired.tracker.on('stats', () => {});
      expect('gc' in unwired.tracker.current()).toBe(false);
    });

    it('a throwing read is reported and only gc is dropped', () => {
      const errors: unknown[] = [];
      const { gc } = mkGc({
        read: () => {
          throw new Error('gc read');
        },
      });
      const { tracker } = mk({ gc, onError: (e) => errors.push(e) });
      tracker.on('stats', () => {});
      const cur = tracker.current();
      expect('gc' in cur).toBe(false);
      expect(cur.memory).toEqual(mem);
      expect((errors[0] as Error).message).toBe('gc read');
    });

    it('a failed activation after gc started stops it; a gc whose start() throws is reported and not stopped', () => {
      const a = mkGc();
      const scheduler: Scheduler = {
        setInterval: () => {
          throw new Error('no timers');
        },
        clearInterval: () => {},
      };
      mk({ gc: a.gc, scheduler }).tracker.on('stats', () => {})();
      expect(a.calls).toEqual(['start', 'stop']); // stopped once by the unwind, never again on release

      const errors: unknown[] = [];
      const b = mkGc({
        start: () => {
          throw new Error('start boom');
        },
      });
      mk({ gc: b.gc, onError: (e) => errors.push(e) }).tracker.on('stats', () => {})();
      expect((errors[0] as Error).message).toBe('start boom');
      expect(b.calls).toEqual([]);
    });

    it('a throwing gc stop() does not strand the event-loop source stop (and vice versa)', () => {
      const calls: string[] = [];
      const eventLoop: EventLoopSource = {
        read: () => undefined,
        start: () => {},
        stop: () => {
          calls.push('el-stop');
          throw new Error('el');
        },
      };
      const { gc } = mkGc({
        stop: () => {
          calls.push('gc-stop');
          throw new Error('gc');
        },
      });
      const errors: unknown[] = [];
      const { tracker } = mk({ gc, eventLoop, onError: (e) => errors.push(e) });
      const off = tracker.on('stats', () => {});
      expect(() => off()).not.toThrow();
      expect(calls.sort()).toEqual(['el-stop', 'gc-stop']);
      expect(errors.map((e) => (e as Error).message).sort()).toEqual(['el', 'gc']);
    });

    it('a poll that fails before gc is read does not drain the interval', () => {
      let reads = 0;
      let boom = true;
      const { gc } = mkGc({
        read: () => {
          reads += 1;
          return interval;
        },
      });
      const { tracker, fs } = mk({
        gc,
        eventLoopUtilization: () => {
          if (boom) throw new Error('elu');
          return 0.1;
        },
        onError: () => {},
      });
      const got: ProcessStats[] = [];
      tracker.on('stats', (st) => got.push(st));
      // the activation baseline is read lazily, so the first poll is the failing one
      fs.tick();
      expect(got).toHaveLength(0);
      expect(reads).toBe(0);
      boom = false;
      fs.tick();
      expect(got[0]?.gc).toEqual(interval);
    });

    it('restarts the source on re-activation', () => {
      const { gc, calls } = mkGc();
      const { tracker } = mk({ gc });
      tracker.on('stats', () => {})();
      tracker.on('stats', () => {});
      expect(calls).toEqual(['start', 'stop', 'start']);
    });
  });

  describe('runtime-depth readers (v8 heap, memory limit, available memory, uptime)', () => {
    const heap = { limit: 100, used: 30, available: 70, malloced: 5, peakMalloced: 6 };

    it('carries uptime in whole seconds, and no optional field when no reader is given', () => {
      const { tracker } = mk({ uptime: () => 12.9 });
      const stats = tracker.current();
      expect(stats.uptimeS).toBe(12);
      expect(stats).not.toHaveProperty('v8Heap');
      expect(stats).not.toHaveProperty('memoryLimit');
      expect(stats).not.toHaveProperty('availableMemory');
    });

    it('defaults uptime to process.uptime()', () => {
      const spy = vi.spyOn(process, 'uptime').mockReturnValue(99.5);
      try {
        expect(mk().tracker.current().uptimeS).toBe(99);
      } finally {
        spy.mockRestore();
      }
    });

    it('exposes each injected reader, on the baseline and on every poll', () => {
      let used = 30;
      const { tracker, fs } = mk({
        v8Heap: () => ({ ...heap, used }),
        memoryLimit: () => 777,
        availableMemory: () => 555,
        uptime: () => 3,
      });
      const seen: ProcessStats[] = [];
      tracker.on('stats', (s) => seen.push(s));
      expect(tracker.current()).toMatchObject({
        v8Heap: heap,
        memoryLimit: 777,
        availableMemory: 555,
        uptimeS: 3,
      });
      used = 31;
      fs.tick();
      expect(seen[0]?.v8Heap?.used).toBe(31);
      expect(seen[0]?.memoryLimit).toBe(777);
      expect(seen[0]?.availableMemory).toBe(555);
    });

    it('omits a field whose reader answers undefined', () => {
      const { tracker } = mk({
        v8Heap: () => undefined,
        memoryLimit: () => undefined,
        availableMemory: () => undefined,
      });
      const stats = tracker.current();
      expect(stats).not.toHaveProperty('v8Heap');
      expect(stats).not.toHaveProperty('memoryLimit');
      expect(stats).not.toHaveProperty('availableMemory');
    });

    it('a throwing reader is reported and ONLY its field is dropped (memory/cpu/other readers survive)', () => {
      const onError = vi.fn();
      const { tracker, fs } = mk({
        v8Heap: () => {
          throw new Error('v8');
        },
        memoryLimit: () => 777,
        availableMemory: () => {
          throw new Error('avail');
        },
        onError,
      });
      const seen: ProcessStats[] = [];
      tracker.on('stats', (s) => seen.push(s));
      const base = tracker.current();
      expect(base.memory).toEqual(mem);
      expect(base.memoryLimit).toBe(777);
      expect(base).not.toHaveProperty('v8Heap');
      expect(base).not.toHaveProperty('availableMemory');
      expect(onError).toHaveBeenCalledTimes(2);
      fs.tick();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.memoryLimit).toBe(777);
      expect(onError).toHaveBeenCalledTimes(4);
    });

    it('a throwing uptime reader does not advance the CPU baseline: the next delta covers the whole gap', () => {
      let fail = true;
      const { tracker, fs, advance } = mk({
        uptime: () => {
          if (fail) throw new Error('uptime');
          return 1;
        },
        onError: () => {},
      });
      const seen: ProcessStats[] = [];
      tracker.on('stats', (s) => seen.push(s));
      advance({ user: 100, system: 40 }, 1000);
      fs.tick(); // fails: nothing emitted, baseline untouched
      fail = false;
      advance({ user: 300, system: 100 }, 2000);
      fs.tick();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.cpu).toMatchObject({ userDelta: 300, systemDelta: 100 });
    });

    it('a throwing uptime reader is reported and the stats are not emitted for that poll', () => {
      const onError = vi.fn();
      let fail = false;
      const { tracker, fs } = mk({
        uptime: () => {
          if (fail) throw new Error('uptime');
          return 1;
        },
        onError,
      });
      const seen: ProcessStats[] = [];
      tracker.on('stats', (s) => seen.push(s));
      fail = true;
      fs.tick();
      expect(seen).toEqual([]);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});
