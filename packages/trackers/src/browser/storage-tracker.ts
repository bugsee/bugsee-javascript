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
//
// SINGLETON per key object (see `storageTrackerFor`). RETENTION rule — what survives the last unsubscribe:
//   * the LAST estimate (`current()` keeps answering with it, so a later subscriber gets a value immediately, and a
//     failed poll never erases it). It may be stale: every activation polls again and emits the fresh value.
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
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

// The global timers, reached through a cast (this package's tsconfig has no DOM/Node lib).
const globalTimers = globalThis as unknown as StorageTimers;
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
  #running = false;
  /** Present only while the slow timer is armed (the handle itself may be any value, even undefined). */
  #timer: { handle: unknown } | undefined;
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
   * it). While IDLE every defined seam replaces ours (an undefined one never clobbers); while RUNNING the bindings
   * the tracker is attached to are kept (only `onError` changes) and the new ones apply from the next activation.
   */
  rebind(env: StorageEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    if (this.#running) return;
    this.#env = {
      ...pick(env.navigator, this.#env.navigator, 'navigator'),
      ...pick(env.document, this.#env.document, 'document'),
      ...pick(env.scheduler, this.#env.scheduler, 'scheduler'),
      ...pick(env.intervalMs, this.#env.intervalMs, 'intervalMs'),
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

  /** Test/teardown: forget the estimate, release timer and listener, and ignore anything in flight. */
  reset(): void {
    this.#epoch += 1;
    this.#running = false;
    this.#release();
    this.#estimate = undefined;
  }

  protected onActivate(): void {
    // Nothing to poll (insecure context / no Storage API): stay inert — no timer, no listener. The next activation looks again.
    if (this.#storage() === undefined) return;
    this.#running = true;
    this.#attachVisibility();
    this.#arm();
    this.#poll();
  }

  protected override onDeactivate(): void {
    this.#running = false;
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
        ) === 'visible'
      ) {
        this.#poll();
      }
    };
    // Recorded BEFORE attaching so a failure still detaches exactly this (removing a never-added one is a no-op).
    this.#visibility = { document, listener };
    try {
      document.addEventListener?.('visibilitychange', listener);
    } catch (error) {
      this.#onError(error);
    }
  }

  #arm(): void {
    try {
      const handle = (this.#env.scheduler ?? defaultTimers).setInterval(() => {
        // Sparse on purpose: a hidden page is not polled (visibility->visible polls on return).
        if (
          hostRead(
            () => this.#env.document?.visibilityState,
            (e) => this.#onError(e),
          ) !== 'hidden'
        ) {
          this.#poll();
        }
      }, this.#env.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.#timer = { handle };
    } catch (error) {
      this.#onError(error);
    }
  }

  /** Timer + visibility listener, best-effort. */
  #release(): void {
    const timer = this.#timer;
    this.#timer = undefined;
    if (timer !== undefined) {
      try {
        (this.#env.scheduler ?? defaultTimers).clearInterval(timer.handle);
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
    const ask = <T>(call: () => Promise<T> | undefined): Promise<T | undefined> => {
      try {
        const pending = call();
        return pending === undefined
          ? Promise.resolve(undefined)
          : pending.then(
              (value) => value,
              (error: unknown) => {
                this.#onError(error);
                return undefined;
              },
            );
      } catch (error) {
        this.#onError(error);
        return Promise.resolve(undefined);
      }
    };
    void Promise.all([ask(() => storage.estimate?.()), ask(() => storage.persisted?.())]).then(
      ([raw, persisted]) => {
        if (this.#epoch !== mine) return; // stopped, reset or superseded while in flight
        this.#publish(raw, persisted); // every host read inside is guarded; listener fan-out is failure-isolated
      },
    );
  }

  #publish(raw: { usage?: unknown; quota?: unknown } | undefined, persisted: unknown): void {
    const report = (e: unknown): void => this.#onError(e);
    const usageBytes = bytes(hostRead(() => raw?.usage, report));
    const quotaBytes = bytes(hostRead(() => raw?.quota, report));
    const estimate: StorageEstimate = {
      ...(usageBytes !== undefined ? { usageBytes } : {}),
      ...(quotaBytes !== undefined ? { quotaBytes } : {}),
      ...(typeof persisted === 'boolean' ? { persisted } : {}),
    };
    // Nothing usable (both calls failed/unsupported): keep the retained estimate, emit nothing.
    if (Object.keys(estimate).length === 0) return;
    this.#estimate = estimate;
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
