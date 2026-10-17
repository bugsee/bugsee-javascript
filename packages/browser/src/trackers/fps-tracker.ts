import { InterceptorBase, type Scheduler } from '@bugsee/core';
import type { PageLifecycleTracker } from './page-lifecycle-tracker';

// Browser frame-rate TRACKER (Android `fps` parity): counts `requestAnimationFrame` callbacks and reports
// frames/second once per window. It runs ONLY while the page is visible — a hidden tab gets no animation
// frames, and a permanent rAF loop there would burn battery and keep the page awake — so the loop and the
// timer are torn down on `hidden` and a fresh window starts on `visible` (a long hidden stretch must never
// leak into the next window). Hidden, unmeasurable, or without rAF it emits NOTHING: omit, never zero.
// Once frames have flowed, the first window without any is reported as 0 (the main thread stopped painting) and a
// continuing stall then goes quiet; before the first frame nothing is reported. rAF can be paused while the page
// still says `visible`, so a run of zeros would be invented.

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
const defaultNow = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
};

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
  #seenFrame = false;
  #windowStart = 0;
  #loop = 0;

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
    // No frames to count, or no visibility events to gate on (a hidden tab must never keep a frame loop): omit.
    if (typeof this.#env.requestAnimationFrame !== 'function' || this.#env.lifecycle === undefined)
      return;
    try {
      this.#subscription = this.#env.lifecycle.on('visibility', ({ visible }) =>
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
    this.#loop += 1;
    this.#seenFrame = false;
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
    const loop = this.#loop;
    this.#raf = this.#env.requestAnimationFrame?.(() => {
      // A frame already in flight when its loop stopped (cancelAnimationFrame missing or failed) must not count
      // or re-arm — not even after a restart, or two loops would run and fps would read double.
      if (!this.#running || loop !== this.#loop) return;
      this.#seenFrame = true;
      this.#frames += 1;
      try {
        this.#arm();
      } catch (error) {
        this.#report(error);
      }
    });
  }

  #tick(): void {
    let now: number;
    try {
      now = this.#now();
    } catch (error) {
      this.#report(error); // an unreadable clock skips this window; it runs inside the host's timer dispatch
      return;
    }
    const elapsed = now - this.#windowStart;
    if (!(elapsed > 0)) return; // a zero-length window has no rate
    // No frame EVER in this run: rAF may be paused while the page still reports `visible` (an offscreen
    // cross-origin iframe, an occluded window), so a 0 would be invented. Once frames have flowed, 0 is true.
    if (!this.#seenFrame) {
      this.#windowStart = now; // the stalled stretch must not dilute the first measured window
      return;
    }
    const fps = Math.round(((this.#frames * 1000) / elapsed) * 10) / 10;
    // A window with no frames after frames had flowed is reported (the drop to 0) ONCE; rAF can also be paused
    // while the page still says `visible`, so a continuing stall goes quiet instead of a run of fabricated zeros.
    if (this.#frames === 0) this.#seenFrame = false;
    this.#frames = 0;
    this.#windowStart = now;
    this.emit('fps', fps); // the emitter isolates and reports a throwing consumer
  }
}
