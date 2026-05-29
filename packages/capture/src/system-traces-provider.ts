import { type CaptureProvider, CaptureProviderBase, type Scheduler } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';

// Runtime-agnostic SYSTEM TRACES provider (design §16.1, Android traces.system parity). A trace is a
// named value sampled over TIME. While started, it periodically calls an injected `sample()` and routes
// each {name, value} to the aggregator as a `traces.system` entry. The shell is runtime-agnostic; WHAT
// to sample (process memory/cpu/event-loop lag on Node; performance.memory on browser) is the injected
// seam. An initial sample is taken on start (snapshot), then every `intervalMs` (default 1000, Android
// FPS_REPORT_INTERVAL_MS parity). The timer is unref'd by the default scheduler so it never keeps a
// process alive. Mobile-only traces (orientation/battery/fps/displays) are simply not sampled.

/** One sampled system trace: a named value at the sampling instant. */
export interface TraceSample {
  name: string;
  value: unknown;
}

const globalTimers = globalThis as unknown as {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};
const defaultScheduler: Scheduler = {
  setInterval: (callback, ms) => {
    const handle = globalTimers.setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.(); // never keep a Node process alive
    return handle;
  },
  clearInterval: (handle) => globalTimers.clearInterval(handle),
};

export interface SystemTracesProviderOptions {
  /** Reads the current system traces (the runtime-specific seam — e.g. node memory/cpu). Required. */
  sample: () => readonly TraceSample[];
  /** Sampling interval in ms while started. Default 1000. */
  intervalMs?: number;
  /** Scheduler for the sampling timer; injectable for tests/edge. Default global timers (unref'd). */
  scheduler?: Scheduler;
  /** Wall-clock source for the entry timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
}

class SystemTracesProvider extends CaptureProviderBase {
  readonly name = 'traces.system';
  readonly controllingOption = BugseeOption.CaptureSystemTraces;
  readonly #sample: () => readonly TraceSample[];
  readonly #intervalMs: number;
  readonly #scheduler: Scheduler;
  readonly #now: () => number;
  #timer: unknown = null;

  constructor(options: SystemTracesProviderOptions) {
    super();
    this.#sample = options.sample;
    this.#intervalMs = options.intervalMs ?? 1000;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#now = options.now ?? (() => Date.now());
  }

  protected onStart(): void {
    this.#emit(); // initial snapshot, so a short-lived session still has current values
    this.#timer = this.#scheduler.setInterval(() => this.#emit(), this.#intervalMs);
  }

  protected override onStop(): void {
    this.#scheduler.clearInterval(this.#timer);
    this.#timer = null;
  }

  #emit(): void {
    const timestamp = this.#now();
    for (const { name, value } of this.#sample()) {
      this.capture('traces.system', timestamp, { timestamp, name, value });
    }
  }
}

export function createSystemTracesProvider(options: SystemTracesProviderOptions): CaptureProvider {
  return new SystemTracesProvider(options);
}
