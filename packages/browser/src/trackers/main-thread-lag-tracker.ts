import { InterceptorBase, type Scheduler } from '@bugsee/core';
import type { PageLifecycleTracker } from './page-lifecycle-tracker';

// Browser main-thread responsiveness TRACKER (`main_thread_lag_ms`): the delay between posting a message on a
// `MessageChannel` and receiving it back on the same thread, i.e. how long a fresh task waited behind whatever
// the main thread was doing. `MessageChannel`, not `setTimeout(0)`: timers are clamped to 4 ms.
//
// Measured ONLY while the page is visible (the same rule as `fps`). A hidden tab clamps timers and message
// delivery to ~1 s and then ~1 min, so a hidden round-trip measures the browser's throttling and would paint a
// hang that never happened. On hidden the run is torn down — the in-flight ping is aborted, the last delta is
// CLEARED, nothing re-arms — and a fresh run starts on visible, reporting nothing until a ping that started AND
// completed inside it lands. While visible the ping RE-ARMS on every receipt (a one-shot ping would freeze one
// number for the whole session) and the latest delta is emitted once per sampling tick. No delta yet, no
// MessageChannel, no clock, no lifecycle, or hidden: emit NOTHING — omit, never zero.

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
    this.#lastDelta = undefined;
    try {
      const Channel = this.#env.MessageChannel as new () => MessageChannelLike;
      const channel = new Channel();
      this.#channel = channel;
      this.#arm(channel, this.#run);
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

  // Posts one ping and installs the receipt handler that stores the delta and re-arms. Throws on a failing
  // clock/channel: `#startRun` rolls back on it, the receipt handler reports it.
  #arm(channel: MessageChannelLike, run: number): void {
    const now = this.#env.now as () => number;
    const startedAt = now();
    channel.port1.onmessage = () => {
      if (run !== this.#run) return; // `#stopRun` bumps the generation: a dead run's receipt is dropped
      try {
        const delta = now() - startedAt;
        if (Number.isFinite(delta) && delta >= 0) this.#lastDelta = delta;
        this.#arm(channel, run);
      } catch (error) {
        this.#lastDelta = undefined; // an unreadable clock/channel must not leave a frozen number behind
        this.#report(error);
      }
    };
    channel.port2.postMessage(undefined);
  }

  #tick(): void {
    if (this.#lastDelta !== undefined) this.emit('lag', this.#lastDelta);
  }
}
