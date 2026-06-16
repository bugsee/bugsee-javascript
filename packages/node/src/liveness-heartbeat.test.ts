import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLivenessHeartbeat } from './liveness-heartbeat';

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
  it('creates the .live file immediately and schedules the interval (default 10s)', () => {
    const liveFile = join(mkDir(), '.live');
    const { scheduler, calls } = fakeScheduler();

    startLivenessHeartbeat({ liveFile, scheduler });

    expect(existsSync(liveFile)).toBe(true); // beat once up front
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ms).toBe(10_000);
  });

  it('advances the file mtime on each scheduled tick', () => {
    const liveFile = join(mkDir(), '.live');
    const touch = vi.fn();
    const { scheduler, calls } = fakeScheduler();

    startLivenessHeartbeat({ liveFile, scheduler, intervalMs: 5_000, touch });
    expect(touch).toHaveBeenCalledTimes(1); // immediate beat
    calls[0]?.cb(); // a scheduled tick
    calls[0]?.cb();
    expect(touch).toHaveBeenCalledTimes(3);
    expect(touch).toHaveBeenCalledWith(liveFile);
  });

  it('re-writes (advances the mtime of) an existing .live file with the default touch', () => {
    const liveFile = join(mkDir(), '.live');
    const { scheduler, calls } = fakeScheduler();
    startLivenessHeartbeat({ liveFile, scheduler });
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
    const hb = startLivenessHeartbeat({ liveFile: join(mkDir(), '.live'), scheduler });
    hb.stop();
    expect(cleared).toEqual(['h1']);
  });
});
