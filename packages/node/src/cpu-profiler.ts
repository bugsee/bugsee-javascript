import inspector from 'node:inspector';

// The CPU profiler controller (node diagnostics). Wraps an in-process node:inspector `Session` driving the
// V8 sampling profiler (Profiler.enable/setSamplingInterval/start/stop). It is ASYNC on purpose: Node
// delivers inspector `post` callbacks synchronously, but Bun delivers them on a later tick — a synchronous
// stop() would silently drop the profile on Bun. Everything is capability-guarded: on a runtime without a
// usable node:inspector (or any inspector error) it degrades to a no-op rather than throwing. The session
// is injectable so the control flow is testable without a real inspector. The connected session IS the
// single source of "running" truth.
//
// Coverage note: v8 branch coverage under-reports the guard `else` arms here (a known v8 limitation for
// branches in async functions that cross an `await`). The arms ARE exercised — the no-session/idempotent
// tests assert outcomes that require them — and the per-entity mutator loop confirms every guard is caught.
// The package gate (global ≥90% branch) passes; do not contort the control flow to satisfy the artifact.

/** A V8 CPU profile (the `.cpuprofile` object Profiler.stop returns). Passed through verbatim to the bundle. */
export interface CpuProfile {
  nodes: unknown[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** The minimal inspector Session surface the profiler needs — injectable for tests + the capability guard. */
export interface ProfilerSession {
  connect(): void;
  disconnect(): void;
  post(method: string, callback?: (err: Error | null, result?: unknown) => void): void;
  post(
    method: string,
    params: object,
    callback?: (err: Error | null, result?: unknown) => void,
  ): void;
}

export interface CpuProfiler {
  /** Connect the inspector session and begin sampling. Idempotent; a no-op when the inspector is absent. */
  start(): Promise<void>;
  /**
   * Stop the current segment, return its V8 profile, and RESTART sampling (the rolling-window primitive) —
   * the session stays connected. Returns undefined when not running or on failure.
   */
  collect(): Promise<CpuProfile | undefined>;
  /** Final teardown: stop sampling, return the last segment, and disconnect the session. */
  stop(): Promise<CpuProfile | undefined>;
  readonly running: boolean;
}

export interface CpuProfilerOptions {
  /** Inspector Session factory. Default: node:inspector. Returns undefined / throws → the profiler no-ops. */
  createSession?: () => ProfilerSession | undefined;
  /** Sampling interval in MICROseconds. Default 1000 (1ms). Lower = higher resolution + more overhead. */
  samplingIntervalMicros?: number;
}

const DEFAULT_INTERVAL_MICROS = 1000;

/**
 * Construct an inspector Session, or undefined when the runtime lacks `node:inspector` (the capability
 * guard). Exported for testing the absent-inspector arm without mocking the builtin. Defaults to the live
 * `node:inspector` module.
 */
export function newInspectorSession(
  mod: { Session?: new () => ProfilerSession } = inspector as unknown as {
    Session?: new () => ProfilerSession;
  },
): ProfilerSession | undefined {
  return mod.Session ? new mod.Session() : undefined;
}

const post = (session: ProfilerSession, method: string, params?: object): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const cb = (err: Error | null, result?: unknown): void => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };
    if (params === undefined) {
      session.post(method, cb);
    } else {
      session.post(method, params, cb);
    }
  });

const profileOf = (result: unknown): CpuProfile | undefined =>
  (result as { profile?: CpuProfile }).profile;

export function createCpuProfiler(options: CpuProfilerOptions = {}): CpuProfiler {
  const createSession = options.createSession ?? newInspectorSession;
  const interval = options.samplingIntervalMicros ?? DEFAULT_INTERVAL_MICROS;
  let session: ProfilerSession | undefined;

  // Drop the session and disconnect it (best-effort — the runtime may have already torn it down).
  const teardown = (s: ProfilerSession): void => {
    session = undefined;
    try {
      s.disconnect();
    } catch {
      // session already gone — nothing to do
    }
  };

  const start = async (): Promise<void> => {
    if (!session) {
      let s: ProfilerSession | undefined;
      try {
        s = createSession();
      } catch {
        s = undefined; // a runtime without a usable node:inspector
      }
      if (s) {
        try {
          s.connect();
          await post(s, 'Profiler.enable');
          await post(s, 'Profiler.setSamplingInterval', { interval });
          await post(s, 'Profiler.start');
          session = s;
        } catch {
          teardown(s);
        }
      }
    }
  };

  const collect = async (): Promise<CpuProfile | undefined> => {
    const s = session;
    if (s) {
      try {
        const profile = profileOf(await post(s, 'Profiler.stop'));
        await post(s, 'Profiler.start'); // restart for the next rolling window
        return profile;
      } catch {
        teardown(s);
      }
    }
    return undefined;
  };

  const stop = async (): Promise<CpuProfile | undefined> => {
    const s = session;
    if (s) {
      try {
        return profileOf(await post(s, 'Profiler.stop'));
      } catch {
        // fall through to undefined
      } finally {
        teardown(s);
      }
    }
    return undefined;
  };

  return {
    get running() {
      return session !== undefined;
    },
    start,
    collect,
    stop,
  };
}
