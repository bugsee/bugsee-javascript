import { afterEach, describe, expect, it, vi } from 'vitest';

// The DEFAULT session wiring — `createCpuProfiler()` with no `createSession` — asserted without a real V8
// profiler in this process (a real one corrupts vitest's own v8 coverage; see cpu-profiler.test.ts). The
// real-process run lives in cpu-profiler.test.ts, in a child process.

const calls = vi.hoisted((): string[] => []);

vi.mock('node:inspector', () => {
  class Session {
    connect(): void {
      calls.push('connect');
    }
    disconnect(): void {
      calls.push('disconnect');
    }
    post(method: string, a?: unknown, b?: unknown): void {
      calls.push(method);
      const cb = (typeof a === 'function' ? a : b) as (err: Error | null, result?: unknown) => void;
      cb(null, method === 'Profiler.stop' ? { profile: { nodes: [{ id: 1 }] } } : {});
    }
  }
  return { default: { Session } };
});

import { createCpuProfiler } from './cpu-profiler';

afterEach(() => {
  calls.length = 0;
});

describe('createCpuProfiler — default session', () => {
  it('drives the node:inspector Session when no createSession is injected', async () => {
    const profiler = createCpuProfiler();
    await profiler.start();
    expect(profiler.running).toBe(true);
    const profile = await profiler.stop();
    expect(profile).toStrictEqual({ nodes: [{ id: 1 }] });
    expect(calls).toStrictEqual([
      'connect',
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
      'Profiler.stop',
      'disconnect',
    ]);
  });
});
