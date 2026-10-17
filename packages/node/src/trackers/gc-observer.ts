import { PerformanceObserver } from 'node:perf_hooks';

// Lazy GC source: a `PerformanceObserver({entryTypes:['gc']})` that exists only between start() and stop().
// Measured 2026-09: real entries on Node; BLIND on Bun and Deno (0 entries after heavy churn and forced GC),
// so those runtimes gate it off (`measuresGc: false`) and never even construct the observer — a quiet-looking
// zero there would be a lie.

export interface GcEntry {
  readonly duration: number;
}
interface ObserverLike {
  observe(options: { entryTypes: string[] }): void;
  disconnect(): void;
  takeRecords?(): GcEntry[];
}
export type ObserverCtor = new (
  callback: (list: { getEntries(): GcEntry[] }) => void,
) => ObserverLike;

export interface GcInterval {
  /** Collections finished in the interval. */
  count: number;
  /** Sum of their pause durations (ms). */
  pauseMs: number;
  maxPauseMs: number;
}

export interface GcSource {
  /** Collections since the previous read, or undefined when not observing (never a fabricated zero). */
  read(): GcInterval | undefined;
  start(): void;
  stop(): void;
}

export function createGcSource(
  Observer: ObserverCtor = PerformanceObserver as unknown as ObserverCtor,
): GcSource {
  let observer: ObserverLike | undefined;
  let unusable = false;
  let acc: GcInterval = { count: 0, pauseMs: 0, maxPauseMs: 0 };

  const add = (entries: readonly GcEntry[]): void => {
    for (const { duration } of entries) {
      if (!Number.isFinite(duration) || duration < 0) continue;
      acc.count += 1;
      acc.pauseMs += duration;
      acc.maxPauseMs = Math.max(acc.maxPauseMs, duration);
    }
  };
  const disconnect = (o: ObserverLike | undefined): void => {
    try {
      o?.disconnect();
    } catch {
      /* best-effort */
    }
  };

  return {
    start() {
      if (unusable) return;
      acc = { count: 0, pauseMs: 0, maxPauseMs: 0 };
      const created: ObserverLike = new Observer((list) => {
        if (observer === created) add(list.getEntries()); // a stopped observer's late delivery is ignored
      });
      try {
        created.observe({ entryTypes: ['gc'] });
        observer = created;
      } catch {
        unusable = true; // a runtime that refuses the entry type must not abort SDK startup
        disconnect(created);
      }
    },
    stop() {
      const o = observer;
      observer = undefined;
      disconnect(o);
    },
    read() {
      if (observer === undefined) return undefined;
      try {
        // The callback is delivered asynchronously: drain what is buffered so the interval is complete.
        add(observer.takeRecords?.() ?? []);
      } catch {
        return undefined;
      }
      const out = acc;
      acc = { count: 0, pauseMs: 0, maxPauseMs: 0 };
      return out;
    },
  };
}
