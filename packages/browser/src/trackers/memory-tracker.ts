import { InterceptorBase, type Scheduler } from '@bugsee/core';

// Browser JS-heap TRACKER (mirrors the mobile tracker/producer split): owns the one poll timer over
// `performance.memory` (Chromium-only). It starts the timer on the first subscriber and clears it on the
// last, so a page that is not capturing pays nothing; where the engine cannot answer it never starts a
// timer at all. `performance.memory` has no change event, so polling is the only way to see it.

/** The heap figures the traces need. `limit` is the heap CEILING (jsHeapSizeLimit), not what is committed. */
export interface MemoryState {
  used: number;
  limit: number;
}
export interface MemoryReading {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}
export interface MemoryTrackerDeps {
  /** Reads performance.memory live; undefined = this engine has none. */
  memory?: () => MemoryReading | undefined;
  scheduler?: Scheduler;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

const defaultScheduler: Scheduler = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class MemoryTracker extends InterceptorBase<{ memory: MemoryState }> {
  readonly name = 'browser-memory';
  readonly #read: (() => MemoryReading | undefined) | undefined;
  readonly #scheduler: Scheduler;
  readonly #intervalMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  #timer: unknown = null;

  constructor(deps: MemoryTrackerDeps = {}) {
    super(deps.onError);
    this.#read = deps.memory;
    this.#scheduler = deps.scheduler ?? defaultScheduler;
    this.#intervalMs = deps.intervalMs ?? 1000;
    this.#onError = deps.onError;
  }

  /** The live heap reading, or undefined when the engine has none (or the read threw). */
  current(): MemoryState | undefined {
    try {
      const m = this.#read?.();
      return m === undefined ? undefined : { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit };
    } catch (error) {
      this.#onError?.(error);
      return undefined;
    }
  }

  protected onActivate(): void {
    // An engine that answers `undefined` has no performance.memory: never start a timer. A read that
    // THROWS is a transient failure, not absence — it is reported and polling still starts, so the next
    // tick can recover.
    let supported = true;
    try {
      supported = this.#read?.() !== undefined;
    } catch (error) {
      this.#onError?.(error);
    }
    if (!supported) return;
    // A handle still held here means the last release threw, so that timer may still be live. Retry the
    // release; if it fails again, keep polling on that timer rather than arm a second one (duplicate rows).
    if (this.#timer !== null && !this.#release()) return;
    // Guarded like the other trackers: the subscriber is already registered, so a throwing scheduler must
    // be reported here, not leak out of on() and strand an "active" tracker with a leaked listener.
    try {
      this.#timer = this.#scheduler.setInterval(() => this.#poll(), this.#intervalMs);
    } catch (error) {
      this.#onError?.(error);
    }
  }

  protected override onDeactivate(): void {
    this.#release();
  }

  /** Clears the timer. The handle is dropped only once the clear succeeded; a failure is reported and kept. */
  #release(): boolean {
    if (this.#timer === null) return true;
    try {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = null;
      return true;
    } catch (error) {
      this.#onError?.(error);
      return false;
    }
  }

  #poll(): void {
    const state = this.current();
    if (state !== undefined) this.emit('memory', state);
  }
}
