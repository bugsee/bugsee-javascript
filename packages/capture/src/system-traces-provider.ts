import { type CaptureProvider, CaptureProviderBase, type Scheduler } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import type { TraceProducer, TraceSink } from './trace-producer';

// Runtime-agnostic SYSTEM TRACES provider (Android traces.system parity). A trace is a
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
  /** Trace producers (each subscribes to trackers; the provider owns start/stop + isolation). */
  producers?: readonly TraceProducer[];
  /** LEGACY polled seam: read every system trace on each tick. Kept so existing samplers/tests keep working. */
  sample?: () => readonly TraceSample[];
  /** Tick interval in ms while started. Default 1000. */
  intervalMs?: number;
  /** Scheduler for the tick timer; injectable for tests/edge. Default global timers (unref'd). */
  scheduler?: Scheduler;
  /** Wall-clock source for the entry timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
  /**
   * A HELD value (emitted with `hold: true`, i.e. a producer's `emitIfChanged`) older than this is
   * re-recorded so a rolling capture window never loses a rarely-changing trace. Polled values (`emit`,
   * `hold: false`) and legacy `sample()` rows are never refreshed. Default 10 000; Infinity disables.
   */
  refreshMs?: number;
  /** Reports an isolated producer/tick failure. Must not throw. */
  onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_REFRESH_MS = 10_000;

/**
 * The `refreshMs` a launch derives from its rolling recording window (ms): a quarter of the window, so a
 * held value appears several times in any captured slice, clamped to [2 x the default 1 s provider
 * interval, 10 s]. The floor keeps a refresh from firing on every tick; a non-finite or non-positive
 * window (a misconfigured `maxRecordingTime`) falls back to the 10 s default. ONE definition, shared by
 * the node, browser and webview launches.
 */
export function deriveRefreshMs(recordingWindowMs: number): number {
  if (!Number.isFinite(recordingWindowMs) || recordingWindowMs <= 0) return DEFAULT_REFRESH_MS;
  return Math.min(DEFAULT_REFRESH_MS, Math.max(2 * DEFAULT_INTERVAL_MS, recordingWindowMs / 4));
}

interface Held {
  name: string;
  value: unknown;
  timestamp: number;
  displayId: number | undefined;
}

class SystemTracesProvider extends CaptureProviderBase {
  readonly name = 'traces.system';
  readonly controllingOption = BugseeOption.CaptureSystemTraces;
  readonly #producers: readonly TraceProducer[];
  readonly #sample: (() => readonly TraceSample[]) | undefined;
  readonly #intervalMs: number;
  readonly #refreshMs: number;
  readonly #scheduler: Scheduler;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #held = new Map<string, Held>();
  #started: TraceProducer[] = [];
  #running = false;
  #timer: unknown = null;
  readonly #sink: TraceSink = {
    emit: (name, value, displayId, options) => {
      if (this.#running) this.#record(name, value, displayId, this.#now(), options?.hold === true);
    },
  };

  constructor(options: SystemTracesProviderOptions) {
    super();
    if (options.producers === undefined && options.sample === undefined) {
      throw new Error('createSystemTracesProvider needs producers or sample');
    }
    this.#producers = options.producers ?? [];
    this.#sample = options.sample;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError ?? (() => {});
  }

  protected onStart(): void {
    this.#held.clear();
    this.#running = true;
    for (const producer of this.#producers) {
      try {
        producer.start(this.#sink);
        this.#started.push(producer);
      } catch (error) {
        this.#onError(error);
        this.#safeStop(producer);
      }
    }
    try {
      this.#emitLegacy(this.#now()); // initial snapshot, so a short-lived session still has current values
      this.#timer = this.#scheduler.setInterval(() => this.#tick(), this.#intervalMs);
    } catch (error) {
      // a failed start leaves nothing running: producers stopped and #running off (so no stray tick or
      // late emit records); the snapshot is cleared by the next start
      this.#stopProducers();
      this.#running = false;
      throw error;
    }
  }

  protected override onStop(): void {
    this.#scheduler.clearInterval(this.#timer);
    this.#timer = null;
    this.#stopProducers();
    this.#running = false;
    this.#held.clear();
  }

  #tick(): void {
    if (!this.#running) return; // a tick that slipped past stop() records nothing
    try {
      const now = this.#now();
      try {
        this.#emitLegacy(now);
      } catch (error) {
        this.#onError(error); // a broken legacy sampler must not stop the held-value refresh
      }
      for (const held of [...this.#held.values()]) {
        if (now - held.timestamp >= this.#refreshMs) {
          this.#record(held.name, held.value, held.displayId, now, true);
        }
      }
    } catch (error) {
      this.#onError(error); // a timer must never throw into the host
    }
  }

  #emitLegacy(timestamp: number): void {
    if (this.#sample === undefined) return;
    for (const { name, value } of this.#sample()) {
      this.#record(name, value, undefined, timestamp, false); // re-read every tick: never held
    }
  }

  #record(
    name: string,
    value: unknown,
    displayId: number | undefined,
    timestamp: number,
    hold: boolean,
  ): void {
    this.capture('traces.system', timestamp, {
      timestamp,
      name,
      value,
      ...(displayId !== undefined ? { displayId } : {}),
    });
    if (!hold) return;
    this.#held.set(displayId === undefined ? name : `${displayId}:${name}`, {
      name,
      value,
      timestamp,
      displayId,
    });
  }

  #stopProducers(): void {
    for (const producer of this.#started.splice(0)) this.#safeStop(producer);
  }

  #safeStop(producer: TraceProducer): void {
    try {
      producer.stop();
    } catch (error) {
      this.#onError(error);
    }
  }
}

export function createSystemTracesProvider(options: SystemTracesProviderOptions): CaptureProvider {
  return new SystemTracesProvider(options);
}
