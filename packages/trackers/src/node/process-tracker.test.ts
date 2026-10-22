import nodeProcessForTest from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import {
  type EventLoopSource,
  type GcSource,
  type ProcessEnv,
  type ProcessEvents,
  ProcessTracker,
  processTrackerFor,
  resetProcessTracker,
} from './index';

// Every handle is unique, and clearInterval must be handed exactly a live handle setInterval returned,
// so clearing `undefined`/`null` (a handle dropped too early) or the same handle twice fails the test.
function fakeScheduler() {
  const callbacks: (() => void)[] = [];
  const live = new Set<unknown>();
  let cleared = 0;
  const scheduler = {
    setInterval: (cb: () => void) => {
      callbacks.push(cb);
      const handle = { id: callbacks.length };
      live.add(handle);
      return handle;
    },
    clearInterval: (h: unknown) => {
      expect(live.has(h), 'clearInterval was not given a live handle').toBe(true);
      live.delete(h);
      cleared += 1;
    },
  };
  return {
    scheduler,
    tick: () => callbacks.at(-1)?.(),
    /** A callback from an EARLIER arming (a timer whose clear failed or that the host fired late). */
    callbackAt: (i: number) => callbacks[i],
    sets: () => callbacks.length,
    cleared: () => cleared,
    live: () => live.size,
  };
}

const mem = { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 };

function source<T = undefined>(label: string, log: string[], read?: () => T) {
  return {
    start: () => void log.push(`${label}.start`),
    stop: () => void log.push(`${label}.stop`),
    read: (read ?? (() => undefined)) as () => T | undefined,
  };
}

function mk(over: ProcessEnv = {}, onError?: (e: unknown) => void) {
  let cpu = { user: 0, system: 0 };
  let wall = 0;
  const fs = fakeScheduler();
  const tracker = new ProcessTracker(
    {
      memoryUsage: () => mem,
      systemMemory: () => ({ total: 100, free: 40 }),
      cpuUsage: () => cpu,
      cpuCount: () => 2,
      monotonicNowMs: () => wall,
      // gated off by default so a test only sees the stages it wires
      measuresEventLoopDelay: false,
      measuresGc: false,
      measuresV8Heap: false,
      meminfo: () => undefined,
      eventLoopUtilization: () => undefined,
      memoryLimit: () => undefined,
      scheduler: fs.scheduler,
      ...over,
    },
    onError,
  );
  return {
    tracker,
    fs,
    advance: (c: { user: number; system: number }, w: number) => {
      cpu = c;
      wall = w;
    },
  };
}

function collect(tracker: ProcessTracker) {
  const got: [string, unknown][] = [];
  const off = tracker.onAny((name, payload) => void got.push([name, payload]));
  return { got, off };
}

describe('ProcessTracker', () => {
  it('attaches NOTHING at construction or on explicit start()/stop() (activation is per stage)', () => {
    const log: string[] = [];
    const { tracker, fs } = mk({ eventLoop: source('loop', log), gc: source('gc', log) });
    tracker.start();
    tracker.stop();
    expect(fs.sets()).toBe(0);
    expect(log).toEqual([]);
  });

  describe('per-stage activation', () => {
    it('arms only the sources of the stages that have a listener, behind ONE shared timer', () => {
      const log: string[] = [];
      const { tracker, fs } = mk({ eventLoop: source('loop', log), gc: source('gc', log) });
      const offMemory = tracker.on('memory', () => {});
      expect(fs.sets()).toBe(1);
      expect(log).toEqual([]); // a memory subscriber starts neither the histogram nor the GC observer
      const offGc = tracker.on('gc', () => {});
      expect(log).toEqual(['gc.start']);
      expect(fs.sets()).toBe(1);
      const offLoop = tracker.on('eventLoop', () => {});
      expect(log).toEqual(['gc.start', 'loop.start']);
      offGc();
      expect(log).toEqual(['gc.start', 'loop.start', 'gc.stop']);
      expect(fs.cleared()).toBe(0); // still wanted by memory + eventLoop
      offMemory();
      offLoop();
      expect(log).toEqual(['gc.start', 'loop.start', 'gc.stop', 'loop.stop']);
      expect(fs.cleared()).toBe(1);
      expect(fs.live()).toBe(0);
    });

    it('an onAny listener arms every stage', () => {
      const log: string[] = [];
      const { tracker } = mk({ eventLoop: source('loop', log), gc: source('gc', log) });
      const { off } = collect(tracker);
      expect(log).toEqual(['loop.start', 'gc.start']);
      off();
      expect(log).toEqual(['loop.start', 'gc.start', 'loop.stop', 'gc.stop']);
    });

    it('restart re-arms and starts every windowed stage FRESH: a sample taken by a TICK does not survive', () => {
      const log: string[] = [];
      let n = 0;
      const { tracker, fs, advance } = mk({
        eventLoop: source('loop', log, () => ({ meanMs: ++n, maxMs: 0, p99Ms: 0 })),
        gc: source('gc', log, () => ({ count: 1, pauseMs: 1, maxPauseMs: 1 })),
        eventLoopUtilization: () => 50,
      });
      const off = [
        tracker.on('eventLoop', () => {}),
        tracker.on('gc', () => {}),
        tracker.on('utilization', () => {}),
        tracker.on('cpu', () => {}),
      ];
      advance({ user: 10, system: 0 }, 1000);
      fs.tick();
      for (const stage of ['eventLoop', 'gc', 'utilization', 'cpu'] as const) {
        expect(tracker.current(stage), stage).toBeDefined();
      }
      for (const o of off) o();
      for (const stage of ['eventLoop', 'gc', 'utilization', 'cpu'] as const) {
        expect(tracker.current(stage), stage).toBeUndefined(); // unarmed
        tracker.on(stage, () => {});
        expect(tracker.current(stage), `${stage} after restart`).toBeUndefined(); // armed again, nothing ticked
      }
      expect(log.filter((l) => l.endsWith('.start'))).toHaveLength(4); // loop+gc started twice
    });

    it("utilization is windowed: each tick answers the reader's CURRENT value, not a retained one", () => {
      let u: number | undefined = 25;
      const { tracker, fs } = mk({ eventLoopUtilization: () => u });
      const got: unknown[] = [];
      tracker.on('utilization', (x) => void got.push(x));
      fs.tick();
      u = 75;
      fs.tick();
      u = undefined;
      fs.tick();
      expect(got).toEqual([{ utilizationPercent: 25 }, { utilizationPercent: 75 }]);
      expect(tracker.current('utilization')).toEqual({ utilizationPercent: 75 });
    });
  });

  describe('ticks', () => {
    it('emits every stage with exact values; cpu deltas are normalised by cores over the wall window', () => {
      const { tracker, fs, advance } = mk({
        eventLoop: source('loop', [], () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 })),
        gc: source('gc', [], () => ({ count: 3, pauseMs: 12.5, maxPauseMs: 8 })),
        eventLoopUtilization: () => 50,
        v8Heap: () => ({ limit: 10, used: 4, available: 6, malloced: 1, peakMalloced: 2 }),
        memoryLimit: () => 500,
      });
      const { got } = collect(tracker);
      advance({ user: 100_000, system: 50_000 }, 1000);
      fs.tick();
      expect(got).toEqual([
        ['memory', mem],
        ['systemMemory', { total: 100, free: 40 }],
        // (100 000 + 50 000) µs busy / (1 000 ms * 1 000) µs wall / 2 cores * 100 = 7.5 %
        ['cpu', { userDelta: 100_000, systemDelta: 50_000, processPct: 7.5 }],
        ['eventLoop', { meanMs: 1, maxMs: 2, p99Ms: 3 }],
        ['utilization', { utilizationPercent: 50 }],
        ['v8Heap', { limit: 10, used: 4, available: 6, malloced: 1, peakMalloced: 2 }],
        ['memoryLimit', { bytes: 500 }],
        ['gc', { count: 3, pauseMs: 12.5, maxPauseMs: 8 }],
      ]);
    });

    it('a zero wall window OMITS processPct (no divide by zero, never a fabricated 0%) but keeps the real deltas', () => {
      const { tracker, fs, advance } = mk();
      const { got } = collect(tracker);
      advance({ user: 500, system: 500 }, 0);
      fs.tick();
      expect(got.find(([n]) => n === 'cpu')?.[1]).toEqual({
        userDelta: 500,
        systemDelta: 500,
      });
    });

    it('a BACKWARDS wall window also omits processPct (not only a zero one)', () => {
      const { tracker, fs, advance } = mk();
      const { got } = collect(tracker);
      advance({ user: 500, system: 500 }, -100);
      fs.tick();
      expect(got.find(([n]) => n === 'cpu')?.[1]).toStrictEqual({
        userDelta: 500,
        systemDelta: 500,
      });
    });

    it('the cpu window moves on every tick (each tick covers only its own interval)', () => {
      const { tracker, fs, advance } = mk();
      const cpu: unknown[] = [];
      tracker.on('cpu', (c) => void cpu.push(c));
      advance({ user: 100_000, system: 0 }, 1000);
      fs.tick();
      advance({ user: 300_000, system: 0 }, 3000);
      fs.tick();
      expect(cpu).toEqual([
        { userDelta: 100_000, systemDelta: 0, processPct: 5 },
        { userDelta: 200_000, systemDelta: 0, processPct: 5 },
      ]);
    });

    it('a stage that cannot answer emits NOTHING (absence, never zero)', () => {
      const { tracker, fs } = mk({
        eventLoop: source('loop', [], () => undefined),
        gc: source('gc', [], () => undefined),
        v8Heap: () => undefined,
      });
      const { got } = collect(tracker);
      fs.tick();
      expect(got.map(([n]) => n)).toEqual(['memory', 'systemMemory', 'cpu']);
    });

    it('emitted payloads are copies: a subscriber cannot corrupt the retained cpu sample', () => {
      const { tracker, fs, advance } = mk();
      tracker.on('cpu', (c) => {
        c.userDelta = -1;
      });
      advance({ user: 10, system: 0 }, 1000);
      fs.tick();
      expect(tracker.current('cpu')?.userDelta).toBe(10);
    });

    it('a listener that unsubscribes a later stage mid-tick: that stage is not read', () => {
      const log: string[] = [];
      const { tracker, fs } = mk({
        eventLoop: source('loop', log, () => ({ meanMs: 1, maxMs: 1, p99Ms: 1 })),
      });
      const seen: string[] = [];
      let offLoop: () => void = () => {};
      tracker.on('memory', () => {
        seen.push('memory');
        offLoop();
      });
      offLoop = tracker.on('eventLoop', () => void seen.push('eventLoop'));
      fs.tick();
      expect(seen).toEqual(['memory']);
      expect(log).toEqual(['loop.start', 'loop.stop']);
    });

    it('a listener that tears the run down mid-tick stops the rest of that tick', () => {
      const { tracker, fs } = mk();
      const seen: string[] = [];
      const offs: (() => void)[] = [];
      offs.push(
        tracker.on('memory', () => {
          seen.push('memory');
          for (const o of offs) o(); // every listener leaves: the timer is cleared mid-tick
          tracker.on('cpu', () => void seen.push('cpu')); // and a NEW run starts
        }),
      );
      offs.push(tracker.on('systemMemory', () => void seen.push('systemMemory')));
      fs.tick();
      expect(seen).toEqual(['memory']); // the old run emitted nothing more
    });

    it('a listener that REBINDS mid-tick (stages re-armed on the new run) ends the old run’s tick', () => {
      const { tracker, fs } = mk();
      const seen: string[] = [];
      tracker.on('memory', () => {
        seen.push('memory');
        tracker.rebind({ intervalMs: 5 }); // changed seam: every stage is torn down and re-armed
      });
      tracker.on('systemMemory', () => void seen.push('systemMemory'));
      fs.callbackAt(0)?.();
      expect(seen).toEqual(['memory']);
    });

    it('a stale timer callback (an earlier arming) never emits', () => {
      const { tracker, fs } = mk();
      const { got, off } = collect(tracker);
      off(); // timer cleared, generation moved on
      const stale = fs.callbackAt(0);
      got.length = 0;
      stale?.();
      expect(got).toEqual([]);
      tracker.on('memory', () => void got.push(['memory', null]));
      stale?.(); // still the OLD run, though a new timer is armed
      expect(got).toEqual([]);
      fs.tick();
      expect(got).toEqual([['memory', null]]);
    });
  });

  describe('current()', () => {
    it('cpu has NO sample until its first tick (a zero-length window is not a reading); undefined unarmed', () => {
      const { tracker, fs, advance } = mk();
      expect(tracker.current('cpu')).toBeUndefined();
      const off = tracker.on('cpu', () => {});
      expect(tracker.current('cpu')).toBeUndefined();
      advance({ user: 10, system: 20 }, 1000);
      fs.tick();
      expect(tracker.current('cpu')).toEqual({
        userDelta: 10,
        systemDelta: 20,
        processPct: 0.0015,
      });
      off();
      expect(tracker.current('cpu')).toBeUndefined();
      tracker.on('cpu', () => {});
      expect(tracker.current('cpu')).toBeUndefined(); // the previous run's sample did not survive
    });

    it('an unusable core count omits the cpu sample (never Infinity/NaN) and keeps the window', () => {
      let cores = 0;
      const { tracker, fs, advance } = mk({ cpuCount: () => cores });
      const cpu: unknown[] = [];
      tracker.on('cpu', (c) => void cpu.push(c));
      advance({ user: 1000, system: 0 }, 1000);
      fs.tick();
      expect(cpu).toEqual([]);
      cores = 1;
      advance({ user: 2000, system: 0 }, 2000);
      fs.tick();
      expect(cpu).toEqual([{ userDelta: 2000, systemDelta: 0, processPct: 0.1 }]);
    });

    it('windowed stages answer the last emitted sample of this run', () => {
      let reads = 0;
      const { tracker, fs } = mk({
        gc: source('gc', [], () => ({ count: ++reads, pauseMs: 0, maxPauseMs: 0 })),
        eventLoopUtilization: () => 25,
      });
      tracker.on('gc', () => {});
      tracker.on('utilization', () => {});
      expect(tracker.current('gc')).toBeUndefined();
      fs.tick();
      expect(tracker.current('gc')).toEqual({ count: 1, pauseMs: 0, maxPauseMs: 0 });
      expect(tracker.current('utilization')).toEqual({ utilizationPercent: 25 });
      expect(reads).toBe(1); // reading the sample did not consume another window
    });

    it('stateless stages read LIVE, armed or not, and hand out copies', () => {
      const { tracker } = mk({ systemMemory: () => ({ total: 9, free: 7 }) });
      expect(tracker.current('systemMemory')).toEqual({ total: 9, free: 7 });
      expect(tracker.current('memory')).toEqual(mem);
      const m = tracker.current('memory');
      if (m) m.rss = 99;
      expect(tracker.current('memory')?.rss).toBe(1);
      tracker.on('systemMemory', () => {});
      expect(tracker.current('systemMemory')).toEqual({ total: 9, free: 7 });
    });

    it('is undefined for a stage with no reader or no answer', () => {
      const { tracker } = mk({ v8Heap: () => undefined });
      expect(tracker.current('v8Heap')).toBeUndefined();
      expect(tracker.current('memoryLimit')).toBeUndefined();
    });

    it('a throwing live read is reported and answers undefined', () => {
      const errors: unknown[] = [];
      const boom = new Error('boom');
      const { tracker } = mk(
        {
          memoryUsage: () => {
            throw boom;
          },
        },
        (e) => void errors.push(e),
      );
      expect(tracker.current('memory')).toBeUndefined();
      expect(errors).toEqual([boom]);
    });
  });

  describe('honest defaults and runtime gates', () => {
    it('without injected sources the real node readers answer (memory, system memory, heap, limit)', () => {
      const tracker = new ProcessTracker({
        scheduler: fakeScheduler().scheduler,
        readsVmStat: false,
      });
      expect(tracker.current('memory')?.rss).toBeGreaterThan(0);
      expect(tracker.current('systemMemory')?.total).toBeGreaterThan(0);
      expect(tracker.current('v8Heap')?.limit).toBeGreaterThan(0);
      // a real cap only: undefined on an unconstrained host, a positive number inside a cgroup
      const cap = tracker.current('memoryLimit');
      if (cap !== undefined) expect(cap.bytes).toBeGreaterThan(0);
      const sys = tracker.current('systemMemory');
      if (process.platform === 'darwin') {
        expect(sys).not.toHaveProperty('free'); // os.freemem() is not available memory there; vm_stat is opted out here
      } else {
        expect(sys?.free).toBeGreaterThanOrEqual(0);
        expect(sys?.free).toBeLessThanOrEqual(sys?.total ?? 0);
      }
    });

    it('real cpu defaults: the first tick reports finite deltas and a percentage', () => {
      const fs = fakeScheduler();
      const tracker = new ProcessTracker({ scheduler: fs.scheduler });
      const cpu: ProcessEvents['cpu'][] = [];
      tracker.on('cpu', (c) => void cpu.push(c));
      for (let i = 0; i < 2e5; i += 1) Math.sqrt(i);
      fs.tick();
      expect(cpu).toHaveLength(1);
      expect(Number.isFinite(cpu[0]?.processPct)).toBe(true);
      expect(cpu[0]?.userDelta).toBeGreaterThanOrEqual(0);
    });

    it('measuresEventLoopDelay:false never constructs a histogram; an injected source still wins', () => {
      const monitor = vi.fn();
      const perfHooks = {
        monitorEventLoopDelay: monitor,
        eventLoopUtilization: () => ({ utilization: 0 }),
      };
      const gated = mk({ perfHooks, measuresEventLoopDelay: false });
      gated.tracker.on('eventLoop', () => {});
      gated.fs.tick();
      expect(monitor).not.toHaveBeenCalled();
      const log: string[] = [];
      const injected = mk({
        perfHooks,
        measuresEventLoopDelay: false,
        eventLoop: source('loop', log, () => ({ meanMs: 1, maxMs: 1, p99Ms: 1 })),
      });
      injected.tracker.on('eventLoop', () => {});
      expect(log).toEqual(['loop.start']);
    });

    it('the guarded histogram is built lazily, only when the stage arms, and reports real-shaped lag', () => {
      const state = { monitor: 0, enabled: false };
      const histogram = {
        count: 3,
        enable: () => {
          state.enabled = true;
        },
        disable: () => {
          state.enabled = false;
        },
        reset: () => {},
        mean: 2e6,
        max: 9e6,
        percentile: () => 7e6,
      };
      const { tracker, fs } = mk({
        measuresEventLoopDelay: undefined,
        perfHooks: {
          monitorEventLoopDelay: () => {
            state.monitor += 1;
            return histogram;
          },
          eventLoopUtilization: () => ({ utilization: 0 }),
        },
      });
      tracker.on('memory', () => {});
      expect(state.monitor).toBe(0);
      const lag: unknown[] = [];
      const off = tracker.on('eventLoop', (l) => void lag.push(l));
      expect(state.enabled).toBe(true);
      fs.tick();
      expect(lag).toEqual([{ meanMs: 2, maxMs: 9, p99Ms: 7 }]);
      off();
      expect(state.enabled).toBe(false);
    });

    it('a stage the runtime cannot answer (gated off) arms NO sampling timer; a real stage alongside it arms exactly one', () => {
      const { tracker, fs } = mk({ measuresGc: false });
      const offGc = tracker.on('gc', () => {});
      expect(fs.sets()).toBe(0); // nothing could ever be read: no timer for it
      const offMem = tracker.on('memory', () => {});
      expect(fs.sets()).toBe(1);
      offMem();
      expect(fs.live()).toBe(0); // only the unanswerable stage is left: the timer is released
      offGc();
    });

    it.each([
      [
        'eventLoop (Deno: measuresEventLoopDelay:false)',
        'eventLoop',
        { measuresEventLoopDelay: false },
      ],
      ['v8Heap (Bun: measuresV8Heap:false)', 'v8Heap', { measuresV8Heap: false }],
    ] as const)('%s: a gated stage alone arms no timer', (_label, stage, over) => {
      const { tracker, fs } = mk(over as ProcessEnv);
      const off = tracker.on(stage, () => {});
      expect(fs.sets()).toBe(0);
      off();
    });

    it('an injected ELU reader answering an invalid value (NaN, infinite, negative) is omitted, never reported', () => {
      let u: number | undefined = 50;
      const { tracker, fs } = mk({ eventLoopUtilization: () => u });
      const got: unknown[] = [];
      tracker.on('utilization', (x) => void got.push(x));
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        u = bad;
        fs.tick();
      }
      u = 0;
      fs.tick(); // a genuine zero is kept
      u = 100;
      fs.tick();
      expect(got).toEqual([{ utilizationPercent: 0 }, { utilizationPercent: 100 }]);
    });

    it('measuresGc:false constructs no observer; the default wires the injected observer for gc entries', () => {
      const ctor = vi.fn();
      const gated = mk({ performanceObserver: ctor as never, measuresGc: false });
      gated.tracker.on('gc', () => {});
      expect(ctor).not.toHaveBeenCalled();

      const seen: string[][] = [];
      let disconnected = 0;
      class Observer {
        observe(o: { entryTypes: string[] }) {
          seen.push(o.entryTypes);
        }
        disconnect() {
          disconnected += 1;
        }
        takeRecords() {
          return [{ duration: 4 }];
        }
      }
      const { tracker, fs } = mk({ performanceObserver: Observer as never, measuresGc: undefined });
      const gc: unknown[] = [];
      const off = tracker.on('gc', (g) => void gc.push(g));
      expect(seen).toEqual([['gc']]);
      fs.tick();
      expect(gc).toEqual([{ count: 1, pauseMs: 4, maxPauseMs: 4 }]);
      off();
      expect(disconnected).toBe(1);
    });

    it('measuresV8Heap:false wires no heap reader even where the runtime answers; an injected reader wins', () => {
      const getter = mk({ measuresV8Heap: false });
      expect(getter.tracker.current('v8Heap')).toBeUndefined();
      const injected = mk({
        measuresV8Heap: false,
        v8Heap: () => ({ limit: 1, used: 1, available: 1, malloced: 1, peakMalloced: 1 }),
      });
      expect(injected.tracker.current('v8Heap')?.limit).toBe(1);
    });

    describe('systemMemory.free: memory available to new work', () => {
      const free = (over: Partial<ProcessEnv>) =>
        mk({ systemMemory: undefined, platform: 'linux', ...over }).tracker.current('systemMemory');
      const meminfo = () => 'MemAvailable: 2 kB\n';

      it('default: os.freemem(), and /proc/meminfo is never read (Deno must not trigger a permission prompt)', () => {
        let reads = 0;
        const got = free({ freeMemory: () => 7, meminfo: () => (reads++, 'MemAvailable: 2 kB\n') });
        expect(got?.free).toBe(7);
        expect(reads).toBe(0);
      });

      it('readsProcMeminfo (Bun): MemAvailable first, then os.freemem()', () => {
        expect(free({ readsProcMeminfo: true, freeMemory: () => 7, meminfo })?.free).toBe(2048);
        expect(
          free({ readsProcMeminfo: true, freeMemory: () => 7, meminfo: () => undefined })?.free,
        ).toBe(7);
      });

      it('a native source (Electron/Deno) wins over every other; it falls through when it has no answer', () => {
        const base = { freeMemory: () => 7, readsProcMeminfo: true, meminfo };
        expect(free({ ...base, nativeAvailableMemory: () => 5 })?.free).toBe(5);
        expect(free({ ...base, nativeAvailableMemory: () => undefined })?.free).toBe(2048);
      });

      it('macOS: os.freemem() (free pages only) is NOT a source; with vm_stat opted out free is omitted and total kept', () => {
        const got = free({ platform: 'darwin', freeMemory: () => 7, readsVmStat: false });
        expect(got?.total).toBeGreaterThan(0);
        expect(got).not.toHaveProperty('free');
        expect(
          free({ platform: 'darwin', freeMemory: () => 7, nativeAvailableMemory: () => 9 })?.free,
        ).toBe(9);
        expect(free({ platform: 'win32', freeMemory: () => 7 })?.free).toBe(7);
      });

      describe('macOS vm_stat source', () => {
        const OUT =
          'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nFile-backed pages: 20.\nPages purgeable: 30.\n';
        const fakeExec = () => {
          const calls: { cb: (e: Error | null, out: string) => void; killed: boolean }[] = [];
          const execFile = ((_f: string, _a: unknown, _o: unknown, cb: never) => {
            const call = { cb: cb as never, killed: false };
            calls.push(call);
            return {
              kill: () => {
                call.killed = true;
              },
            };
          }) as never;
          return { calls, execFile };
        };

        it('default sampler: lazy (nothing spawned by merely building), starts on the first free read, serves the value on the next tick', () => {
          const x = fakeExec();
          const { tracker, fs } = mk({
            systemMemory: undefined,
            platform: 'darwin',
            vmStatExecFile: x.execFile,
          });
          expect(x.calls).toHaveLength(0);
          const events: ProcessEvents['systemMemory'][] = [];
          tracker.on('systemMemory', (e) => void events.push(e));
          expect(x.calls).toHaveLength(0);
          fs.tick();
          expect(x.calls).toHaveLength(1);
          expect(events.at(-1)).not.toHaveProperty('free');
          x.calls[0]?.cb(null, OUT);
          fs.tick();
          expect(events.at(-1)?.free).toBe(60 * 4096);
          expect(x.calls).toHaveLength(1); // cached between 1 s ticks
        });

        it('stops (kills the in-flight child) when the stage loses its last listener, and restarts afresh', () => {
          const x = fakeExec();
          const { tracker, fs } = mk({
            systemMemory: undefined,
            platform: 'darwin',
            vmStatExecFile: x.execFile,
          });
          const off = tracker.on('systemMemory', () => {});
          fs.tick();
          off();
          expect(x.calls[0]?.killed).toBe(true);
          tracker.on('systemMemory', () => {});
          fs.tick();
          expect(x.calls).toHaveLength(2);
        });

        it('a failing vm_stat is reported through onError once per streak and the trace is omitted', () => {
          const x = fakeExec();
          const errors: unknown[] = [];
          const { tracker, fs } = mk(
            { systemMemory: undefined, platform: 'darwin', vmStatExecFile: x.execFile },
            (e) => void errors.push(e),
          );
          const events: ProcessEvents['systemMemory'][] = [];
          tracker.on('systemMemory', (e) => void events.push(e));
          fs.tick();
          x.calls[0]?.cb(new Error('exit 1'), '');
          fs.tick();
          expect(errors).toHaveLength(1);
          expect(events.every((e) => !('free' in e))).toBe(true);
        });

        it('current() on an UNARMED stage reads the cache only and never spawns; an armed tick does read', () => {
          let reads = 0;
          const vmStat = {
            read: () => {
              reads += 1;
              return 5;
            },
            peek: () => 7,
            stop: () => {},
          };
          const { tracker, fs } = mk({ systemMemory: undefined, platform: 'darwin', vmStat });
          expect(tracker.current('systemMemory')?.free).toBe(7);
          expect(reads).toBe(0);
          const events: ProcessEvents['systemMemory'][] = [];
          tracker.on('systemMemory', (e) => void events.push(e));
          fs.tick();
          expect(reads).toBe(1);
          expect(events.at(-1)?.free).toBe(5);
          expect(tracker.current('systemMemory')?.free).toBe(5); // armed: a live read, as before
          expect(reads).toBe(2);
        });

        describe('on Deno (never prompts)', () => {
          const withDeno = (
            state: string,
            run: (spawned: () => number, asked: () => number) => void,
          ) => {
            const g = globalThis as { Deno?: unknown };
            const had = 'Deno' in g;
            const prev = g.Deno;
            let spawned = 0;
            let asked = 0;
            g.Deno = {
              Command: class {
                constructor() {
                  spawned += 1;
                }
                output() {
                  return new Promise(() => {});
                }
              },
              permissions: {
                querySync: () => {
                  asked += 1;
                  return { state };
                },
              },
              systemMemoryInfo: () => ({ available: 999 }),
            };
            try {
              run(
                () => spawned,
                () => asked,
              );
            } finally {
              if (had) g.Deno = prev;
              else delete g.Deno;
            }
          };
          const tickFree = (over: Partial<ProcessEnv> = {}) => {
            const { tracker, fs } = mk({ systemMemory: undefined, platform: 'darwin', ...over });
            const events: ProcessEvents['systemMemory'][] = [];
            tracker.on('systemMemory', (e) => void events.push(e));
            fs.tick();
            tracker.reset();
            return events.at(-1);
          };

          it('run permission GRANTED: spawns through Deno.Command and does not mix in the larger estimate', () => {
            withDeno('granted', (spawned) => {
              const got = tickFree();
              expect(spawned()).toBe(1);
              expect(got).not.toHaveProperty('free'); // async: no value on the first tick, never the 999 estimate
            });
          });

          it.each([
            'prompt',
            'denied',
          ])('run permission %s: no spawn (so no prompt), Deno systemMemoryInfo answers', (state) => {
            withDeno(state, (spawned, asked) => {
              expect(tickFree()?.free).toBe(999);
              expect(spawned()).toBe(0);
              expect(asked()).toBeGreaterThan(0);
            });
          });

          it('an injected spawn function is honoured on Deno regardless of the permission (test seam)', () => {
            withDeno('prompt', (spawned) => {
              let injected = 0;
              const vmStatExecFile = (() => {
                injected += 1;
                return { kill: () => {} };
              }) as never;
              tickFree({ vmStatExecFile });
              expect(injected).toBe(1);
              expect(spawned()).toBe(0);
            });
          });

          it('readsVmStat:false on Deno: estimate only, permission never even queried for a spawn', () => {
            withDeno('granted', (spawned) => {
              expect(tickFree({ readsVmStat: false })?.free).toBe(999);
              expect(spawned()).toBe(0);
            });
          });
        });

        it.each([
          1000, 10_000, 30_000, 120_000,
        ])('the value read on one tick is still served on the next at tracker intervalMs=%i (cache life follows the tick)', (intervalMs) => {
          let now = 0;
          const x = fakeExec();
          const { tracker, fs } = mk({
            systemMemory: undefined,
            platform: 'darwin',
            vmStatExecFile: x.execFile,
            intervalMs,
          });
          const realNow = performance.now;
          performance.now = () => now;
          try {
            const events: ProcessEvents['systemMemory'][] = [];
            tracker.on('systemMemory', (e) => void events.push(e));
            fs.tick();
            x.calls[0]?.cb(null, OUT);
            now += intervalMs;
            fs.tick();
            expect(events.at(-1)?.free).toBe(60 * 4096);
            expect(x.calls).toHaveLength(intervalMs >= 10_000 ? 2 : 1); // never spawns faster than every 10 s
          } finally {
            performance.now = realNow;
          }
        });

        it('at the default 1 s tick the spawn cadence is 10 s: nine seconds of ticks spawn once, the tenth spawns again', () => {
          let now = 0;
          const x = fakeExec();
          const { tracker, fs } = mk({
            systemMemory: undefined,
            platform: 'darwin',
            vmStatExecFile: x.execFile,
          });
          const realNow = performance.now;
          performance.now = () => now;
          try {
            tracker.on('systemMemory', () => {});
            for (; now < 10_000; now += 1000) fs.tick();
            expect(x.calls).toHaveLength(1);
            fs.tick(); // now = 10 000
            expect(x.calls).toHaveLength(2);
          } finally {
            performance.now = realNow;
          }
        });

        it('readsVmStat:false never spawns; vm_stat is not consulted off macOS', () => {
          const x = fakeExec();
          for (const over of [{ platform: 'darwin', readsVmStat: false }, { platform: 'linux' }]) {
            const { tracker, fs } = mk({
              systemMemory: undefined,
              vmStatExecFile: x.execFile,
              freeMemory: () => 1,
              ...over,
            });
            tracker.on('systemMemory', () => {});
            fs.tick();
          }
          expect(x.calls).toHaveLength(0);
        });

        it.skipIf(process.platform !== 'darwin')(
          'real macOS: /usr/bin/vm_stat answers a plausible available figure asynchronously',
          async () => {
            const { tracker, fs } = mk({ systemMemory: undefined });
            const events: ProcessEvents['systemMemory'][] = [];
            tracker.on('systemMemory', (e) => void events.push(e));
            try {
              for (let i = 0; i < 100 && events.at(-1)?.free === undefined; i += 1) {
                fs.tick();
                await new Promise((r) => setTimeout(r, 20));
              }
              const last = events.at(-1);
              expect(last?.free).toBeGreaterThan(0);
              expect(last?.free).toBeLessThanOrEqual(last?.total ?? 0);
            } finally {
              tracker.reset();
            }
          },
        );
      });

      it('default native sources: Electron process.getSystemMemoryInfo() on this process object, Deno systemMemoryInfo on macOS', () => {
        const proc = nodeProcessForTest as { getSystemMemoryInfo?: unknown };
        const g = globalThis as { Deno?: unknown };
        const hadDeno = 'Deno' in g;
        const prevDeno = g.Deno;
        try {
          proc.getSystemMemoryInfo = () => ({ available: 3 }); // KiB, linux
          expect(free({ platform: 'linux', freeMemory: () => 7 })?.free).toBe(3072);
          delete proc.getSystemMemoryInfo;
          g.Deno = { systemMemoryInfo: () => ({ available: 4096 }) };
          expect(free({ platform: 'darwin' })?.free).toBe(4096);
          expect(free({ platform: 'linux', freeMemory: () => 7 })?.free).toBe(7); // Deno source is macOS-only
        } finally {
          delete proc.getSystemMemoryInfo;
          if (hadDeno) g.Deno = prevDeno;
          else delete g.Deno;
        }
      });

      it('omits free (keeps total) when no source answers a plausible value', () => {
        const got = free({ freeMemory: () => Number.NaN });
        expect(got?.total).toBeGreaterThan(0);
        expect(got).not.toHaveProperty('free');
      });

      it('an injected systemMemory replaces every free source', () => {
        expect(mk({ freeMemory: () => 5 }).tracker.current('systemMemory')).toEqual({
          total: 100,
          free: 40,
        });
      });

      it('every free-memory seam survives processTrackerFor (a dropped SEAM_KEYS entry would silently ignore it)', () => {
        const at = (env: Partial<ProcessEnv>) => {
          const key = {};
          try {
            return processTrackerFor({
              key,
              scheduler: fakeScheduler().scheduler,
              platform: 'linux',
              freeMemory: () => 11,
              ...env,
            }).current('systemMemory');
          } finally {
            resetProcessTracker(key);
          }
        };
        expect(at({})?.free).toBe(11); // freeMemory + platform(linux: freemem is a source)
        expect(at({ platform: 'darwin', readsVmStat: false })).not.toHaveProperty('free'); // platform + readsVmStat
        expect(
          at({ platform: 'darwin', vmStat: { read: () => 55, peek: () => 55, stop: () => {} } })
            ?.free,
        ).toBe(55); // vmStat
        expect(at({ readsProcMeminfo: true, meminfo: () => 'MemAvailable: 1 kB\n' })?.free).toBe(
          1024,
        ); // readsProcMeminfo + meminfo
        expect(at({ meminfo: () => 'MemAvailable: 1 kB\n' })?.free).toBe(11); // meminfo ignored without readsProcMeminfo
        expect(at({ nativeAvailableMemory: () => 77 })?.free).toBe(77); // nativeAvailableMemory
        let spawned = 0;
        const vmStatExecFile = (() => {
          spawned += 1;
          return { kill: () => {} };
        }) as never;
        const armed = (env: Partial<ProcessEnv>) => {
          const key = {};
          const fs = fakeScheduler();
          try {
            const tracker = processTrackerFor({ key, scheduler: fs.scheduler, ...env });
            tracker.on('systemMemory', () => {});
            fs.tick();
          } finally {
            resetProcessTracker(key);
          }
        };
        armed({ platform: 'darwin', vmStatExecFile, readsVmStat: false });
        expect(spawned).toBe(0); // readsVmStat survives processTrackerFor
        armed({ platform: 'darwin', vmStatExecFile });
        expect(spawned).toBe(1); // vmStatExecFile survives processTrackerFor
      });
    });

    it('guarded ELU: a fresh baseline per arming, and Bun/Deno-style flat zeros are omitted, never reported as 0%', () => {
      let calls = 0;
      const fs = fakeScheduler();
      const tracker = new ProcessTracker({
        scheduler: fs.scheduler,
        eventLoopUtilization: undefined,
        perfHooks: {
          monitorEventLoopDelay: () => {
            throw new Error('unused');
          },
          eventLoopUtilization: (() => {
            calls += 1;
            return { idle: 0, active: 0, utilization: 0 };
          }) as never,
        },
      });
      const got: unknown[] = [];
      const off = tracker.on('utilization', (u) => void got.push(u));
      expect(calls).toBe(1); // the baseline read at arming
      fs.tick();
      expect(got).toEqual([]);
      off();
      tracker.on('utilization', () => {});
      expect(calls).toBe(4); // 1 + (current + delta) on the tick, then a NEW baseline for the new run
    });

    it('guarded ELU reports a real delta', () => {
      const fs = fakeScheduler();
      let t = 0;
      const tracker = new ProcessTracker({
        scheduler: fs.scheduler,
        perfHooks: {
          monitorEventLoopDelay: () => {
            throw new Error('unused');
          },
          eventLoopUtilization: ((
            a?: { idle: number; active: number },
            b?: { idle: number; active: number },
          ) => {
            if (a && b) {
              const idle = a.idle - b.idle;
              const active = a.active - b.active;
              return { idle, active, utilization: active / (idle + active) };
            }
            t += 1;
            return { idle: 30 * t, active: 10 * t, utilization: 0.25 };
          }) as never,
        },
      });
      const got: unknown[] = [];
      tracker.on('utilization', (u) => void got.push(u));
      fs.tick();
      expect(got).toEqual([{ utilizationPercent: 25 }]);
    });
  });

  describe('failures', () => {
    it('a throwing stage read is reported and drops ONLY that stage for the tick', () => {
      const errors: unknown[] = [];
      const boom = new Error('systemMemory');
      const { tracker, fs } = mk(
        {
          systemMemory: () => {
            throw boom;
          },
        },
        (e) => void errors.push(e),
      );
      const { got } = collect(tracker);
      fs.tick();
      expect(errors).toEqual([boom]);
      expect(got.map(([n]) => n)).toEqual(['memory', 'cpu']);
      fs.tick(); // the timer survives
      expect(errors).toEqual([boom, boom]);
    });

    it('a throwing cpu read does not advance the cpu baseline: the next window covers the whole gap', () => {
      let fail = true;
      let user = 0;
      let wall = 0;
      const fs = fakeScheduler();
      const tracker = new ProcessTracker({
        cpuUsage: () => {
          if (fail && user > 0) throw new Error('cpu');
          return { user, system: 0 };
        },
        monotonicNowMs: () => wall,
        cpuCount: () => 1,
        scheduler: fs.scheduler,
      });
      const cpu: unknown[] = [];
      tracker.on('cpu', (c) => void cpu.push(c));
      user = 1000;
      wall = 1;
      fs.tick(); // throws, swallowed (no reporter)
      fail = false;
      user = 3000;
      wall = 3;
      fs.tick();
      expect(cpu).toEqual([{ userDelta: 3000, systemDelta: 0, processPct: 100 }]);
    });

    it('a failing wall-clock read cannot advance the cpu window either', () => {
      let wallFails = false;
      let user = 0;
      let wall = 0;
      const fs = fakeScheduler();
      const tracker = new ProcessTracker({
        cpuUsage: () => ({ user, system: 0 }),
        monotonicNowMs: () => {
          if (wallFails) throw new Error('wall');
          return wall;
        },
        cpuCount: () => 1,
        scheduler: fs.scheduler,
      });
      const cpu: ProcessEvents['cpu'][] = [];
      tracker.on('cpu', (c) => void cpu.push(c));
      user = 1000;
      wall = 1;
      wallFails = true;
      fs.tick();
      wallFails = false;
      fs.tick();
      expect(cpu).toEqual([{ userDelta: 1000, systemDelta: 0, processPct: 100 }]);
    });

    it('a source whose start() throws is reported and left UNARMED (never stopped); a later listener change retries', () => {
      const errors: unknown[] = [];
      const log: string[] = [];
      let fail = true;
      const flaky: EventLoopSource = {
        start: () => {
          log.push('start');
          if (fail) throw new Error('refused');
        },
        stop: () => void log.push('stop'),
        read: () => ({ meanMs: 1, maxMs: 1, p99Ms: 1 }),
      };
      const { tracker, fs } = mk({ eventLoop: flaky }, (e) => void errors.push(e));
      const lag: unknown[] = [];
      const off = tracker.on('eventLoop', (l) => void lag.push(l));
      expect(errors).toHaveLength(1);
      expect(fs.sets()).toBe(0); // nothing armed, so no timer either
      off();
      expect(log).toEqual(['start']); // never stopped: it never started
      fail = false;
      tracker.on('eventLoop', (l) => void lag.push(l));
      fs.tick();
      expect(lag).toEqual([{ meanMs: 1, maxMs: 1, p99Ms: 1 }]);
    });

    it('a failing gc start is isolated from the other stages', () => {
      const errors: unknown[] = [];
      const gc: GcSource = {
        start: () => {
          throw new Error('gc');
        },
        stop: () => {},
        read: () => undefined,
      };
      const { tracker, fs } = mk({ gc }, (e) => void errors.push(e));
      const mems: unknown[] = [];
      tracker.on('memory', (m) => void mems.push(m));
      tracker.on('gc', () => {});
      expect(errors).toHaveLength(1);
      fs.tick();
      expect(mems).toHaveLength(1);
    });

    it('one failing stop() is reported and does not strand another stage; a throwing reporter is swallowed', () => {
      const log: string[] = [];
      const bad = {
        start: () => {},
        stop: () => {
          log.push('loop.stop');
          throw new Error('stop');
        },
        read: () => undefined,
      };
      const reporter = vi.fn(() => {
        throw new Error('reporter');
      });
      const { tracker } = mk({ eventLoop: bad, gc: source('gc', log) }, reporter);
      const { off } = collect(tracker);
      expect(() => off()).not.toThrow();
      expect(log).toEqual(['gc.start', 'loop.stop', 'gc.stop']);
      expect(reporter).toHaveBeenCalledTimes(1);
    });

    it('a scheduler that cannot arm the timer unwinds every stage armed for it, and a later change retries', () => {
      const errors: unknown[] = [];
      const log: string[] = [];
      let fail = true;
      const fs = fakeScheduler();
      const { tracker } = mk(
        {
          eventLoop: source('loop', log),
          scheduler: {
            setInterval: (cb) => {
              if (fail) throw new Error('no timers');
              return fs.scheduler.setInterval(cb);
            },
            clearInterval: fs.scheduler.clearInterval,
          },
        },
        (e) => void errors.push(e),
      );
      const off = tracker.on('eventLoop', () => {});
      expect(errors).toHaveLength(1);
      expect(log).toEqual(['loop.start', 'loop.stop']); // not left running with nothing to read it
      off();
      fail = false;
      tracker.on('eventLoop', () => {});
      expect(fs.sets()).toBe(1);
      expect(log).toEqual(['loop.start', 'loop.stop', 'loop.start']);
    });

    it('a throwing clearInterval is reported and does not leave the tracker armed', () => {
      const errors: unknown[] = [];
      const { tracker } = mk(
        {
          scheduler: {
            setInterval: () => 'h',
            clearInterval: () => {
              throw new Error('clear');
            },
          },
        },
        (e) => void errors.push(e),
      );
      const off = tracker.on('memory', () => {});
      off();
      expect(errors).toHaveLength(1);
    });

    it('errors are optional everywhere: no reporter, nothing throws', () => {
      const { tracker, fs } = mk({
        systemMemory: () => {
          throw new Error('x');
        },
        eventLoop: {
          start: () => {
            throw new Error('y');
          },
          stop: () => {},
          read: () => undefined,
        },
      });
      expect(() => {
        tracker.on('systemMemory', () => {});
        tracker.on('eventLoop', () => {});
        fs.tick();
        tracker.current('systemMemory');
      }).not.toThrow();
    });
  });

  describe('rebind', () => {
    it('merges: defined seams replace, undefined never clobber an earlier one', () => {
      const { tracker, fs } = mk({ systemMemory: () => ({ total: 5, free: 1 }) });
      tracker.rebind({ systemMemory: undefined, memoryUsage: () => ({ ...mem, rss: 77 }) });
      expect(tracker.current('systemMemory')).toEqual({ total: 5, free: 1 });
      expect(tracker.current('memory')?.rss).toBe(77);
      expect(fs.sets()).toBe(0);
    });

    it('an unchanged rebind restarts nothing (a relaunch with the same seams keeps its windows)', () => {
      const log: string[] = [];
      const loop = source('loop', log);
      const { tracker, fs } = mk({ eventLoop: loop });
      tracker.on('eventLoop', () => {});
      tracker.rebind({ eventLoop: loop, scheduler: fs.scheduler });
      expect(log).toEqual(['loop.start']);
      expect(fs.sets()).toBe(1);
    });

    it('a changed seam on a RUNNING tracker tears down with the OLD seams, then re-arms on the new ones', () => {
      const log: string[] = [];
      const first = mk({ eventLoop: source('old', log) });
      const second = fakeScheduler();
      const got: unknown[] = [];
      first.tracker.on('eventLoop', (l) => void got.push(l));
      first.tracker.rebind({
        eventLoop: source('new', log, () => ({ meanMs: 9, maxMs: 9, p99Ms: 9 })),
        scheduler: second.scheduler,
      });
      expect(log).toEqual(['old.start', 'old.stop', 'new.start']);
      expect(first.fs.cleared()).toBe(1); // cleared on the scheduler that armed it
      expect(first.fs.live()).toBe(0);
      expect(second.sets()).toBe(1);
      first.fs.callbackAt(0)?.(); // the old timer, fired late
      expect(got).toEqual([]);
      second.tick();
      expect(got).toEqual([{ meanMs: 9, maxMs: 9, p99Ms: 9 }]);
    });

    it('a changed gate re-resolves the sources: a gate flipped off drops the stage from then on', () => {
      const seen: string[] = [];
      let disconnected = 0;
      class Observer {
        observe() {
          seen.push('observe');
        }
        disconnect() {
          disconnected += 1;
        }
      }
      const { tracker, fs } = mk({ performanceObserver: Observer as never, measuresGc: undefined });
      const gc: unknown[] = [];
      tracker.on('gc', (g) => void gc.push(g));
      expect(seen).toEqual(['observe']);
      tracker.rebind({ measuresGc: false });
      expect(disconnected).toBe(1);
      fs.tick();
      expect(gc).toEqual([]);
    });

    it('rebinding an idle tracker only swaps the seams', () => {
      const { tracker, fs } = mk();
      tracker.rebind({ intervalMs: 50, scheduler: fs.scheduler });
      expect(fs.sets()).toBe(0);
      const seen: number[] = [];
      const timers = {
        setInterval: (_cb: () => void, ms: number) => {
          seen.push(ms);
          return 'h';
        },
        clearInterval: () => {},
      };
      tracker.rebind({ scheduler: timers });
      tracker.on('memory', () => {});
      expect(seen).toEqual([50]);
    });

    it('the latest launch error reporter wins; undefined keeps it; a throwing reporter is swallowed', () => {
      const first: unknown[] = [];
      const second: unknown[] = [];
      const { tracker } = mk({}, (e) => void first.push(e));
      const failing = {
        memoryUsage: () => {
          throw new Error('m');
        },
      };
      tracker.rebind(failing, (e) => void second.push(e));
      tracker.current('memory');
      expect(first).toEqual([]);
      expect(second).toHaveLength(1);
      tracker.rebind({}, undefined);
      tracker.current('memory');
      expect(second).toHaveLength(2);
      tracker.rebind({}, () => {
        throw new Error('reporter');
      });
      expect(() => tracker.current('memory')).not.toThrow();
    });
  });

  it('a throwing subscriber is reported, and a throwing reporter never escapes into the timer callback', () => {
    const errors: unknown[] = [];
    const a = mk({}, (e) => void errors.push(e));
    a.tracker.on('memory', () => {
      throw new Error('listener');
    });
    a.fs.tick();
    expect(errors).toHaveLength(1);
    const b = mk({}, () => {
      throw new Error('reporter');
    });
    b.tracker.on('memory', () => {
      throw new Error('listener');
    });
    expect(() => b.fs.tick()).not.toThrow();
  });

  it('reset() drops every listener and releases the timer and sources', () => {
    const log: string[] = [];
    const { tracker, fs } = mk({ eventLoop: source('loop', log) });
    collect(tracker);
    tracker.reset();
    expect(log).toEqual(['loop.start', 'loop.stop']);
    expect(fs.live()).toBe(0);
    tracker.on('memory', () => {});
    expect(fs.sets()).toBe(2);
  });

  describe('default scheduler', () => {
    it('delivers real ticks, is unref’d, and is silent after the last unsubscribe', async () => {
      const tracker = new ProcessTracker({ intervalMs: 5 });
      let n = 0;
      const off = tracker.on('memory', () => {
        n += 1;
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(n).toBeGreaterThan(0);
      off();
      const after = n;
      await new Promise((r) => setTimeout(r, 30));
      expect(n).toBe(after);
    });

    it('the sampling timer is unref’d: it can never keep the process alive', () => {
      const real = globalThis.setInterval;
      let unrefs = 0;
      globalThis.setInterval = (() => ({
        unref: () => {
          unrefs += 1;
        },
      })) as never;
      try {
        const off = new ProcessTracker({}).on('memory', () => {});
        expect(unrefs).toBe(1);
        off();
      } finally {
        globalThis.setInterval = real;
      }
    });

    it('a handle without unref() is tolerated', () => {
      const real = globalThis.setInterval;
      let ref: unknown;
      globalThis.setInterval = ((cb: () => void, ms: number) => {
        ref = { id: 1, cb, ms };
        return ref;
      }) as never;
      const realClear = globalThis.clearInterval;
      let cleared: unknown;
      globalThis.clearInterval = ((h: unknown) => {
        cleared = h;
      }) as never;
      try {
        const tracker = new ProcessTracker({});
        const off = tracker.on('memory', () => {});
        off();
        expect(cleared).toBe(ref);
      } finally {
        globalThis.setInterval = real;
        globalThis.clearInterval = realClear;
      }
    });
  });
});

describe('processTrackerFor (per-process singleton)', () => {
  const key = {};
  const idle = (over: Partial<ProcessEnv> = {}): ProcessEnv => ({
    scheduler: fakeScheduler().scheduler,
    ...over,
  });

  it('returns ONE tracker per key, and a different one for another key', () => {
    const a = processTrackerFor({ key, ...idle() });
    expect(processTrackerFor({ key, ...idle() })).toBe(a);
    const other = {};
    expect(processTrackerFor({ key: other, ...idle() })).not.toBe(a);
    resetProcessTracker(key);
    resetProcessTracker(other);
  });

  it('defaults to the `process` object as the key', () => {
    const a = processTrackerFor({ scheduler: fakeScheduler().scheduler });
    expect(processTrackerFor()).toBe(a);
    resetProcessTracker();
    expect(processTrackerFor()).not.toBe(a);
    resetProcessTracker();
  });

  it('a second request rebinds the shared tracker (latest launch wins, merge never drops, onError replaced)', () => {
    const first = fakeScheduler();
    const second = fakeScheduler();
    const errors: unknown[] = [];
    const tracker = processTrackerFor({
      key,
      scheduler: first.scheduler,
      systemMemory: () => ({ total: 3, free: 3 }),
    });
    tracker.on('memory', () => {});
    expect(first.sets()).toBe(1);
    const again = processTrackerFor(
      {
        key,
        scheduler: second.scheduler,
        memoryUsage: () => {
          throw new Error('m');
        },
      },
      (e) => void errors.push(e),
    );
    expect(again).toBe(tracker);
    expect(first.live()).toBe(0);
    expect(second.sets()).toBe(1); // re-armed on the latest launch's scheduler
    expect(tracker.current('systemMemory')).toEqual({ total: 3, free: 3 }); // earlier seam kept
    tracker.current('memory');
    expect(errors).toHaveLength(1);
    resetProcessTracker(key);
    expect(second.live()).toBe(0); // reset released the timer
  });

  it('resetProcessTracker of an unknown key is a no-op', () => {
    expect(() => resetProcessTracker({})).not.toThrow();
  });
});
