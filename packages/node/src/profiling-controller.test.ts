import type { Scheduler } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import type { CpuProfile, CpuProfiler } from './cpu-profiler';
import { createProfilingController } from './profiling-controller';

// Drain microtasks (the serialization chain settles across several `.then` hops + promise adoption).
const flush = () => new Promise((r) => setTimeout(r, 0));

const aProfile = (over: Partial<CpuProfile> = {}): CpuProfile => ({
  nodes: [{ id: 1 }],
  startTime: 0,
  endTime: 1,
  samples: [1],
  timeDeltas: [0],
  ...over,
});

// A fake profiler that records calls and (optionally) defers collect() resolution so serialization is
// observable.
function fakeProfiler(opts: { profile?: CpuProfile | undefined; defer?: boolean } = {}) {
  const calls = { start: 0, stop: 0, collect: 0 };
  let running = false;
  const pending: Array<(p: CpuProfile | undefined) => void> = [];
  const profile = 'profile' in opts ? opts.profile : aProfile();
  const profiler: CpuProfiler = {
    get running() {
      return running;
    },
    async start() {
      calls.start += 1;
      running = true;
    },
    async collect() {
      calls.collect += 1;
      if (opts.defer) {
        return new Promise<CpuProfile | undefined>((resolve) => pending.push(resolve));
      }
      return profile;
    },
    async stop() {
      calls.stop += 1;
      running = false;
      return profile;
    },
  };
  return { profiler, calls, profile, resolveNext: (p?: CpuProfile) => pending.shift()?.(p) };
}

function fakeScheduler() {
  let cb: (() => void) | undefined;
  let ms: number | undefined;
  let cleared = false;
  const handle = 'h';
  const scheduler: Scheduler = {
    setInterval: (fn, interval) => {
      cb = fn as () => void;
      ms = interval;
      return handle;
    },
    clearInterval: (h) => {
      if (h === handle) {
        cleared = true;
      }
    },
  };
  return { scheduler, fire: () => cb?.(), intervalMs: () => ms, cleared: () => cleared };
}

describe('createProfilingController', () => {
  it('start() starts the profiler and schedules the rolling-restart timer at the window interval', () => {
    const p = fakeProfiler();
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
    });
    c.start();
    expect(p.calls.start).toBe(1);
    expect(s.intervalMs()).toBe(60_000);
  });

  it('snapshot(now) collects the current segment and returns it as a `profile` entry stamped at now', async () => {
    const p = fakeProfiler();
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
    });
    c.start();
    const entries = await c.snapshot(1700);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('profile');
    expect(entries[0]?.timestamp).toBe(1700);
    expect(entries[0]?.data).toEqual(p.profile);
    expect(p.calls.collect).toBe(1);
  });

  it('snapshot returns NO entry when there is no profile (collect undefined)', async () => {
    const p = fakeProfiler({ profile: undefined });
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
    });
    c.start();
    expect(await c.snapshot(1700)).toEqual([]);
  });

  it('the rolling timer collects (and discards) to bound the segment', async () => {
    const p = fakeProfiler();
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
    });
    c.start();
    s.fire();
    await flush();
    expect(p.calls.collect).toBe(1); // the rolling tick collected
  });

  it('SERIALIZES overlapping collects (a report during a rolling tick never double-stops the session)', async () => {
    let clockMs = 0;
    const p = fakeProfiler({ defer: true });
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
      now: () => (clockMs += 4000), // every read is past the hold TTL: the tick's segment is not reusable
    });
    c.start();
    s.fire(); // rolling collect #1 — pending (deferred)
    const snap = c.snapshot(1700); // queued behind #1
    await flush();
    expect(p.calls.collect).toBe(1); // the 2nd collect has NOT started yet (serialized)
    p.resolveNext(aProfile()); // resolve #1
    await flush();
    expect(p.calls.collect).toBe(2); // now the snapshot's collect runs
    p.resolveNext(aProfile({ endTime: 99 }));
    expect((await snap)[0]?.data).toEqual(aProfile({ endTime: 99 }));
  });

  it('stop() clears the rolling timer and stops the profiler', () => {
    const p = fakeProfiler();
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
    });
    c.start();
    c.stop();
    expect(s.cleared()).toBe(true);
    expect(p.calls.stop).toBe(1);
  });

  it('stop() before start() is a safe no-op (no timer to clear)', () => {
    const p = fakeProfiler();
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
    });
    expect(() => c.stop()).not.toThrow();
    expect(s.cleared()).toBe(false);
    expect(p.calls.stop).toBe(1); // profiler.stop() is still called (idempotent no-op when not running)
  });

  describe('hold() — the hang-report segment', () => {
    const mk = (nowRef: { t: number }) => {
      const p = fakeProfiler();
      const s = fakeScheduler();
      const c = createProfilingController({
        profiler: p.profiler,
        scheduler: s.scheduler,
        rollingIntervalMs: 60_000,
        now: () => nowRef.t,
      });
      c.start();
      return { p, s, c };
    };

    it('collects the segment and returns the profile', async () => {
      const { p, c } = mk({ t: 0 });
      expect(await c.hold()).toEqual(p.profile);
      expect(p.calls.collect).toBe(1);
    });

    it('returns undefined when there is no profile, and holds nothing', async () => {
      const p = fakeProfiler({ profile: undefined });
      const s = fakeScheduler();
      const c = createProfilingController({
        profiler: p.profiler,
        scheduler: s.scheduler,
        rollingIntervalMs: 60_000,
      });
      c.start();
      expect(await c.hold()).toBeUndefined();
      await c.hold();
      expect(p.calls.collect).toBe(2); // nothing was retained, so the second call collects again
    });

    it('a second hold() within the TTL reuses the held segment instead of collecting an empty one', async () => {
      const now = { t: 0 };
      const { p, c } = mk(now);
      await c.hold();
      now.t = 2999;
      expect(await c.hold()).toEqual(p.profile);
      expect(p.calls.collect).toBe(1);
    });

    it('collects afresh once the TTL has passed', async () => {
      const now = { t: 0 };
      const { p, c } = mk(now);
      await c.hold();
      now.t = 3000;
      await c.hold();
      expect(p.calls.collect).toBe(2);
    });

    it('snapshot() within the TTL returns the held segment (the hang report keeps its profile.json)', async () => {
      const now = { t: 0 };
      const { p, c } = mk(now);
      await c.hold();
      now.t = 10;
      const entries = await c.snapshot(1700);
      expect(entries[0]?.data).toEqual(p.profile);
      expect(entries[0]?.timestamp).toBe(1700);
      expect(p.calls.collect).toBe(1);
    });

    it('snapshot() alone never retains (a later snapshot collects a fresh segment)', async () => {
      const { p, c } = mk({ t: 0 });
      await c.snapshot(1);
      await c.snapshot(2);
      expect(p.calls.collect).toBe(2);
    });

    it('the rolling tick replaces the held segment, and retains its own for a hang report that follows it', async () => {
      const now = { t: 0 };
      const { p, s, c } = mk(now);
      await c.hold();
      s.fire(); // an overdue tick that ran just before the hang message
      await flush();
      expect(p.calls.collect).toBe(2); // the tick collected afresh rather than reusing the old hold
      await c.hold();
      expect(p.calls.collect).toBe(2); // ...and the hang's hold() reuses the tick's segment
      now.t = 3000;
      await c.hold();
      expect(p.calls.collect).toBe(3); // never retained beyond the TTL
    });

    it('serializes with snapshot(): a snapshot queued behind a hold reuses its segment', async () => {
      const p = fakeProfiler({ defer: true });
      const s = fakeScheduler();
      const c = createProfilingController({
        profiler: p.profiler,
        scheduler: s.scheduler,
        rollingIntervalMs: 60_000,
        now: () => 0,
      });
      c.start();
      const held = c.hold();
      const snap = c.snapshot(5);
      await flush();
      p.resolveNext(aProfile({ endTime: 7 }));
      expect(await held).toEqual(aProfile({ endTime: 7 }));
      expect((await snap)[0]?.data).toEqual(aProfile({ endTime: 7 }));
      expect(p.calls.collect).toBe(1);
    });

    it('stop() drops the held segment', async () => {
      const { p, c } = mk({ t: 0 });
      await c.hold();
      c.stop();
      await c.hold();
      expect(p.calls.collect).toBe(2);
    });
  });
});
