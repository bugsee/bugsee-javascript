import { describe, expect, it } from 'vitest';
import {
  type CpuProfile,
  createCpuProfiler,
  newInspectorSession,
  type ProfilerSession,
} from './cpu-profiler';

// A fake inspector Session: records posts, returns a canned profile for Profiler.stop, and can deliver
// callbacks synchronously (Node-like) or async (Bun-like), or fail a given method.
function fakeSession(
  opts: {
    profile?: CpuProfile;
    async?: boolean;
    failOn?: string;
    throwOnDisconnect?: boolean;
  } = {},
) {
  const posts: Array<{ method: string; params?: object }> = [];
  const state = { connected: false, disconnected: false };
  const profile: CpuProfile = opts.profile ?? {
    nodes: [{ id: 1 }],
    startTime: 1,
    endTime: 2,
    samples: [1],
    timeDeltas: [0],
  };
  const session: ProfilerSession = {
    connect() {
      state.connected = true;
    },
    disconnect() {
      state.disconnected = true;
      if (opts.throwOnDisconnect) {
        throw new Error('already gone');
      }
    },
    post(method: string, p?: object | ((e: Error | null, r?: unknown) => void), cb?) {
      const callback = (typeof p === 'function' ? p : cb) as
        | ((e: Error | null, r?: unknown) => void)
        | undefined;
      posts.push({ method, params: typeof p === 'function' ? undefined : p });
      const result = method === 'Profiler.stop' ? { profile } : undefined;
      const deliver = () => callback?.(opts.failOn === method ? new Error('boom') : null, result);
      if (opts.async) {
        queueMicrotask(deliver);
      } else {
        deliver();
      }
    },
  };
  return { session, posts, profile, state };
}

const methods = (posts: Array<{ method: string }>) => posts.map((p) => p.method);

describe('createCpuProfiler', () => {
  it('start() connects and enables/configures/starts the sampler in order', async () => {
    const f = fakeSession();
    const profiler = createCpuProfiler({
      createSession: () => f.session,
      samplingIntervalMicros: 500,
    });
    await profiler.start();
    expect(f.state.connected).toBe(true);
    expect(methods(f.posts)).toEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
    ]);
    expect(f.posts[1]?.params).toEqual({ interval: 500 }); // microseconds
    expect(profiler.running).toBe(true);
  });

  it('defaults the sampling interval to 1000µs (1ms)', async () => {
    const f = fakeSession();
    const profiler = createCpuProfiler({ createSession: () => f.session });
    await profiler.start();
    expect(f.posts[1]?.params).toEqual({ interval: 1000 });
  });

  it('start() is idempotent while running (no second session/start)', async () => {
    let created = 0;
    const f = fakeSession();
    const profiler = createCpuProfiler({
      createSession: () => {
        created += 1;
        return f.session;
      },
    });
    await profiler.start();
    await profiler.start();
    expect(created).toBe(1);
    expect(f.posts.filter((p) => p.method === 'Profiler.start')).toHaveLength(1);
  });

  it('collect() returns the V8 profile AND restarts the sampler (rolling window), staying connected', async () => {
    const f = fakeSession();
    const profiler = createCpuProfiler({ createSession: () => f.session });
    await profiler.start();
    const profile = await profiler.collect();
    expect(profile).toEqual(f.profile);
    // stop to read the segment, then start again to keep sampling — still running, still connected.
    expect(methods(f.posts)).toEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
      'Profiler.stop',
      'Profiler.start',
    ]);
    expect(profiler.running).toBe(true);
    expect(f.state.disconnected).toBe(false);
  });

  it('stop() reads a final segment, disconnects, and stops running', async () => {
    const f = fakeSession();
    const profiler = createCpuProfiler({ createSession: () => f.session });
    await profiler.start();
    const profile = await profiler.stop();
    expect(profile).toEqual(f.profile);
    expect(methods(f.posts).at(-1)).toBe('Profiler.stop');
    expect(f.state.disconnected).toBe(true);
    expect(profiler.running).toBe(false);
  });

  it('collect()/stop() are no-ops returning undefined when not running', async () => {
    const f = fakeSession();
    const profiler = createCpuProfiler({ createSession: () => f.session });
    expect(await profiler.collect()).toBeUndefined();
    expect(await profiler.stop()).toBeUndefined();
    expect(f.posts).toHaveLength(0);
  });

  it('works with async (Bun-like) inspector callbacks', async () => {
    const f = fakeSession({ async: true });
    const profiler = createCpuProfiler({ createSession: () => f.session });
    await profiler.start();
    expect(profiler.running).toBe(true);
    expect(await profiler.collect()).toEqual(f.profile);
  });

  describe('capability guard', () => {
    it('is a no-op when the inspector Session is unavailable (createSession returns undefined)', async () => {
      const profiler = createCpuProfiler({ createSession: () => undefined });
      await expect(profiler.start()).resolves.toBeUndefined();
      expect(profiler.running).toBe(false);
      expect(await profiler.collect()).toBeUndefined();
      expect(await profiler.stop()).toBeUndefined();
    });

    it('is a no-op when createSession throws (e.g. a runtime without node:inspector)', async () => {
      const profiler = createCpuProfiler({
        createSession: () => {
          throw new Error('no inspector');
        },
      });
      await profiler.start();
      expect(profiler.running).toBe(false);
    });

    it('degrades (disconnect + not running) when a start-time post fails', async () => {
      const f = fakeSession({ failOn: 'Profiler.start' });
      const profiler = createCpuProfiler({ createSession: () => f.session });
      await profiler.start();
      expect(profiler.running).toBe(false);
      expect(f.state.disconnected).toBe(true);
    });

    it('tears down (undefined + disconnect + not running) when a collect-time post fails', async () => {
      const f = fakeSession({ failOn: 'Profiler.stop' });
      const profiler = createCpuProfiler({ createSession: () => f.session });
      await profiler.start();
      expect(await profiler.collect()).toBeUndefined();
      expect(profiler.running).toBe(false);
      expect(f.state.disconnected).toBe(true);
    });

    it('returns undefined and tears down when the final stop() post fails', async () => {
      const f = fakeSession({ failOn: 'Profiler.stop' });
      const profiler = createCpuProfiler({ createSession: () => f.session });
      await profiler.start();
      expect(await profiler.stop()).toBeUndefined();
      expect(profiler.running).toBe(false);
      expect(f.state.disconnected).toBe(true);
    });

    it('swallows a disconnect error during teardown (session already gone)', async () => {
      const f = fakeSession({ failOn: 'Profiler.stop', throwOnDisconnect: true });
      const profiler = createCpuProfiler({ createSession: () => f.session });
      await profiler.start();
      // collect fails → teardown disconnects → disconnect throws → must be swallowed.
      await expect(profiler.collect()).resolves.toBeUndefined();
      expect(profiler.running).toBe(false);
    });
  });

  describe('newInspectorSession', () => {
    it('returns undefined when the runtime has no inspector Session (capability absent)', () => {
      expect(newInspectorSession({})).toBeUndefined();
    });

    it('constructs a session when a Session constructor is present', () => {
      class FakeSession {
        connect() {}
        disconnect() {}
        post() {}
      }
      expect(newInspectorSession({ Session: FakeSession })).toBeInstanceOf(FakeSession);
    });

    it('defaults to the live node:inspector (a real Session)', () => {
      expect(newInspectorSession()).toBeDefined();
    });
  });

  it('uses node:inspector by default and profiles the real process', async () => {
    // No injected session → exercises defaultCreateSession against the live node:inspector.
    const profiler = createCpuProfiler({ samplingIntervalMicros: 10_000 });
    await profiler.start();
    expect(profiler.running).toBe(true);
    const profile = await profiler.stop();
    expect(profile).toBeDefined();
    expect(Array.isArray(profile?.nodes)).toBe(true); // a real V8 .cpuprofile object
    expect(profiler.running).toBe(false);
  });
});
