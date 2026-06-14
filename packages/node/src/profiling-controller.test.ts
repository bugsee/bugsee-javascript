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
    const p = fakeProfiler({ defer: true });
    const s = fakeScheduler();
    const c = createProfilingController({
      profiler: p.profiler,
      scheduler: s.scheduler,
      rollingIntervalMs: 60_000,
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
});
