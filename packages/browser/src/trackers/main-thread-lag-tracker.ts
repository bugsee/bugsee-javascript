import { InterceptorBase, type Scheduler } from '@bugsee/core';
import type { PageLifecycleTracker } from './page-lifecycle-tracker';

// Browser main-thread responsiveness TRACKER (`main_thread_lag_ms`): the delay between posting a message on a
// `MessageChannel` and receiving it back on the same thread, i.e. how long a fresh task waited behind whatever
// the main thread was doing. `MessageChannel`, not `setTimeout(0)`: timers are clamped to 4 ms.
//
// ONE ping per sampling tick, never a loop. A receipt must NOT post again: re-arming on receipt is a continuous
// task loop (a whole core, starved idle callbacks) and it also overwrites a long-task delta with a ~0 one a few
// microseconds later. Instead each tick, while visible:
//   - no ping in flight: emit the delta the last receipt stored (if any, consumed), then post ONE new ping;
//   - ping STILL in flight (the thread has been blocked since the last tick): post nothing and emit its age,
//     `now - startedAt`, a lower bound on the lag, so a freeze is visible while it is happening. The completed
//     delta is emitted on the following tick (the same stall is thus reported twice: its floor, then its size).
// Measured ONLY while the page is visible (the same rule as `fps`). A hidden tab clamps timers and message
// delivery to ~1 s and then ~1 min, so a hidden round-trip measures the browser's throttling and would paint a
// hang that never happened. On hidden the run is torn down — the in-flight ping is aborted, the delta CLEARED —
// and a fresh run starts on visible. A failed post or clock is reported, clears the delta, and the next tick
// retries. No MessageChannel, no clock, no lifecycle, or hidden: emit NOTHING — omit, never zero.

export interface MessageChannelLike {
  port1: { onmessage: ((event: unknown) => void) | null; close(): void };
  port2: { postMessage(message: unknown): void; close(): void };
}

export interface MainThreadLagEnv {
  /** Shared lifecycle tracker for visibility changes. */
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
  /** Visibility is read here at activation; unknown (absent) counts as not visible. */
  document?: { readonly visibilityState?: string };
  /** The INJECTED window's `MessageChannel` constructor; absent omits the trace. */
  MessageChannel?: new () => MessageChannelLike;
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
  #subscription: (() => void) | undefined;
  #timer: unknown = null;
  #channel: MessageChannelLike | undefined;
  #running = false;
  #lastDelta: number | undefined;
  #inFlight = false;
  #startedAt = 0;
  #run = 0;

  constructor(env: MainThreadLagEnv, onError?: (error: unknown) => void) {
    // A throwing reporter must not escape into the host's message/timer dispatch.
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
  }

  // Guarded: the tracker is already marked active before this runs, so a throwing environment must be
  // reported here rather than leak out of `on()`.
  protected onActivate(): void {
    // Nothing to ping with, nothing to time it with, or no visibility events to gate on (a hidden tab must
    // never keep a ping loop): omit.
    if (
      typeof this.#env.MessageChannel !== 'function' ||
      typeof this.#env.now !== 'function' ||
      this.#env.lifecycle === undefined
    )
      return;
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
      const Channel = this.#env.MessageChannel as new () => MessageChannelLike;
      const channel = new Channel();
      this.#channel = channel;
      const run = this.#run;
      channel.port1.onmessage = () => this.#onReceipt(run);
      this.#ping(channel);
      this.#timer = this.#scheduler.setInterval(() => this.#tick(), this.#env.intervalMs ?? 1000);
    } catch (error) {
      this.#report(error);
      this.#stopRun(); // never leave a half-started run (or its channel) behind
    }
  }

  #stopRun(): void {
    this.#running = false;
    this.#run += 1; // a receipt still in flight belongs to a dead run and must never write
    this.#lastDelta = undefined; // a hidden stretch must not leave a stale number to be re-emitted
    if (this.#timer !== null) this.#scheduler.clearInterval(this.#timer);
    this.#timer = null;
    const channel = this.#channel;
    this.#channel = undefined;
    if (channel === undefined) return;
    channel.port1.onmessage = null;
    for (const port of [channel.port1, channel.port2]) {
      try {
        port.close();
      } catch {
        /* best-effort */
      }
    }
  }

  // Posts ONE ping. `#inFlight` is set before the post so a synchronous delivery is still seen as a receipt;
  // a failed post un-sets it and throws (`#startRun` rolls back on it, `#tick` reports it).
  #ping(channel: MessageChannelLike): void {
    this.#startedAt = (this.#env.now as () => number)();
    this.#inFlight = true;
    try {
      channel.port2.postMessage(undefined);
    } catch (error) {
      this.#inFlight = false;
      throw error;
    }
  }

  #onReceipt(run: number): void {
    if (run !== this.#run) return; // `#stopRun` bumps the generation: a dead run's receipt is dropped
    this.#inFlight = false;
    try {
      const delta = (this.#env.now as () => number)() - this.#startedAt;
      if (Number.isFinite(delta) && delta >= 0) this.#lastDelta = delta;
    } catch (error) {
      this.#lastDelta = undefined;
      this.#report(error);
    }
  }

  #tick(): void {
    const channel = this.#channel;
    if (channel === undefined) return;
    try {
      if (this.#inFlight) {
        // Blocked since the last tick: its age so far is the (lower-bound) lag. No second ping.
        const age = (this.#env.now as () => number)() - this.#startedAt;
        if (Number.isFinite(age) && age >= 0) this.emit('lag', age);
        return;
      }
      const delta = this.#lastDelta;
      this.#lastDelta = undefined;
      if (delta !== undefined) this.emit('lag', delta);
      this.#ping(channel);
    } catch (error) {
      this.#report(error); // nothing stale to clear: the delta was consumed above, or a ping is in flight
    }
  }
}
