import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessTimers } from '../node/process-tracker';
import {
  type ElectronAppSource,
  ElectronProcessTracker,
  electronProcessTrackerFor,
  resetElectronProcessTracker,
} from './process-tracker';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A manual scheduler: `tick()` fires the armed callback; records arm/clear. */
function fakeScheduler() {
  let cb: (() => void) | undefined;
  const api = {
    setInterval: vi.fn((callback: () => void, _ms: number) => {
      cb = callback;
      return { id: api.setInterval.mock.calls.length };
    }),
    clearInterval: vi.fn(() => {
      cb = undefined;
    }),
    tick: () => cb?.(),
    get armed() {
      return cb !== undefined;
    },
    callback: () => cb,
  };
  return api satisfies ProcessTimers & Record<string, unknown>;
}

const proc = (over: Record<string, unknown> = {}) => ({
  pid: 100,
  type: 'Browser',
  cpu: { percentCPUUsage: 12.5, idleWakeupsPerSecond: 3 },
  memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 },
  ...over,
});

type GoneListener = (event: unknown, details: unknown) => void;
function fakeApp(over: Partial<ElectronAppSource> = {}) {
  const listeners: GoneListener[] = [];
  const raw = {
    getAppMetrics: vi.fn((): unknown => [proc()]),
    on: vi.fn((_event: string, l: GoneListener): unknown => {
      listeners.push(l);
      return undefined;
    }),
    removeListener: vi.fn((_event: string, l: GoneListener): unknown => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
      return undefined;
    }),
  };
  const app = { ...raw, ...over } as unknown as ElectronAppSource;
  return { app, raw, listeners };
}

const created: object[] = [];
const make = (
  app: ElectronAppSource,
  extra: { scheduler?: ProcessTimers; intervalMs?: number } = {},
  onError?: (e: unknown) => unknown,
) => {
  const tracker = new ElectronProcessTracker({ app, ...extra }, onError);
  created.push(tracker);
  return tracker;
};

afterEach(() => {
  for (const t of created.splice(0)) (t as ElectronProcessTracker).reset();
});

describe('appMetrics stage', () => {
  it('does nothing without a listener: no read, no timer', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    make(app, { scheduler: sch });
    expect(raw.getAppMetrics).not.toHaveBeenCalled();
    expect(sch.setInterval).not.toHaveBeenCalled();
  });

  it('arms with ONE priming read that is NOT emitted, on the injected scheduler at the default 1 s', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    const seen = vi.fn();
    t.on('appMetrics', seen);
    expect(raw.getAppMetrics).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
    expect(sch.setInterval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1000);
    expect(t.current('appMetrics')).toBeUndefined(); // no start sample
  });

  it('honours intervalMs and emits the mapped processes on each tick (KiB -> bytes)', () => {
    const { app, raw } = fakeApp();
    raw.getAppMetrics.mockReturnValue([
      proc(),
      proc({
        pid: 7,
        type: 'GPU',
        memory: { workingSetSize: 1, peakWorkingSetSize: 2, privateBytes: 3 },
      }),
    ]);
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch, intervalMs: 250 });
    const seen = vi.fn();
    t.on('appMetrics', seen);
    expect(sch.setInterval).toHaveBeenCalledWith(expect.any(Function), 250);
    sch.tick();
    expect(seen).toHaveBeenCalledExactlyOnceWith({
      processes: [
        {
          type: 'Browser',
          pid: 100,
          cpuPct: 12.5,
          workingSetBytes: 2048 * 1024,
          peakWorkingSetBytes: 4096 * 1024,
        },
        {
          type: 'GPU',
          pid: 7,
          cpuPct: 12.5,
          workingSetBytes: 1024,
          peakWorkingSetBytes: 2048,
          privateBytes: 3072,
        },
      ],
    });
  });

  it('omits every field Electron did not supply (never zero), keeping a true 0', () => {
    const { app, raw } = fakeApp();
    raw.getAppMetrics.mockReturnValue([
      { pid: 1, type: 'Tab', cpu: { percentCPUUsage: 0 }, memory: {} },
      { pid: 2, type: 'Utility', memory: { workingSetSize: 5 } },
      {
        pid: 3,
        type: 'Zygote',
        cpu: { percentCPUUsage: Number.NaN },
        memory: { workingSetSize: -1 },
      },
      { pid: 4, type: 'GPU', cpu: { percentCPUUsage: '5' }, memory: { peakWorkingSetSize: 9 } },
    ]);
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    const seen = vi.fn();
    t.on('appMetrics', seen);
    sch.tick();
    expect(seen).toHaveBeenCalledExactlyOnceWith({
      processes: [
        { type: 'Tab', pid: 1, cpuPct: 0 },
        { type: 'Utility', pid: 2, workingSetBytes: 5120 },
        { type: 'GPU', pid: 4, peakWorkingSetBytes: 9216 },
      ],
    });
  });

  it.each([
    ['not an array', { pid: 1 }],
    ['an empty list', []],
    ['only non-objects', [1, null, 'x']],
    [
      'entries without a usable type/pid',
      [
        { pid: 1 },
        { type: '', pid: 1, cpu: { percentCPUUsage: 1 } },
        { type: 'Tab', pid: 'x', cpu: { percentCPUUsage: 1 } },
        { type: 'Tab', pid: Number.POSITIVE_INFINITY, cpu: { percentCPUUsage: 1 } },
      ],
    ],
    [
      'only infinite readings',
      [
        {
          pid: 1,
          type: 'Tab',
          cpu: { percentCPUUsage: Number.POSITIVE_INFINITY },
          memory: { workingSetSize: Number.POSITIVE_INFINITY },
        },
      ],
    ],
    [
      'entries with nothing measurable',
      [
        { pid: 1, type: 'Tab' },
        { pid: 2, type: 'Tab', cpu: null, memory: null },
      ],
    ],
  ])('emits nothing for %s (and reports nothing)', (_n, value) => {
    const { app, raw } = fakeApp();
    raw.getAppMetrics.mockReturnValue(value);
    const onError = vi.fn();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch }, onError);
    const seen = vi.fn();
    t.on('appMetrics', seen);
    sch.tick();
    expect(seen).not.toHaveBeenCalled();
    expect(t.current('appMetrics')).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  describe("cpu is omitted on a process's FIRST sighting (Chromium reports 0 on the first call per process)", () => {
    it('a process that appears after arming has no cpuPct on its first tick, and has one on the next', () => {
      const { app, raw } = fakeApp();
      raw.getAppMetrics.mockReturnValue([proc()]); // priming read: only pid 100 exists
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      raw.getAppMetrics.mockReturnValue([
        proc(),
        proc({ pid: 200, type: 'Tab', cpu: { percentCPUUsage: 0 } }),
      ]);
      sch.tick();
      expect(seen.mock.calls[0]?.[0].processes).toEqual([
        expect.objectContaining({ pid: 100, cpuPct: 12.5 }),
        { type: 'Tab', pid: 200, workingSetBytes: 2048 * 1024, peakWorkingSetBytes: 4096 * 1024 },
      ]);
      expect(seen.mock.calls[0]?.[0].processes[1]).not.toHaveProperty('cpuPct');
      sch.tick();
      expect(seen.mock.calls[1]?.[0].processes[1]).toHaveProperty('cpuPct', 0);
    });

    it('a restarted process (same type, NEW pid) is a first sighting again', () => {
      const { app, raw } = fakeApp();
      raw.getAppMetrics.mockReturnValue([proc({ pid: 5, type: 'GPU' })]);
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      sch.tick();
      expect(seen.mock.calls[0]?.[0].processes[0]).toHaveProperty('cpuPct');
      raw.getAppMetrics.mockReturnValue([proc({ pid: 6, type: 'GPU' })]);
      sch.tick();
      expect(seen.mock.calls[1]?.[0].processes[0]).toMatchObject({ pid: 6, type: 'GPU' });
      expect(seen.mock.calls[1]?.[0].processes[0]).not.toHaveProperty('cpuPct');
    });

    it('a process that was absent for a tick is a first sighting again when it returns', () => {
      const { app, raw } = fakeApp();
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      raw.getAppMetrics.mockReturnValue([]);
      sch.tick();
      raw.getAppMetrics.mockReturnValue([proc()]);
      sch.tick();
      expect(seen.mock.calls[0]?.[0].processes[0]).not.toHaveProperty('cpuPct');
    });

    it('a process only a cpu reading would describe is dropped on its first sighting', () => {
      const { app, raw } = fakeApp();
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      raw.getAppMetrics.mockReturnValue([{ pid: 9, type: 'Tab', cpu: { percentCPUUsage: 0 } }]);
      sch.tick();
      expect(seen).not.toHaveBeenCalled();
    });

    it('re-arming re-primes: the sightings of the previous run do not carry over', () => {
      const { app } = fakeApp();
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const off = t.on('appMetrics', vi.fn());
      sch.tick();
      off();
      const seen = vi.fn();
      t.on('appMetrics', seen); // priming read sees pid 100 again
      sch.tick();
      expect(seen.mock.calls[0]?.[0].processes[0]).toHaveProperty('cpuPct');
    });

    it('a priming read of a malformed list leaves no sightings', () => {
      const { app, raw } = fakeApp();
      raw.getAppMetrics.mockReturnValue('nope');
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      raw.getAppMetrics.mockReturnValue([proc()]);
      sch.tick();
      expect(seen.mock.calls[0]?.[0].processes[0]).not.toHaveProperty('cpuPct');
    });
  });

  describe('cumulativeCPUUsage (newer Electron sends cpu 0 "for compatibility" when it cannot read CPU)', () => {
    const withCum = (pid: number, cumulativeCPUUsage?: unknown) =>
      proc({
        pid,
        cpu: {
          percentCPUUsage: 7,
          ...(cumulativeCPUUsage !== undefined ? { cumulativeCPUUsage } : {}),
        },
      });

    it('omits cpuPct for a process lacking it when the runtime reports it for others; keeps it where present', () => {
      const { app, raw } = fakeApp();
      raw.getAppMetrics.mockReturnValue([withCum(1, 3), withCum(2)]);
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      sch.tick();
      const [a, b] = seen.mock.calls[0]?.[0].processes ?? [];
      expect(a).toHaveProperty('cpuPct', 7);
      expect(b).not.toHaveProperty('cpuPct');
    });

    it('does not apply the rule on an Electron that reports no cumulativeCPUUsage at all', () => {
      const { app, raw } = fakeApp();
      raw.getAppMetrics.mockReturnValue([withCum(1), withCum(2)]);
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      sch.tick();
      expect(seen.mock.calls[0]?.[0].processes.map((p: { cpuPct?: number }) => p.cpuPct)).toEqual([
        7, 7,
      ]);
    });

    it('a non-numeric cumulativeCPUUsage counts as missing', () => {
      const { app, raw } = fakeApp();
      raw.getAppMetrics.mockReturnValue([withCum(1, 3), withCum(2, 'x'), withCum(3, Number.NaN)]);
      const sch = fakeScheduler();
      const t = make(app, { scheduler: sch });
      const seen = vi.fn();
      t.on('appMetrics', seen);
      sch.tick();
      expect(seen.mock.calls[0]?.[0].processes.map((p: { cpuPct?: number }) => p.cpuPct)).toEqual([
        7,
        undefined,
        undefined,
      ]);
    });
  });

  it('a throwing getAppMetrics drops only that tick: reported, the stage stays armed and recovers', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    const seen = vi.fn();
    t.on('appMetrics', seen);
    const boom = new Error('metrics');
    raw.getAppMetrics.mockImplementationOnce(() => {
      throw boom;
    });
    sch.tick();
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(seen).not.toHaveBeenCalled();
    sch.tick();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('a PERSISTENT getAppMetrics failure is reported once per failure streak, not once per tick', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    const seen = vi.fn();
    t.on('appMetrics', seen);
    const boom = new Error('persistent');
    raw.getAppMetrics.mockImplementation(() => {
      throw boom;
    });
    for (let i = 0; i < 5; i++) sch.tick();
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    // a successful read ends the streak: the NEXT failure is reported again, once
    raw.getAppMetrics.mockReturnValue([proc()]);
    sch.tick();
    expect(seen).toHaveBeenCalledTimes(1);
    const boom2 = new Error('again');
    raw.getAppMetrics.mockImplementation(() => {
      throw boom2;
    });
    sch.tick();
    sch.tick();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(boom2);
  });

  it('a failure streak ends on re-arm, so a new run reports its first failure again', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    const off = t.on('appMetrics', vi.fn());
    const fail = () =>
      raw.getAppMetrics.mockImplementation(() => {
        throw new Error('x');
      });
    fail();
    sch.tick();
    sch.tick();
    expect(onError).toHaveBeenCalledTimes(1);
    off();
    raw.getAppMetrics.mockReturnValue([proc()]); // priming succeeds
    t.on('appMetrics', vi.fn());
    fail();
    sch.tick();
    sch.tick();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('reset() ends a failure streak too', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    t.on('appMetrics', vi.fn());
    raw.getAppMetrics.mockImplementation(() => {
      throw new Error('x');
    });
    sch.tick();
    t.reset();
    raw.getAppMetrics.mockReturnValueOnce([proc()]); // priming of the next run
    t.on('appMetrics', vi.fn());
    sch.tick();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a throwing PRIMING read is reported and leaves the stage unarmed (no timer), retried on the next listener change', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    const boom = new Error('prime');
    raw.getAppMetrics.mockImplementationOnce(() => {
      throw boom;
    });
    t.on('appMetrics', vi.fn());
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(sch.setInterval).not.toHaveBeenCalled();
    t.on('appMetrics', vi.fn()); // another listener: retried
    expect(sch.setInterval).toHaveBeenCalledTimes(1);
  });

  it('a scheduler that cannot arm is reported and leaves the stage unarmed; later ticks of nothing never emit', () => {
    const { app } = fakeApp();
    const boom = new Error('no timer');
    const sch = fakeScheduler();
    sch.setInterval.mockImplementationOnce(() => {
      throw boom;
    });
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    t.on('appMetrics', vi.fn());
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(t.current('appMetrics')).toBeUndefined();
    t.on('appMetrics', vi.fn()); // retried, now arms
    expect(sch.armed).toBe(true);
  });

  it.each([
    ['no app', undefined],
    ['an app without getAppMetrics', {}],
  ])('%s: the stage is absent, no timer, no error', (_n, app) => {
    const sch = fakeScheduler();
    const onError = vi.fn();
    const t = new ElectronProcessTracker(
      { ...(app !== undefined ? { app } : {}), scheduler: sch },
      onError,
    );
    created.push(t);
    t.on('appMetrics', vi.fn());
    expect(sch.setInterval).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('the last unsubscribe clears the timer and drops the sample; a new subscription re-primes (fresh window)', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    const off = t.on('appMetrics', vi.fn());
    sch.tick();
    expect(t.current('appMetrics')).toBeDefined();
    off();
    expect(sch.clearInterval).toHaveBeenCalledTimes(1);
    expect(sch.armed).toBe(false);
    expect(t.current('appMetrics')).toBeUndefined();
    const reads = raw.getAppMetrics.mock.calls.length;
    const seen = vi.fn();
    t.on('appMetrics', seen);
    expect(raw.getAppMetrics.mock.calls.length).toBe(reads + 1); // priming read again
    expect(seen).not.toHaveBeenCalled();
    expect(t.current('appMetrics')).toBeUndefined();
  });

  it('a second listener shares the one timer and one priming read; removing one keeps it armed', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    const off1 = t.on('appMetrics', vi.fn());
    t.on('appMetrics', vi.fn());
    expect(sch.setInterval).toHaveBeenCalledTimes(1);
    expect(raw.getAppMetrics).toHaveBeenCalledTimes(1);
    off1();
    expect(sch.clearInterval).not.toHaveBeenCalled();
  });

  it('an onAny listener arms the stage too', () => {
    const { app } = fakeApp();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    const off = t.onAny(vi.fn());
    expect(sch.armed).toBe(true);
    off();
    expect(sch.armed).toBe(false);
  });

  it('current() is the last emitted sample, as a COPY; emitted payloads are copies too', () => {
    const { app } = fakeApp();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    let payload: { processes: { cpuPct?: number }[] } | undefined;
    t.on('appMetrics', (p) => {
      payload = p;
      (p.processes[0] as { cpuPct?: number }).cpuPct = 99;
    });
    sch.tick();
    expect(payload).toBeDefined();
    const cur = t.current('appMetrics');
    expect(cur?.processes[0]?.cpuPct).toBe(12.5);
    (cur?.processes[0] as { cpuPct?: number }).cpuPct = 1;
    expect(t.current('appMetrics')?.processes[0]?.cpuPct).toBe(12.5);
  });

  it('a callback of a torn-down run can never emit (even when its clear failed)', () => {
    const { app } = fakeApp();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    const seen = vi.fn();
    const off = t.on('appMetrics', seen);
    const stale = sch.callback() as () => void;
    sch.clearInterval.mockImplementationOnce(() => {
      throw new Error('clear failed');
    });
    const onError = vi.fn();
    t.rebind({}, onError);
    off();
    expect(onError).toHaveBeenCalledTimes(1);
    stale();
    expect(seen).not.toHaveBeenCalled();
  });

  it('a callback of a replaced run cannot emit even while a listener is still attached', () => {
    const { app } = fakeApp();
    const a = fakeScheduler();
    const b = fakeScheduler();
    const t = make(app, { scheduler: a });
    const seen = vi.fn();
    t.on('appMetrics', seen);
    const stale = a.callback() as () => void;
    t.rebind({ scheduler: b });
    stale();
    expect(seen).not.toHaveBeenCalled();
    b.tick();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('a callback registered by a setInterval that then threw can never emit', () => {
    const { app } = fakeApp();
    const sch = fakeScheduler();
    let registered: (() => void) | undefined;
    sch.setInterval.mockImplementationOnce((cb: () => void) => {
      registered = cb;
      throw new Error('late failure');
    });
    const t = make(app, { scheduler: sch }, () => {});
    const seen = vi.fn();
    t.on('appMetrics', seen);
    registered?.();
    expect(seen).not.toHaveBeenCalled();
  });

  it('a throwing clearInterval is reported (and does not strand teardown)', () => {
    const { app } = fakeApp();
    const sch = fakeScheduler();
    sch.clearInterval.mockImplementation(() => {
      throw new Error('clear');
    });
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    const off = t.on('appMetrics', vi.fn());
    off();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(t.current('appMetrics')).toBeUndefined();
  });

  it("uses the real (unref'd) timers by default, and stops them", () => {
    vi.useFakeTimers();
    try {
      const { app, raw } = fakeApp();
      const t = make(app);
      const seen = vi.fn();
      const off = t.on('appMetrics', seen);
      vi.advanceTimersByTime(2100);
      expect(seen).toHaveBeenCalledTimes(2);
      off();
      vi.advanceTimersByTime(5000);
      expect(seen).toHaveBeenCalledTimes(2);
      expect(raw.getAppMetrics).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing or async-rejecting reporter never escapes into the host', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      for (const sink of [
        () => {
          throw new Error('sink');
        },
        async () => {
          throw new Error('async sink');
        },
      ]) {
        const { app, raw } = fakeApp();
        raw.getAppMetrics.mockImplementation(() => {
          throw new Error('x');
        });
        const t = make(app, { scheduler: fakeScheduler() }, sink);
        expect(() => t.on('appMetrics', vi.fn())).not.toThrow();
      }
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a throwing subscriber cannot break the tick or another subscriber (reported)', () => {
    const { app } = fakeApp();
    const sch = fakeScheduler();
    const onError = vi.fn();
    const t = make(app, { scheduler: sch }, onError);
    const second = vi.fn();
    t.on('appMetrics', () => {
      throw new Error('listener');
    });
    t.on('appMetrics', second);
    sch.tick();
    expect(second).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('childProcessGone stage', () => {
  it('attaches NO app listener until subscribed, and removes the SAME listener when the last leaves', () => {
    const { app, raw, listeners } = fakeApp();
    const t = make(app);
    expect(raw.on).not.toHaveBeenCalled();
    const off1 = t.on('childProcessGone', vi.fn());
    const off2 = t.on('childProcessGone', vi.fn());
    expect(raw.on).toHaveBeenCalledExactlyOnceWith('child-process-gone', expect.any(Function));
    expect(listeners).toHaveLength(1);
    off1();
    expect(listeners).toHaveLength(1);
    off2();
    expect(listeners).toHaveLength(0);
    expect(raw.removeListener).toHaveBeenCalledExactlyOnceWith(
      'child-process-gone',
      raw.on.mock.calls[0]?.[1],
    );
  });

  it('maps details: type, reason, exitCode and a trimmed name; omits what is absent', () => {
    const { app, listeners } = fakeApp();
    const t = make(app);
    const seen = vi.fn();
    t.on('childProcessGone', seen);
    const fire = (details: unknown) => listeners[0]?.({}, details);
    fire({
      type: 'GPU',
      reason: 'crashed',
      exitCode: 139,
      name: ' Network Service ',
      serviceName: 'x',
    });
    fire({ type: 'Utility', reason: 'oom' });
    fire({ type: 'Utility', reason: 'killed', exitCode: Number.NaN, name: '  ' });
    fire({ type: 'Utility', reason: 'killed', exitCode: '1', name: 5 });
    expect(seen.mock.calls.map((c) => c[0])).toEqual([
      { type: 'GPU', reason: 'crashed', exitCode: 139, name: 'Network Service' },
      { type: 'Utility', reason: 'oom' },
      { type: 'Utility', reason: 'killed' },
      { type: 'Utility', reason: 'killed' },
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'gone'],
    ['no type', { reason: 'crashed' }],
    ['an empty type', { type: '', reason: 'crashed' }],
    ['no reason', { type: 'GPU' }],
    ['an empty reason', { type: 'GPU', reason: '' }],
    ['non-string type/reason', { type: 1, reason: 2 }],
  ])('ignores malformed details: %s', (_n, details) => {
    const { app, listeners } = fakeApp();
    const t = make(app);
    const seen = vi.fn();
    t.on('childProcessGone', seen);
    listeners[0]?.({}, details);
    expect(seen).not.toHaveBeenCalled();
  });

  it('falls back to app.off when there is no removeListener', () => {
    const off = vi.fn();
    const { app, raw } = fakeApp({ removeListener: undefined, off });
    const t = make(app);
    t.on('childProcessGone', vi.fn())();
    expect(off).toHaveBeenCalledExactlyOnceWith('child-process-gone', raw.on.mock.calls[0]?.[1]);
  });

  it('does not attach at all when the listener could never be removed (or there is no on)', () => {
    const noRemove = fakeApp({ removeListener: undefined });
    make(noRemove.app).on('childProcessGone', vi.fn());
    expect(noRemove.raw.on).not.toHaveBeenCalled();
    const noOn = fakeApp({ on: undefined });
    const onError = vi.fn();
    make(noOn.app, {}, onError).on('childProcessGone', vi.fn());
    expect(onError).not.toHaveBeenCalled();
    const t = new ElectronProcessTracker({}, onError);
    created.push(t);
    t.on('childProcessGone', vi.fn()); // no app
    expect(onError).not.toHaveBeenCalled();
  });

  it('a throwing app.on is reported and retried on the next listener change', () => {
    const { app, raw, listeners } = fakeApp();
    const boom = new Error('on');
    raw.on.mockImplementationOnce(() => {
      throw boom;
    });
    const onError = vi.fn();
    const t = make(app, {}, onError);
    t.on('childProcessGone', vi.fn());
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(listeners).toHaveLength(0);
    t.on('childProcessGone', vi.fn());
    expect(listeners).toHaveLength(1);
  });

  it('a throwing removeListener is reported (and the tracker still considers itself detached)', () => {
    const { app, raw } = fakeApp();
    raw.removeListener.mockImplementation(() => {
      throw new Error('remove');
    });
    const onError = vi.fn();
    const t = make(app, {}, onError);
    const off = t.on('childProcessGone', vi.fn());
    off();
    expect(onError).toHaveBeenCalledTimes(1);
    t.on('childProcessGone', vi.fn());
    expect(raw.on).toHaveBeenCalledTimes(2); // re-attaches: it did not think it was still attached
  });
});

describe('gpu one-shot', () => {
  const info = { gpuDevice: [{ active: true, vendorString: 'V', deviceString: 'R' }] };
  const withGpu = (getGPUInfo: (type: 'basic' | 'complete') => Promise<unknown>) =>
    make({ getGPUInfo }, {});

  it('is undefined until the Promise settles, then serves the mapped gpu and fires the gpu stage once', async () => {
    const d = deferred<unknown>();
    const getGPUInfo = vi.fn(() => d.promise);
    const t = withGpu(getGPUInfo);
    const seen = vi.fn();
    t.on('gpu', seen);
    t.requestGpuInfo();
    expect(getGPUInfo).toHaveBeenCalledExactlyOnceWith('basic');
    expect(t.current('gpu')).toBeUndefined();
    d.resolve(info);
    await flush();
    expect(t.current('gpu')).toEqual({ vendor: 'V', renderer: 'R' });
    expect(seen).toHaveBeenCalledExactlyOnceWith({ vendor: 'V', renderer: 'R' });
  });

  it("passes the requested type to getGPUInfo (default 'basic')", () => {
    const complete = vi.fn(() => new Promise<unknown>(() => {}));
    withGpu(complete).requestGpuInfo('complete');
    expect(complete).toHaveBeenCalledExactlyOnceWith('complete');
  });

  it('keeps a USABLE settled value of the same type: repeat requests are no-ops while pending and after a value', async () => {
    const pending = vi.fn(() => new Promise<unknown>(() => {}));
    const a = withGpu(pending);
    a.requestGpuInfo();
    a.requestGpuInfo();
    expect(pending).toHaveBeenCalledTimes(1);

    const ok = vi.fn(async () => info);
    const b = withGpu(ok);
    b.requestGpuInfo();
    await flush();
    b.requestGpuInfo();
    b.requestGpuInfo('basic');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('re-asks after a REJECTION, and after an UNUSABLE result (nothing worth keeping was settled)', async () => {
    const bad = vi.fn(() => Promise.reject(new Error('x')));
    const c = make({ getGPUInfo: bad }, {}, () => {});
    c.requestGpuInfo();
    await flush();
    c.requestGpuInfo();
    expect(bad).toHaveBeenCalledTimes(2);

    const empty = vi.fn(async () => ({ gpuDevice: [{ active: true, vendorId: 1 }] }));
    const d = withGpu(empty);
    d.requestGpuInfo();
    await flush();
    d.requestGpuInfo();
    expect(empty).toHaveBeenCalledTimes(2);
  });

  it('re-asks when the requested type differs from the one read; the old value stays until a new usable one replaces it', async () => {
    const calls: string[] = [];
    let answer: unknown = { gpuDevice: [{ active: true, vendorString: 'BASIC' }] };
    const t = withGpu(async (type) => {
      calls.push(type);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    t.requestGpuInfo('basic');
    await flush();
    answer = new Error('complete failed');
    t.requestGpuInfo('complete');
    await flush();
    expect(calls).toEqual(['basic', 'complete']);
    expect(t.current('gpu')).toEqual({ vendor: 'BASIC' }); // a failed re-ask keeps the usable value
    t.requestGpuInfo('complete'); // the failed 'complete' read is not a settled usable one
    await flush();
    expect(calls).toEqual(['basic', 'complete', 'complete']);
    answer = { gpuDevice: [{ active: true, vendorString: 'COMPLETE' }] };
    t.requestGpuInfo('complete');
    await flush();
    expect(t.current('gpu')).toEqual({ vendor: 'COMPLETE' });
    t.requestGpuInfo('complete');
    expect(calls).toEqual(['basic', 'complete', 'complete', 'complete']);
  });

  it('returns a copy, so a consumer cannot mutate the result', async () => {
    const t = withGpu(async () => info);
    t.requestGpuInfo();
    await flush();
    (t.current('gpu') as { vendor?: string }).vendor = 'hacked';
    expect(t.current('gpu')).toEqual({ vendor: 'V', renderer: 'R' });
  });

  it('a rejection becomes omit + onError, with NO unhandledRejection and no gpu event', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const boom = new Error('no acceleration');
      const onError = vi.fn();
      const t = make({ getGPUInfo: () => Promise.reject(boom) }, {}, onError);
      const seen = vi.fn();
      t.on('gpu', seen);
      t.requestGpuInfo();
      await flush();
      await flush();
      expect(t.current('gpu')).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
      expect(seen).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('an async onError that rejects leaves NO unhandledRejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      make({ getGPUInfo: () => Promise.reject(new Error('x')) }, {}, async () => {
        throw new Error('async sink');
      }).requestGpuInfo();
      await flush();
      await flush();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a synchronous throw is reported, not propagated, and does not block a later request', () => {
    const boom = new Error('sync');
    const onError = vi.fn();
    const getGPUInfo = vi.fn(() => {
      throw boom;
    });
    const t = make({ getGPUInfo }, {}, onError);
    expect(() => t.requestGpuInfo()).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(t.current('gpu')).toBeUndefined();
    t.cancelGpuInfo(); // nothing in flight: a no-op
    t.requestGpuInfo();
    expect(getGPUInfo).toHaveBeenCalledTimes(2);
  });

  it('a hostile result whose mapping throws is reported and omitted', async () => {
    const hostile = {
      get gpuDevice(): unknown {
        throw new Error('getter');
      },
    };
    const onError = vi.fn();
    const t = make({ getGPUInfo: async () => hostile }, {}, onError);
    t.requestGpuInfo();
    await flush();
    expect(t.current('gpu')).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('an unusable result (nothing mappable) is omitted silently', async () => {
    const onError = vi.fn();
    const t = make(
      { getGPUInfo: async () => ({ gpuDevice: [{ active: true, vendorId: 1 }] }) },
      {},
      onError,
    );
    const seen = vi.fn();
    t.on('gpu', seen);
    t.requestGpuInfo();
    await flush();
    expect(t.current('gpu')).toBeUndefined();
    expect(seen).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('cancel: a late resolve is ignored, a late reject is not reported, and a later request starts afresh', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const getGPUInfo = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onError = vi.fn();
    const t = make({ getGPUInfo }, {}, onError);
    t.requestGpuInfo();
    t.cancelGpuInfo();
    first.resolve({ gpuDevice: [{ active: true, vendorString: 'OLD' }] });
    await flush();
    expect(t.current('gpu')).toBeUndefined();
    t.requestGpuInfo();
    expect(getGPUInfo).toHaveBeenCalledTimes(2);
    second.resolve({ gpuDevice: [{ active: true, vendorString: 'NEW' }] });
    await flush();
    expect(t.current('gpu')).toEqual({ vendor: 'NEW' });

    const d = deferred<unknown>();
    const t2 = make({ getGPUInfo: () => d.promise }, {}, onError);
    t2.requestGpuInfo();
    t2.cancelGpuInfo();
    d.reject(new Error('late'));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it('cancel KEEPS an already-resolved value (reports still draining must carry it)', async () => {
    const t = withGpu(async () => info);
    t.requestGpuInfo();
    await flush();
    t.cancelGpuInfo();
    expect(t.current('gpu')).toEqual({ vendor: 'V', renderer: 'R' });
    t.requestGpuInfo(); // same type, usable value kept: not re-asked
    expect(t.current('gpu')).toEqual({ vendor: 'V', renderer: 'R' });
  });

  it.each([
    ['no app', {}],
    ['an app without getGPUInfo', { app: {} }],
    ['a non-function getGPUInfo', { app: { getGPUInfo: 5 } }],
  ])('%s: nothing requested, no error, and a later app can still be asked', (_n, env) => {
    const onError = vi.fn();
    const t = new ElectronProcessTracker(env as never, onError);
    created.push(t);
    expect(() => t.requestGpuInfo()).not.toThrow();
    expect(t.current('gpu')).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    const getGPUInfo = vi.fn(() => new Promise<unknown>(() => {}));
    t.rebind({ app: { getGPUInfo } });
    t.requestGpuInfo();
    expect(getGPUInfo).toHaveBeenCalledTimes(1);
  });
});

describe('reset', () => {
  it('releases the timer, the app listener and the GPU result', async () => {
    const { app, listeners } = fakeApp({
      getGPUInfo: async () => ({ gpuDevice: [{ active: true, vendorString: 'V' }] }),
    });
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch });
    t.on('appMetrics', vi.fn());
    t.on('childProcessGone', vi.fn());
    t.requestGpuInfo();
    await flush();
    expect(t.current('gpu')).toBeDefined();
    t.reset();
    expect(sch.armed).toBe(false);
    expect(listeners).toHaveLength(0);
    expect(t.current('gpu')).toBeUndefined();
    t.requestGpuInfo(); // the latch is reopened
    await flush();
    expect(t.current('gpu')).toBeDefined();
  });

  it('a read in flight at reset can no longer write', async () => {
    const d = deferred<unknown>();
    const t = withGpuOnly(d.promise);
    t.requestGpuInfo();
    t.reset();
    d.resolve({ gpuDevice: [{ active: true, vendorString: 'V' }] });
    await flush();
    expect(t.current('gpu')).toBeUndefined();
  });
});

const withGpuOnly = (promise: Promise<unknown>) => make({ getGPUInfo: () => promise }, {});

describe('rebind (seams merge, never drop)', () => {
  it('a changed scheduler tears the armed run down on the OLD scheduler, then re-arms (and re-primes) on the new one', () => {
    const { app, raw } = fakeApp();
    const a = fakeScheduler();
    const b = fakeScheduler();
    const t = make(app, { scheduler: a });
    const seen = vi.fn();
    t.on('appMetrics', seen);
    a.tick();
    expect(seen).toHaveBeenCalledTimes(1);
    const reads = raw.getAppMetrics.mock.calls.length;
    t.rebind({ scheduler: b });
    expect(a.clearInterval).toHaveBeenCalledTimes(1);
    expect(b.setInterval).toHaveBeenCalledTimes(1);
    expect(raw.getAppMetrics.mock.calls.length).toBe(reads + 1);
    expect(t.current('appMetrics')).toBeUndefined();
    b.tick();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('an unchanged rebind restarts nothing; an omitted seam never clobbers an earlier one', () => {
    const { app, raw } = fakeApp();
    const sch = fakeScheduler();
    const t = make(app, { scheduler: sch, intervalMs: 500 });
    t.on('appMetrics', vi.fn());
    t.rebind({ scheduler: sch, intervalMs: 500 });
    t.rebind({});
    expect(sch.setInterval).toHaveBeenCalledTimes(1);
    expect(sch.clearInterval).not.toHaveBeenCalled();
    expect(raw.getAppMetrics).toHaveBeenCalledTimes(1);
    // the kept intervalMs survives a rebind that changes only the scheduler
    const other = fakeScheduler();
    t.rebind({ scheduler: other });
    expect(other.setInterval).toHaveBeenCalledWith(expect.any(Function), 500);
  });

  it('a changed app moves the child-process-gone listener (removed from the OLD app, attached to the new one)', () => {
    const one = fakeApp();
    const two = fakeApp();
    const t = make(one.app);
    t.on('childProcessGone', vi.fn());
    t.rebind({ app: two.app });
    expect(one.listeners).toHaveLength(0);
    expect(one.raw.removeListener).toHaveBeenCalledTimes(1);
    expect(two.listeners).toHaveLength(1);
  });

  it('the latest defined onError wins; undefined keeps it', () => {
    const { app, raw } = fakeApp();
    const first = vi.fn();
    const second = vi.fn();
    const t = make(app, { scheduler: fakeScheduler() }, first);
    t.rebind({}, second);
    t.rebind({});
    raw.getAppMetrics.mockImplementationOnce(() => {
      throw new Error('x');
    });
    t.on('appMetrics', vi.fn());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('electronProcessTrackerFor (registry)', () => {
  it('is a singleton per app object, hands later launches their seams, and reset drops it', () => {
    const { app } = fakeApp();
    const a = fakeScheduler();
    const b = fakeScheduler();
    const first = electronProcessTrackerFor({ app, scheduler: a });
    try {
      expect(electronProcessTrackerFor({ app, scheduler: a })).toBe(first);
      first.on('appMetrics', vi.fn());
      expect(a.armed).toBe(true);
      expect(electronProcessTrackerFor({ app, scheduler: b })).toBe(first);
      expect(a.armed).toBe(false);
      expect(b.armed).toBe(true);
      const other = fakeApp();
      const otherTracker = electronProcessTrackerFor({ app: other.app });
      expect(otherTracker).not.toBe(first);
      resetElectronProcessTracker(other.app);
    } finally {
      resetElectronProcessTracker(app);
    }
    expect(b.armed).toBe(false);
    expect(electronProcessTrackerFor({ app })).not.toBe(first);
    resetElectronProcessTracker(app);
  });

  it('an explicit key overrides the app as the registry key, and onError reaches the shared tracker', () => {
    const { app, raw } = fakeApp();
    raw.getAppMetrics.mockImplementation(() => {
      throw new Error('x');
    });
    const key = {};
    const onError = vi.fn();
    const t = electronProcessTrackerFor({ app, key, scheduler: fakeScheduler() }, onError);
    try {
      expect(electronProcessTrackerFor({ app }, undefined)).not.toBe(t);
      expect(electronProcessTrackerFor({ app, key })).toBe(t);
      t.on('appMetrics', vi.fn());
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      resetElectronProcessTracker(key);
      resetElectronProcessTracker(app);
    }
  });

  it('refuses to build an anonymous tracker (no app, no key)', () => {
    expect(() => electronProcessTrackerFor({})).toThrow(TypeError);
  });
});
