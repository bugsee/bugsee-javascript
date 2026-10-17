import { InterceptorBase, type Scheduler } from '@bugsee/core';
import type { PageLifecycleTracker } from './page-lifecycle-tracker';

// Browser frame-rate TRACKER (Android `fps` parity): counts `requestAnimationFrame` callbacks and reports
// frames/second once per window. It runs ONLY while the page is visible — a hidden tab gets no animation
// frames, and a permanent rAF loop there would burn battery and keep the page awake — so the loop and the
// timer are torn down on `hidden` and a fresh window starts on `visible` (a long hidden stretch must never
// leak into the next window). Hidden, unmeasurable, or without rAF it emits NOTHING: omit, never zero.
// A visible page that produced no frames reports a true 0 (the main thread really did not paint).

export interface FpsEnv {
  /** Shared lifecycle tracker for visibility changes. */
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
  /** Visibility is read here at activation; unknown (absent) counts as not visible. */
  document?: { readonly visibilityState?: string };
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /** Monotonic ms. Default `performance.now()`. */
  now?: () => number;
  scheduler?: Scheduler;
  intervalMs?: number;
}

const defaultScheduler: Scheduler = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

// `performance.now()` where it exists (monotonic), else the wall clock: a window is a few hundred ms to seconds,
// so a clock step is the lesser evil next to reporting nothing.
const defaultNow = (): number =>
  typeof performance?.now === 'function' ? performance.now() : Date.now();

export class FpsTracker extends InterceptorBase<{ fps: number }> {
  readonly name = 'browser-fps';
  readonly #env: FpsEnv;
  readonly #report: (error: unknown) => void;
  readonly #scheduler: Scheduler;
  readonly #now: () => number;
  #subscription: (() => void) | undefined;
  #timer: unknown = null;
  #raf: number | undefined;
  #running = false;
  #frames = 0;
  #windowStart = 0;

  constructor(env: FpsEnv, onError?: (error: unknown) => void) {
    // A throwing reporter must not escape into the host's frame/timer dispatch.
    const report = (error: unknown): void => {
      try {
        onError?.(error);
      } catch {
        /* the reporter itself failed; nothing left to tell */
      }
    };
    super(report);
    this.#env = env;
    this.#report = report;
    this.#scheduler = env.scheduler ?? defaultScheduler;
    this.#now = env.now ?? defaultNow;
  }

  // Guarded: the tracker is already marked active before this runs, so a throwing environment must be
  // reported here rather than leak out of `on()`.
  protected onActivate(): void {
    if (typeof this.#env.requestAnimationFrame !== 'function') return; // no frames to count: omit
    try {
      this.#subscription = this.#env.lifecycle?.on('visibility', ({ visible }) =>
        visible ? this.#startLoop() : this.#stopLoop(),
      );
      if (this.#isVisible()) this.#startLoop();
    } catch (error) {
      this.#report(error);
    }
  }

  protected override onDeactivate(): void {
    this.#subscription?.();
    this.#stopLoop();
  }

  #isVisible(): boolean {
    try {
      return this.#env.document?.visibilityState === 'visible';
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  #startLoop(): void {
    if (this.#running) return;
    this.#running = true;
    this.#frames = 0;
    this.#windowStart = this.#now();
    try {
      this.#arm();
      this.#timer = this.#scheduler.setInterval(() => this.#tick(), this.#env.intervalMs ?? 1000);
    } catch (error) {
      this.#report(error);
      this.#stopLoop(); // never leave a half-started loop behind
    }
  }

  #stopLoop(): void {
    this.#running = false;
    if (this.#timer !== null) this.#scheduler.clearInterval(this.#timer);
    this.#timer = null;
    const raf = this.#raf;
    this.#raf = undefined;
    if (raf !== undefined) {
      try {
        this.#env.cancelAnimationFrame?.(raf);
      } catch {
        /* best-effort */
      }
    }
  }

  #arm(): void {
    this.#raf = this.#env.requestAnimationFrame?.(() => {
      if (!this.#running) return; // a frame already in flight when the loop stopped
      this.#frames += 1;
      try {
        this.#arm();
      } catch (error) {
        this.#report(error);
      }
    });
  }

  #tick(): void {
    const now = this.#now();
    const elapsed = now - this.#windowStart;
    if (!(elapsed > 0)) return; // a zero-length window has no rate
    const fps = Math.round(((this.#frames * 1000) / elapsed) * 10) / 10;
    this.#frames = 0;
    this.#windowStart = now;
    this.emit('fps', fps); // the emitter isolates and reports a throwing consumer
  }
}
