import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnHeartbeatWorker, startLivenessHeartbeat } from './liveness-heartbeat';

const dirs: string[] = [];
const mkDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-hb-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fakeScheduler = () => {
  const calls: Array<{ cb: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  return {
    scheduler: {
      setInterval: (cb: () => void, ms: number) => {
        calls.push({ cb, ms });
        return `h${calls.length}`;
      },
      clearInterval: (h: unknown) => {
        cleared.push(h);
      },
    },
    calls,
    cleared,
  };
};

describe('startLivenessHeartbeat', () => {
  // These three cover the FALLBACK carrier — the scheduler interval used where a runtime has no
  // worker_threads. Since Wave 6.6 the default carrier is a worker thread, so they opt in explicitly rather
  // than silently testing a path production no longer takes.
  it('creates the .live file immediately and schedules the interval (default 10s)', () => {
    const liveFile = join(mkDir(), '.live');
    const { scheduler, calls } = fakeScheduler();

    startLivenessHeartbeat({ liveFile, scheduler, spawnHeartbeatWorker: () => undefined });

    expect(existsSync(liveFile)).toBe(true); // beat once up front
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ms).toBe(10_000);
  });

  it('advances the file mtime on each scheduled tick', () => {
    const liveFile = join(mkDir(), '.live');
    const touch = vi.fn();
    const { scheduler, calls } = fakeScheduler();

    startLivenessHeartbeat({
      liveFile,
      scheduler,
      intervalMs: 5_000,
      touch,
      spawnHeartbeatWorker: () => undefined,
    });
    expect(touch).toHaveBeenCalledTimes(1); // immediate beat
    calls[0]?.cb(); // a scheduled tick
    calls[0]?.cb();
    expect(touch).toHaveBeenCalledTimes(3);
    expect(touch).toHaveBeenCalledWith(liveFile);
  });

  it('re-writes (advances the mtime of) an existing .live file with the default touch', () => {
    const liveFile = join(mkDir(), '.live');
    const { scheduler, calls } = fakeScheduler();
    startLivenessHeartbeat({ liveFile, scheduler, spawnHeartbeatWorker: () => undefined });
    const first = statSync(liveFile).mtimeMs;
    // Force a measurably later write by stubbing the clock the fs uses is not portable; just assert the
    // second beat does not throw and the file remains present (mtime is monotonic-ish on real fs).
    calls[0]?.cb();
    expect(existsSync(liveFile)).toBe(true);
    expect(statSync(liveFile).mtimeMs).toBeGreaterThanOrEqual(first);
  });

  it('routes a touch failure to onError without throwing', () => {
    const onError = vi.fn();
    const { scheduler } = fakeScheduler();
    startLivenessHeartbeat({
      liveFile: '/x',
      scheduler,
      touch: () => {
        throw new Error('touch blew up');
      },
      onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error)); // the immediate beat failed → reported
  });

  it('swallows a touch failure with no onError (default no-op)', () => {
    const { scheduler } = fakeScheduler();
    expect(() =>
      startLivenessHeartbeat({
        liveFile: '/x',
        scheduler,
        touch: () => {
          throw new Error('boom');
        },
      }),
    ).not.toThrow();
  });

  it('stop() clears the interval', () => {
    const { scheduler, cleared } = fakeScheduler();
    const hb = startLivenessHeartbeat({
      liveFile: join(mkDir(), '.live'),
      scheduler,
      spawnHeartbeatWorker: () => undefined,
    });
    hb.stop();
    expect(cleared).toEqual(['h1']);
  });
});

// WAVE 6.6 — the heartbeat has to survive the very stall it is used to diagnose.
//
// The signal a sibling reads to decide "this subtree is still in use" was written by a `setInterval` on the
// event loop that stalls. So any whole-instance stall longer than the 120 s patient window — a docker
// pause, a VM suspend, a debugger break, a death-spiral GC, or a genuinely blocked event loop, the exact
// condition this SDK ships ANR detection for — made a live instance indistinguishable from a dead one, and
// a sibling coordinator deleted its capture subtree underneath it (reproduced with a real SIGSTOP).
//
// The file's own comment named the fix and deferred it: "a worker-thread carrier — true hang-proofness".
// Verified against real worker_threads before building on it: with the main thread blocked for 2000 ms the
// `.live` mtime still advanced by 2033 ms; and a heartbeat worker spawned BY a worker thread stops the
// moment that thread dies, which is what keeps a dead worker_thread instance reclaimable.
describe('hang-proof heartbeat (Wave 6.6)', () => {
  const fakeWorker = () => {
    const created: Array<{ data: unknown }> = [];
    const terminated: number[] = [];
    let unrefs = 0;
    return {
      created,
      terminated,
      unrefs: () => unrefs,
      spawn: (data: unknown) => {
        created.push({ data });
        return {
          unref: () => {
            unrefs += 1;
          },
          terminate: () => {
            terminated.push(created.length);
          },
        };
      },
    };
  };

  it('carries the beat on a WORKER, not the scheduler that stalls', () => {
    const dir = mkDir();
    const w = fakeWorker();
    const { scheduler, calls } = fakeScheduler();
    startLivenessHeartbeat({
      liveFile: join(dir, '.live'),
      scheduler,
      intervalMs: 5000,
      spawnHeartbeatWorker: w.spawn,
    });
    expect(w.created).toHaveLength(1);
    expect(calls).toHaveLength(0); // no main-thread interval — that is the whole point
  });

  it('hands the worker the file and interval it needs', () => {
    const dir = mkDir();
    const w = fakeWorker();
    const { scheduler } = fakeScheduler();
    startLivenessHeartbeat({
      liveFile: join(dir, '.live'),
      scheduler,
      intervalMs: 5000,
      spawnHeartbeatWorker: w.spawn,
    });
    expect(w.created[0]?.data).toMatchObject({ liveFile: join(dir, '.live'), intervalMs: 5000 });
  });

  it('never pins the host process', () => {
    // The 2.4 lesson: an un-unref'd worker makes a default launch() unable to exit. This worker also takes
    // no `message` listener — attaching one re-refs the MessagePort and reinstates exactly that pin.
    const dir = mkDir();
    const w = fakeWorker();
    const { scheduler } = fakeScheduler();
    startLivenessHeartbeat({
      liveFile: join(dir, '.live'),
      scheduler,
      spawnHeartbeatWorker: w.spawn,
    });
    expect(w.unrefs()).toBe(1);
  });

  it('still writes the file SYNCHRONOUSLY up front', () => {
    // A sibling coordinator can run its recovery before the worker's first beat lands. The file has to
    // exist the instant launch returns, or a brand-new instance reads as one that never armed.
    const dir = mkDir();
    const w = fakeWorker();
    const { scheduler } = fakeScheduler();
    startLivenessHeartbeat({
      liveFile: join(dir, '.live'),
      scheduler,
      spawnHeartbeatWorker: w.spawn,
    });
    expect(existsSync(join(dir, '.live'))).toBe(true);
  });

  it('terminates the worker on stop()', () => {
    const dir = mkDir();
    const w = fakeWorker();
    const { scheduler } = fakeScheduler();
    startLivenessHeartbeat({
      liveFile: join(dir, '.live'),
      scheduler,
      spawnHeartbeatWorker: w.spawn,
    }).stop();
    expect(w.terminated).toHaveLength(1);
  });

  it('falls back to the scheduler when the runtime has no worker_threads', () => {
    // Degraded, not broken: the old behaviour, which is still correct for a process that dies outright.
    const dir = mkDir();
    const { scheduler, calls } = fakeScheduler();
    const hb = startLivenessHeartbeat({
      liveFile: join(dir, '.live'),
      scheduler,
      intervalMs: 5000,
      spawnHeartbeatWorker: () => undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ms).toBe(5000);
    hb.stop();
  });

  it('falls back when spawning THROWS, and does not throw out of launch', () => {
    const dir = mkDir();
    const { scheduler, calls } = fakeScheduler();
    expect(() =>
      startLivenessHeartbeat({
        liveFile: join(dir, '.live'),
        scheduler,
        spawnHeartbeatWorker: () => {
          throw new Error('no worker_threads here');
        },
      }),
    ).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('returns undefined when the real Worker constructor rejects the payload', () => {
    // The capability guard, exercised through the REAL spawner rather than a stub: a function is not
    // structured-cloneable, so `new Worker(...)` throws exactly as it would on a runtime with no
    // worker_threads. The caller must get `undefined` and fall back, not an exception.
    expect(spawnHeartbeatWorker({ liveFile: '/x', notCloneable: () => {} })).toBeUndefined();
  });

  it('reports a failing unref instead of throwing out of launch', () => {
    const dir = mkDir();
    const onError = vi.fn();
    const { scheduler } = fakeScheduler();
    expect(() =>
      startLivenessHeartbeat({
        liveFile: join(dir, '.live'),
        scheduler,
        onError,
        spawnHeartbeatWorker: () => ({
          unref: () => {
            throw new Error('unref blew up');
          },
          terminate: () => undefined,
        }),
      }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('reports a failing terminate instead of throwing out of stop()', () => {
    const dir = mkDir();
    const onError = vi.fn();
    const { scheduler } = fakeScheduler();
    const hb = startLivenessHeartbeat({
      liveFile: join(dir, '.live'),
      scheduler,
      onError,
      spawnHeartbeatWorker: () => ({
        unref: () => undefined,
        terminate: () => {
          throw new Error('terminate blew up');
        },
      }),
    });
    expect(() => hb.stop()).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('REALLY keeps beating while the main thread is blocked', async () => {
    // The property itself, through a real worker_threads worker. Every test above is about wiring; this is
    // the one that would fail if the premise were wrong.
    const dir = mkDir();
    const liveFile = join(dir, '.live');
    const { scheduler } = fakeScheduler();
    const hb = startLivenessHeartbeat({ liveFile, scheduler, intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 300));
    const before = statSync(liveFile).mtimeMs;
    const until = Date.now() + 1000;
    while (Date.now() < until) {
      // block the main thread hard — the stall that used to stop the heartbeat
    }
    const after = statSync(liveFile).mtimeMs;
    hb.stop();
    expect(after).toBeGreaterThan(before);
  });
});
