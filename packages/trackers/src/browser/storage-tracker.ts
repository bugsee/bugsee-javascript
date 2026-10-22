import { InterceptorBase } from '../interceptor-base';
import { createTrackerRegistry } from '../tracker-registry';
import { hostRead } from './host-read';

// Browser STORAGE tracker (domain tracker, design §15.3 item 1; Android reference: BugseeTrackerStorage). It wraps
// the Storage API: `navigator.storage.estimate()` ({usage, quota}) and `navigator.storage.persisted()`.
//
// IMPORTANT — this is an ORIGIN quota ESTIMATE, not device free space. `quota` is what the browser is willing to
// give THIS origin (a fraction of the disk, or a fixed cap), and browsers fuzz/pad both numbers on purpose (Safari
// and private windows especially). It must never be presented as the Android `disk_mem_*` figures.
//
// There is no change event, so it POLLS SPARSELY: on activation, when the document becomes visible again, and on a
// slow timer (default 5 minutes; ticks while the page is hidden are skipped). Only one stage exists:
//   `storageEstimate` -> { usageBytes?, quotaBytes?, persisted? }   (a field is OMITTED, never zero, when unusable).
// Visibility-triggered polls are throttled to one per minute; poll FAILURES are reported once per failure streak.
//
// SINGLETON per key object (see `storageTrackerFor`). RETENTION rule — what survives the last unsubscribe:
//   * the LAST estimate (`current()` keeps answering with it, so a later subscriber gets a value immediately, and a
//     failed poll never erases it; a PARTIAL poll — one call failed — keeps the retained fields that call would have
//     refreshed, and the estimate's age only advances when usage/quota were refreshed). It may be stale: every activation polls again and emits the fresh value.
// What does NOT survive: the timer and the visibility listener — both are released when nobody subscribes. A poll in
// flight at that moment is IGNORED when it settles (an epoch token, bumped by every poll/stop/reset), so a stale
// promise can neither emit nor overwrite the retained estimate. A poll superseded by a newer one is ignored too.

export interface StorageManagerLike {
  estimate?(): Promise<{ usage?: unknown; quota?: unknown }>;
  persisted?(): Promise<unknown>;
}
export interface StorageEstimate {
  /** Bytes this origin uses. Omitted when not a finite non-negative number. */
  usageBytes?: number;
  /** Bytes the browser lets this origin use (an estimate, not free disk). Omitted when not a finite non-negative number. */
  quotaBytes?: number;
  /** Whether the origin's storage is persistent (exempt from eviction). Omitted when the browser did not answer a boolean. */
  persisted?: boolean;
}
export interface StorageTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
/** What the tracker needs from a launch. */
export interface StorageEnv {
  /** Read live on every poll (`navigator.storage` is a getter, absent in insecure contexts). */
  navigator?: { readonly storage?: StorageManagerLike };
  /** Source of `visibilitychange` and `visibilityState`. */
  document?: {
    readonly visibilityState?: string;
    addEventListener?(type: string, listener: () => void): void;
    removeEventListener?(type: string, listener: () => void): void;
  };
  /** Drives the slow poll; default the global timers. */
  scheduler?: StorageTimers;
  /** Slow-poll period in ms (default 5 minutes). */
  intervalMs?: number;
  /**
   * Faster poll period in ms, used while the origin's HEADROOM (`quota - usage`) is under `fastBelowBytes`. Both must be
   * given for it to apply (the disk-pressure consumer: 30 s under 500 MB). Absent: the cadence never changes.
   */
  fastIntervalMs?: number;
  /** Headroom in bytes under which `fastIntervalMs` applies. */
  fastBelowBytes?: number;
  /** Wall-clock ms for estimate age and the visibility throttle; default `Date.now`. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
/** Minimum gap between two polls when the trigger is a visibility change (tab-switching must not hammer estimate()). */
export const VISIBILITY_MIN_GAP_MS = 60_000;
/** A retained estimate older than this many poll intervals is not handed out as `currentFresh()`. */
const FRESH_INTERVALS = 2;

// The global timers, reached through a cast (this package's tsconfig has no DOM/Node lib).
const globalTimers = globalThis as unknown as StorageTimers;
const defaultNow = (): number => (globalThis as unknown as { Date: { now(): number } }).Date.now();

const defaultTimers: StorageTimers = {
  setInterval: (cb, ms) => globalTimers.setInterval(cb, ms),
  clearInterval: (h) => globalTimers.clearInterval(h),
};

/** A usable byte count, or undefined (NaN/Infinity/negative/non-number are never sent, and never become 0). */
function bytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class StorageTracker extends InterceptorBase<{
  storageEstimate: StorageEstimate;
}> {
  readonly name = 'browser-storage';
  #env: StorageEnv;
  #epoch = 0;
  /** Retained across deactivation (see the retention rule). */
  #estimate: StorageEstimate | undefined;
  #estimateAt: number | undefined;
  /** Seams from a rebind, applied at the next activation (the attached `#env` is never swapped under a live timer/listener). */
  #pending: StorageEnv | undefined;
  /** True while the last settled poll had a failure (failures are reported once per streak). */
  #failing = false;
  #lastPollAt: number | undefined;
  /** Present only while the slow timer is armed (the handle itself may be any value, even undefined). */
  #timer: { handle: unknown; scheduler: StorageTimers; periodMs: number } | undefined;
  /** Present only while the visibility listener is attached. */
  #visibility: { document: NonNullable<StorageEnv['document']>; listener: () => void } | undefined;
  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => void) | undefined };

  constructor(env: StorageEnv, onError?: (error: unknown) => void) {
    const report = { fn: onError };
    super((error) => report.fn?.(error));
    this.#report = report;
    this.#env = env;
  }

  /**
   * Hand the latest launch's seams to this shared tracker. A defined `onError` replaces the reporter (undefined keeps
   * it). Every defined seam is kept (an undefined one never clobbers an earlier one) and is applied from the NEXT
   * activation: a tracker that is attached keeps the navigator/document/scheduler it armed until its last subscriber
   * leaves.
   */
  rebind(env: StorageEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    const base = this.#pending ?? this.#env;
    this.#pending = {
      ...pick(env.navigator, base.navigator, 'navigator'),
      ...pick(env.document, base.document, 'document'),
      ...pick(env.scheduler, base.scheduler, 'scheduler'),
      ...pick(env.intervalMs, base.intervalMs, 'intervalMs'),
      ...pick(env.fastIntervalMs, base.fastIntervalMs, 'fastIntervalMs'),
      ...pick(env.fastBelowBytes, base.fastBelowBytes, 'fastBelowBytes'),
      ...pick(env.now, base.now, 'now'),
    };
  }

  #onError(error: unknown): void {
    try {
      this.#report.fn?.(error);
    } catch {
      /* the reporter itself failed */
    }
  }

  /** Latest estimate; undefined until the first poll succeeds. Retained after the last unsubscribe. */
  current(): StorageEstimate | undefined {
    return this.#estimate;
  }

  /**
   * The retained estimate, but only while it is younger than twice the poll interval; undefined once it is older (or
   * unknown). For consumers that publish it as a reading (a stale snapshot must not be presented as current).
   */
  currentFresh(): StorageEstimate | undefined {
    const at = this.#estimateAt;
    if (this.#estimate === undefined || at === undefined) return undefined;
    const limit = FRESH_INTERVALS * (this.#env.intervalMs ?? DEFAULT_INTERVAL_MS);
    const age = this.#clock() - at;
    // A clock that stepped BACKWARDS (negative age) cannot vouch for freshness: treat it as stale.
    return age >= 0 && age <= limit ? this.#estimate : undefined;
  }

  #clock(): number {
    return (this.#env.now ?? defaultNow)();
  }

  /** Test/teardown: forget the estimate, release timer and listener, and ignore anything in flight. */
  reset(): void {
    this.#epoch += 1;
    this.#release();
    this.#estimate = undefined;
    this.#failing = false;
  }

  protected onActivate(): void {
    if (this.#pending !== undefined) {
      this.#env = this.#pending;
      this.#pending = undefined;
    }
    // Nothing to poll (insecure context / no Storage API): stay inert — no timer, no listener. The next activation looks again.
    if (this.#storage() === undefined) return;
    this.#attachVisibility();
    this.#arm();
    this.#poll();
  }

  protected override onDeactivate(): void {
    this.#epoch += 1; // invalidate any in-flight poll; the estimate is retained
    this.#release();
  }

  #attachVisibility(): void {
    const document = hostRead(
      () => this.#env.document,
      (e) => this.#onError(e),
    );
    if (document === undefined) return;
    const listener = (): void => {
      if (
        hostRead(
          () => document.visibilityState,
          (e) => this.#onError(e),
        ) !== 'visible'
      ) {
        return;
      }
      // Throttle: tab-switching must not turn into a stream of estimate() calls.
      const last = this.#lastPollAt;
      // A backwards clock step (negative elapsed) counts as "the gap has elapsed": never suppress polling on it.
      const elapsed = last === undefined ? undefined : this.#clock() - last;
      if (elapsed !== undefined && elapsed >= 0 && elapsed < VISIBILITY_MIN_GAP_MS) return;
      this.#poll();
    };
    // Recorded BEFORE attaching so a failure still detaches exactly this (removing a never-added one is a no-op).
    this.#visibility = { document, listener };
    try {
      document.addEventListener?.('visibilitychange', listener);
    } catch (error) {
      this.#onError(error);
    }
  }

  /** The poll period for the current estimate: the fast one while headroom is under the fast threshold. */
  #periodMs(): number {
    const slow = this.#env.intervalMs ?? DEFAULT_INTERVAL_MS;
    const { fastIntervalMs, fastBelowBytes } = this.#env;
    const e = this.#estimate;
    if (
      fastIntervalMs === undefined ||
      fastBelowBytes === undefined ||
      e?.usageBytes === undefined ||
      e.quotaBytes === undefined
    ) {
      return slow;
    }
    return e.quotaBytes - e.usageBytes < fastBelowBytes ? Math.min(fastIntervalMs, slow) : slow;
  }

  #arm(): void {
    try {
      const scheduler = this.#env.scheduler ?? defaultTimers;
      const periodMs = this.#periodMs();
      const handle = scheduler.setInterval(() => {
        // Sparse on purpose: a hidden page is not polled (visibility->visible polls on return).
        if (
          hostRead(
            () => this.#env.document?.visibilityState,
            (e) => this.#onError(e),
          ) !== 'hidden'
        ) {
          this.#poll();
        }
      }, periodMs);
      this.#timer = { handle, scheduler, periodMs };
    } catch (error) {
      this.#onError(error);
    }
  }

  /** After a reading: move an armed timer to the period that now applies (headroom crossed the fast threshold). */
  #retune(): void {
    const timer = this.#timer;
    if (timer === undefined || timer.periodMs === this.#periodMs()) return;
    this.#timer = undefined;
    try {
      timer.scheduler.clearInterval(timer.handle);
    } catch (error) {
      this.#onError(error);
    }
    this.#arm();
  }

  /** Timer + visibility listener, best-effort. */
  #release(): void {
    const timer = this.#timer;
    this.#timer = undefined;
    if (timer !== undefined) {
      try {
        timer.scheduler.clearInterval(timer.handle);
      } catch (error) {
        this.#onError(error);
      }
    }
    const visibility = this.#visibility;
    this.#visibility = undefined;
    if (visibility !== undefined) {
      try {
        visibility.document.removeEventListener?.('visibilitychange', visibility.listener);
      } catch {
        /* best-effort */
      }
    }
  }

  /** `navigator.storage` read live (guarded + reported); undefined when unsupported / insecure context. */
  #storage(): StorageManagerLike | undefined {
    const storage = hostRead(
      () => this.#env.navigator?.storage,
      (e) => this.#onError(e),
    );
    return typeof storage === 'object' && storage !== null ? storage : undefined;
  }

  #poll(): void {
    const mine = ++this.#epoch; // supersedes any poll still in flight
    const storage = this.#storage();
    if (storage === undefined) return;
    this.#lastPollAt = this.#clock();
    const errors: unknown[] = [];
    const ask = <T>(call: () => Promise<T> | undefined): Promise<T | undefined> => {
      try {
        const pending = call();
        return pending === undefined
          ? Promise.resolve(undefined)
          : pending.then(
              (value) => value,
              (error: unknown) => {
                errors.push(error);
                return undefined;
              },
            );
      } catch (error) {
        errors.push(error);
        return Promise.resolve(undefined);
      }
    };
    void Promise.all([ask(() => storage.estimate?.()), ask(() => storage.persisted?.())]).then(
      ([raw, persisted]) => {
        if (this.#epoch !== mine) return; // stopped, reset or superseded while in flight
        // One report per failure streak: a persistently failing API must not flood onError once per tick.
        if (errors.length === 0) this.#failing = false;
        else if (!this.#failing) {
          this.#failing = true;
          for (const error of errors) this.#onError(error);
        }
        this.#publish(raw, persisted); // every host read inside is guarded; listener fan-out is failure-isolated
      },
    );
  }

  #publish(raw: { usage?: unknown; quota?: unknown } | undefined, persisted: unknown): void {
    const report = (e: unknown): void => this.#onError(e);
    const usageBytes = bytes(hostRead(() => raw?.usage, report));
    const quotaBytes = bytes(hostRead(() => raw?.quota, report));
    const fresh: StorageEstimate = {
      ...(usageBytes !== undefined ? { usageBytes } : {}),
      ...(quotaBytes !== undefined ? { quotaBytes } : {}),
      ...(typeof persisted === 'boolean' ? { persisted } : {}),
    };
    // Nothing usable (both calls failed/unsupported): keep the retained estimate, emit nothing.
    if (Object.keys(fresh).length === 0) return;
    // PARTIAL result: a call that FAILED (estimate() rejected -> `raw` undefined; persisted() failed ->
    // undefined) contributes nothing, so its retained fields are kept. A call that ANSWERED replaces its fields
    // (an unusable number is omitted, not papered over with an old one).
    const kept = this.#estimate;
    const estimate: StorageEstimate = {
      ...(raw === undefined && kept?.usageBytes !== undefined
        ? { usageBytes: kept.usageBytes }
        : {}),
      ...(raw === undefined && kept?.quotaBytes !== undefined
        ? { quotaBytes: kept.quotaBytes }
        : {}),
      ...(persisted === undefined && kept?.persisted !== undefined
        ? { persisted: kept.persisted }
        : {}),
      ...fresh,
    };
    this.#estimate = estimate;
    // Age tracks usage/quota only: a persisted-only refresh must not make old usage/quota look fresh.
    if (usageBytes !== undefined || quotaBytes !== undefined) this.#estimateAt = this.#clock();
    this.#retune();
    this.emit('storageEstimate', estimate);
  }
}

/** `{[key]: next}` when next is defined, else the previous value (if any), else nothing. */
function pick<K extends string, V>(
  next: V | undefined,
  previous: V | undefined,
  key: K,
): { [P in K]?: V } {
  const value = next ?? previous;
  return value !== undefined ? ({ [key]: value } as { [P in K]?: V }) : {};
}

const registry = createTrackerRegistry<StorageTracker>();

/** A {@link StorageEnv} plus the objects the singleton is keyed on. */
export interface StorageTrackerEnv extends StorageEnv {
  window?: object;
}

// The key is the window the SDK is bound to; failing that the navigator the storage came from; failing that the
// env object itself (an ad-hoc env then gets a private tracker). Host reads are guarded AND reported.
function keyOf(env: StorageTrackerEnv, onError?: (error: unknown) => void): object {
  const win = hostRead(() => env.window, onError);
  if (typeof win === 'object' && win !== null) return win;
  const nav = hostRead(() => env.navigator, onError);
  if (typeof nav === 'object' && nav !== null) return nav;
  return env;
}

function seamsOf(env: StorageTrackerEnv): StorageEnv {
  return {
    ...(env.navigator !== undefined ? { navigator: env.navigator } : {}),
    ...(env.document !== undefined ? { document: env.document } : {}),
    ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
    ...(env.intervalMs !== undefined ? { intervalMs: env.intervalMs } : {}),
    ...(env.fastIntervalMs !== undefined ? { fastIntervalMs: env.fastIntervalMs } : {}),
    ...(env.fastBelowBytes !== undefined ? { fastBelowBytes: env.fastBelowBytes } : {}),
    ...(env.now !== undefined ? { now: env.now } : {}),
  };
}

/**
 * The singleton StorageTracker for the env's window. Every call (a relaunch included) hands the shared tracker the
 * latest launch's `onError` and seams (see {@link StorageTracker.rebind}); nothing else of the env is kept.
 */
export function storageTrackerFor(
  env: StorageTrackerEnv,
  onError?: (error: unknown) => void,
): StorageTracker {
  const seams = seamsOf(env);
  return registry.for(
    keyOf(env, onError),
    () => new StorageTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/** Test/teardown: drop the env's tracker (resetting it, so its timer and listener are released). */
export function resetStorageTracker(env: StorageTrackerEnv): void {
  registry.reset(keyOf(env));
}
