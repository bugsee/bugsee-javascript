import {
  type CaptureDataEntry,
  CaptureDataEntryBase,
  type CaptureProvider,
  CaptureProviderBase,
  type Scheduler,
  type SnapshotWindow,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { sameValue, type TraceProducer, type TraceSink } from './trace-producer';
import type { TraceSuppression } from './trace-suppression';

// Runtime-agnostic SYSTEM TRACES provider (Android traces.system parity). A trace is a
// named value sampled over TIME. While started, it periodically calls an injected `sample()` and routes
// each {name, value} to the aggregator as a `traces.system` entry. The shell is runtime-agnostic; WHAT
// to sample (process memory/cpu/event-loop lag on Node; performance.memory on browser) is the injected
// seam. An initial sample is taken on start (snapshot), then every `intervalMs` (default 1000, Android
// FPS_REPORT_INTERVAL_MS parity). The timer is unref'd by the default scheduler so it never keeps a
// process alive. Mobile-only traces (orientation/battery/fps/displays) are simply not sampled.

/**
 * Wrap a caller's polled `sample()` so rows under `owned` names are dropped on every call: a name a still-running
 * producer owns keeps ONE writer (the sampler's other rows pass through).
 */
export function withoutTraceNames(
  sample: () => readonly TraceSample[],
  owned: ReadonlySet<string>,
): () => readonly TraceSample[] {
  return () => sample().filter((row) => !owned.has(row.name));
}

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
  /**
   * Names that must NOT be written by this provider: a trace the HOST already writes (WebView native host, Electron main) or
   * that only the key window may write. Consulted for every value (producers and the legacy `sample`), so a LIVE change
   * (the host's handshake reply, a window gaining the key) applies to the next value. A suppressed HELD value is still
   * remembered (never refreshed while suppressed) and is re-recorded, with a fresh timestamp, the moment its name is
   * RELEASED, so the new owner's state appears immediately instead of after the next change.
   */
  suppression?: TraceSuppression;
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

/** The CHANGES of one held trace (oldest first): what lets a report window start with the value that was in force. */
interface HeldHistory {
  name: string;
  displayId: number | undefined;
  changes: Array<{ timestamp: number; value: unknown }>;
}

/** A flapping held value keeps at most this many changes; older ones fall off (the seed then simply cannot reach back that far). */
const MAX_HISTORY = 64;

/**
 * Which running provider owns a producer instance. Producers are stateful (`start()` is a no-op while started, held
 * values live on the instance), so one instance driven by two providers would interleave start/stop. First owner wins;
 * a second provider reports it and skips the producer (#58). Released on stop.
 */
const OWNERS_KEY = Symbol.for('com.bugsee.trace-producer-owners');
// Kept on `globalThis` under `Symbol.for`, so two copies of this module (the ESM and CJS builds) share one registry.
const ownerHost = globalThis as unknown as Record<symbol, WeakMap<TraceProducer, object>>;
ownerHost[OWNERS_KEY] ??= new WeakMap<TraceProducer, object>();
const producerOwners = ownerHost[OWNERS_KEY];

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
  readonly #suppression: TraceSuppression | undefined;
  #offSuppression: (() => void) | undefined;
  readonly #held = new Map<string, Held>();
  readonly #history = new Map<string, HeldHistory>();
  #started: TraceProducer[] = [];
  #running = false;
  #timer: unknown = null;
  readonly #sink: TraceSink = {
    emit: (name, value, displayId, options) => {
      if (this.#running) {
        this.#record(
          name,
          value,
          displayId,
          options?.timestamp ?? this.#now(),
          options?.hold === true,
        );
      }
    },
    now: () => this.#now(),
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
    this.#suppression = options.suppression;
  }

  protected onStart(): void {
    this.#held.clear();
    this.#history.clear();
    this.#running = true;
    this.#offSuppression = this.#suppression?.subscribe((released) => this.#rerecord(released));
    for (const producer of this.#producers) {
      const owner = producerOwners.get(producer);
      if (owner === this) continue; // listed twice in this provider's own array: already started once
      if (owner !== undefined) {
        this.#onError(
          new Error(
            `system trace producer "${producer.name}" is already owned by another client; skipped (build a fresh producer set per client)`,
          ),
        );
        continue;
      }
      producerOwners.set(producer, this);
      try {
        producer.start(this.#sink);
        this.#started.push(producer);
      } catch (error) {
        this.#onError(error);
        this.#safeStop(producer);
        producerOwners.delete(producer);
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
    try {
      try {
        this.#scheduler.clearInterval(this.#timer);
      } finally {
        this.#timer = null;
        this.#offSuppression?.();
        this.#offSuppression = undefined;
      }
    } finally {
      // a throwing scheduler/unsubscribe must still release the producers (and their ownership) and stop recording
      this.#stopProducers();
      this.#running = false;
      this.#held.clear();
      this.#history.clear();
    }
  }

  /**
   * A report snapshot is about to freeze `window` (CaptureProvider.prepareSnapshot). In a throttled / frozen / hidden runtime
   * neither the producers' polls nor the held-value refresh ran, and the store has long evicted what they wrote before, so
   * the window's head (and tail) would be empty and every trace would appear to start mid-way. So, honestly:
   *  - each producer takes one fresh reading (a hidden tab's heap is still readable; fps, derived from frames, is not and
   *    stays a gap);
   *  - every HELD (state) trace is carried to the window start with the value that was in force there, and re-recorded at
   *    the window end with its last value. A polled value is never carried or refreshed: that would fabricate a flat line.
   */
  prepareSnapshot(window: SnapshotWindow): CaptureDataEntry[] {
    if (!this.#running) return [];
    for (const producer of this.#started) {
      try {
        producer.sampleNow?.();
      } catch (error) {
        this.#onError(error);
      }
    }
    // The carried values are RETURNED, not written: the store trims by a range it reads from its own clock (possibly a
    // millisecond after `window.start`), which would drop a seed stamped exactly at the window start. Returned entries ride
    // along with the report untrimmed.
    const seeds: CaptureDataEntry[] = [];
    for (const history of this.#history.values()) {
      const { changes } = history;
      let inForce = -1;
      while (
        inForce + 1 < changes.length &&
        (changes[inForce + 1] as { timestamp: number }).timestamp <= window.start
      ) {
        inForce += 1;
      }
      if (inForce < 0) continue; // first recorded inside the window (a young session): nothing predates it
      const base = changes[inForce] as { timestamp: number; value: unknown };
      changes.splice(0, inForce); // older changes can never be in force again; the base stays for the next report
      if (base.timestamp < window.start && !this.#suppression?.has(history.name)) {
        seeds.push(
          new CaptureDataEntryBase('traces.system', window.start, {
            timestamp: window.start,
            name: history.name,
            value: base.value,
            ...(history.displayId !== undefined ? { displayId: history.displayId } : {}),
          }),
        );
      }
    }
    for (const held of [...this.#held.values()]) {
      // Only a value the refresh timer would already have re-recorded (older than `refreshMs`, i.e. the timer did not run): a
      // healthy page keeps a row within `refreshMs` of any instant, and a row a few ms before the end is not worth a twin.
      if (window.end - held.timestamp >= this.#refreshMs) {
        this.#record(held.name, held.value, held.displayId, window.end, true);
      }
    }
    return seeds;
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
    this.#write(name, value, displayId, timestamp);
    if (!hold) return;
    const key = displayId === undefined ? name : `${displayId}:${name}`;
    this.#held.set(key, { name, value, timestamp, displayId });
    let history = this.#history.get(key);
    if (history === undefined) {
      history = { name, displayId, changes: [] };
      this.#history.set(key, history);
    }
    const last = history.changes.at(-1);
    if (last === undefined || !sameValue(last.value, value)) {
      history.changes.push({ timestamp, value });
      if (history.changes.length > MAX_HISTORY) history.changes.shift();
    }
  }

  /** Write one entry (unless the name is suppressed) without touching the held / history state. */
  #write(name: string, value: unknown, displayId: number | undefined, timestamp: number): void {
    if (this.#suppression?.has(name)) return;
    this.capture('traces.system', timestamp, {
      timestamp,
      name,
      value,
      ...(displayId !== undefined ? { displayId } : {}),
    });
  }

  /** Names just released by the suppression: record each one's held value now (a polled value has nothing to replay). */
  #rerecord(released: readonly string[]): void {
    // (`#held` is empty unless running: onStop clears it, so a release delivered after stop() has nothing to replay)
    const now = this.#now();
    for (const held of [...this.#held.values()]) {
      if (released.includes(held.name))
        this.#record(held.name, held.value, held.displayId, now, true);
    }
  }

  #stopProducers(): void {
    for (const producer of this.#started.splice(0)) {
      this.#safeStop(producer); // ownership is held until stop() has finished (it never throws)
      producerOwners.delete(producer);
    }
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
