import { InterceptorBase, type Scheduler } from '@bugsee/core';
import type { PageLifecycleTracker } from './page-lifecycle-tracker';

// Browser main-thread responsiveness TRACKER (`main_thread_lag_ms`): TIMER DRIFT, the classic event-loop-lag
// technique (the same one Node's monitor uses). The sampling timer runs on the page's main thread, so on every
// tick `lag = max(0, now - (previousTickTime + intervalMs))` is how late it fired: a long task, a layout storm
// or a synchronous block delays the next tick by exactly its length. The first tick compares against the run's
// start time + interval. A measured ~0 is a TRUE measurement and is emitted every tick.
//
// Why not a MessageChannel ping: a ping only sees a block that begins while it is in flight, so most real
// freezes read ~0.1 ms (measured in Chromium), and a tick that runs on the same thread never sees a ping
// "still in flight". Timer drift sees every block that spans a tick.
//
// Honest limit: it measures how late the sampling timer fires. That includes real jank, and ALSO timer
// throttling the browser applies while the page still says `visible` (an occluded or minimised window, or a
// background tab that never fired `visibilitychange`); such a stretch reads as lag even though nothing in the
// page was slow.
//
// Measured ONLY while the page is visible (the same rule as `fps`). A hidden tab throttles timers to ~1 s then
// ~1 min, which would paint a hang that never happened, so the timer is torn down on hidden and every visible
// start takes a FRESH baseline: a hidden stretch can never count as lag. No clock, no lifecycle, or hidden:
// emit NOTHING.

export interface MainThreadLagEnv {
  /** Shared lifecycle tracker for visibility changes. */
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
  /** Visibility is read here at activation; unknown (absent) counts as not visible. */
  document?: { readonly visibilityState?: string };
  /** Monotonic ms (the injected `performance.now`); absent omits the trace — no wall-clock guess. */
  now?: () => number;
  scheduler?: Scheduler;
  intervalMs?: number;
}

const defaultScheduler: Scheduler = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class MainThreadLagTracker extends InterceptorBase<{ lag: number }> {
  readonly name = 'browser-main-thread-lag';
  readonly #env: MainThreadLagEnv;
  readonly #report: (error: unknown) => void;
  readonly #scheduler: Scheduler;
  readonly #interval: number;
  #subscription: (() => void) | undefined;
  #timer: unknown = null;
  #running = false;
  /** When the next tick is due: previous tick time + interval (the run's start + interval before the first). */
  #expectedAt = 0;

  constructor(env: MainThreadLagEnv, onError?: (error: unknown) => void) {
    // A throwing reporter must not escape into the host's timer dispatch.
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
    this.#interval = env.intervalMs ?? 1000;
  }

  // Guarded: the tracker is already marked active before this runs, so a throwing environment must be
  // reported here rather than leak out of `on()`.
  protected onActivate(): void {
    // No clock to time it with, or no visibility events to gate on (a hidden tab must never keep a timer): omit.
    if (typeof this.#env.now !== 'function' || this.#env.lifecycle === undefined) return;
    try {
      this.#subscription = this.#env.lifecycle.on('visibility', ({ visible }) =>
        visible ? this.#startRun() : this.#stopRun(),
      );
      if (this.#isVisible()) this.#startRun();
    } catch (error) {
      this.#report(error);
    }
  }

  protected override onDeactivate(): void {
    this.#subscription?.();
    this.#subscription = undefined;
    this.#stopRun();
  }

  #isVisible(): boolean {
    try {
      return this.#env.document?.visibilityState === 'visible';
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  #startRun(): void {
    if (this.#running) return;
    this.#running = true;
    try {
      // The clock read is inside the guarded setup: a throwing clock rolls the run back like any other setup
      // failure, or `#running` would stay true with no timer and block every later start.
      this.#expectedAt = (this.#env.now as () => number)() + this.#interval; // a FRESH baseline every run
      this.#timer = this.#scheduler.setInterval(() => this.#tick(), this.#interval);
    } catch (error) {
      this.#report(error);
      this.#stopRun(); // never leave a half-started run behind
    }
  }

  #stopRun(): void {
    this.#running = false;
    if (this.#timer !== null) this.#scheduler.clearInterval(this.#timer);
    this.#timer = null;
  }

  #tick(): void {
    if (!this.#running) return;
    let now: number;
    try {
      now = (this.#env.now as () => number)();
    } catch (error) {
      this.#report(error); // an unreadable clock skips this tick; it runs inside the host's timer dispatch
      this.#expectedAt += this.#interval; // the skipped interval must not read as lag on the next tick
      return;
    }
    if (!Number.isFinite(now)) {
      this.#expectedAt += this.#interval;
      return;
    }
    const lag = Math.max(0, now - this.#expectedAt); // fired early (a hair) is on time, not negative lag
    this.#expectedAt = now + this.#interval;
    this.emit('lag', lag);
  }
}
