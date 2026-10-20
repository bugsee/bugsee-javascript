import { InterceptorBase } from '../interceptor-base';
import { createTrackerRegistry } from '../tracker-registry';
import type { ApplicationTracker } from './application-tracker';
import { hostRead } from './host-read';

// Browser PROCESS tracker (domain tracker, design §15.2/§15.3 item 4; Android reference: BugseeTrackerProcess). It
// owns everything the page can say about its own process, as FIVE independent stages:
//
//   heap          `performance.memory` (Chromium-only)            -> { used, limit } bytes, polled every tick.
//   mainThreadLag TIMER DRIFT (see below)                         -> { lagMs }, every tick, visible pages only.
//   idle          JS main-thread idle, `requestIdleCallback`      -> { idleMs } (0..50), visible pages only.
//   userIdle      Idle Detection API (`IdleDetector`)             -> { userState, screenState? }, on change.
//   uptime        `performance.now()` (ms since the time origin)  -> { uptimeMs }, every tick.
//
// PER-STAGE ACTIVATION. Nothing runs at construction. A stage's timer/listener/detector exists only while THAT stage
// has a listener (`listenerCount`, re-evaluated after every listener mutation via `onListenersChanged`); an `onAny`
// listener counts for every stage. `start()`/`stop()` (InterceptorBase) therefore do nothing here. A stage that cannot
// work in this environment (no `performance.memory`, no `requestIdleCallback`, no clock, no lifecycle, no permission)
// stays INERT: no timer, no emission, and it is looked at again only after its listeners have all left and a new one
// arrives (or after a `rebind` changes the seams). Absent data is ABSENCE: a value that is not a finite non-negative
// number is omitted, never sent as 0.
//
// SINGLETON per key object (see `processTrackerFor`). RETENTION rule — what survives a stage's last unsubscribe:
//   * the last `userIdle` state (`currentUserIdle()`, a plain retained read; dropped from the tracker when the
//     permission is found NOT granted by a RUNNING stage — a revoke while NO stage is armed is only noticed on the
//     next activation's async re-query). `currentUserIdleFresh()` (the seed for a held trace) is stricter: while the
//     stage is armed it answers only once THIS run's detector has published (permission re-confirmed; no age bound, a
//     live detector reports changes only), and undefined while that re-query or the detector's start() is pending, or after a refusal/revoke;
//     with no armed stage it hands the state out only while younger than 2 detector thresholds. KNOWN LIMIT (owner decision pending, docs/PROGRESS.md TR5): the tracker emits nothing on
//     revoke, and a HELD trace cannot be retracted, so a consumer that already published the last value keeps
//     re-recording it until its producer stops; the drop above only stops the tracker serving it to NEW seeds, and
//   * the heap is read live (`currentHeap()`), uptime/idle/lag keep nothing: a stale idle figure or drift baseline
//     would be a lie, so every run starts FRESH.
// What does NOT survive: timers, the lifecycle subscription, the pending idle probe, the IdleDetector and its abort
// controller. Every async continuation (idle callback, permission query, `IdleDetector.start()`) is guarded by the
// run it belongs to and is inert once that run is torn down; every timer callback is guarded the same way, so a timer
// whose clear failed can never emit.
//
// `mainThreadLag` — TIMER DRIFT. The sampling timer runs on the page's main thread, so on every tick
// `lag = max(0, now - (previousTickTime + intervalMs))` is how late it fired. The first tick compares against the
// run's start time + interval. Measured in Chromium: a tick fires late by (block END - the first due time the block
// covered). A block B >= 1 s reads between B - 1000 and B; a block SHORTER than 1 s that crosses no due tick reads 0
// (chance ~ 1 - B/1000); one block is reported once (the next tick measures from the late tick and clamps to 0).
// This is NOT Node's ~10 ms event-loop monitor. A MessageChannel ping was built and rejected: it misses real freezes.
// Measured ONLY while the page is visible: a hidden tab throttles timers, which would paint a hang that never
// happened, so the run is torn down on hidden and every visible start takes a FRESH baseline. No clock, no lifecycle,
// or hidden: emit NOTHING.
//
// `idle` — ONE `requestIdleCallback` probe per sampling tick, never a loop and never more than one in flight (a tick
// that finds the previous probe still pending queues nothing). When the browser grants the callback, the value is
// `deadline.timeRemaining()` clamped to <= 50 ms (the spec's cap). A busy page whose callback has not run yet
// produces NO sample for that tick (absence, not 0). Absent where `requestIdleCallback` is (Safari).
//
// `userIdle` — the SDK MUST NEVER prompt. `IdleDetector.requestPermission()` is never called; the detector is
// started ONLY when `navigator.permissions.query({name:'idle-detection'})` ALREADY reports `granted` (Chromium; an
// engine that does not know the permission name rejects, which just leaves the stage inert). The permission is
// re-queried on every activation and watched via its `change` event (granted later -> starts, revoked -> aborts).
// The threshold is >= 60 s (the spec's minimum). Stopping aborts the detector through its AbortController.

export interface HeapReading {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}
/** The heap figures the traces need. `limit` is the heap CEILING (jsHeapSizeLimit), not what is committed. */
export interface HeapState {
  used: number;
  limit: number;
}
export interface UserIdleState {
  userState: 'active' | 'idle';
  /** Omitted when the detector reports something other than `locked`/`unlocked`. */
  screenState?: 'locked' | 'unlocked';
}
export interface ProcessEvents {
  heap: HeapState;
  mainThreadLag: { lagMs: number };
  /** 0..50 ms, `requestIdleCallback`'s `timeRemaining()`. */
  idle: { idleMs: number };
  userIdle: UserIdleState;
  uptime: { uptimeMs: number };
}
type Stage = keyof ProcessEvents;
const STAGES: readonly Stage[] = ['heap', 'mainThreadLag', 'idle', 'userIdle', 'uptime'];

export interface ProcessTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export interface IdleDeadlineLike {
  timeRemaining(): number;
}
export interface IdleDetectorLike {
  readonly userState?: unknown;
  readonly screenState?: unknown;
  start(options: { threshold: number; signal: unknown }): Promise<unknown>;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
export interface PermissionStatusLike {
  readonly state?: unknown;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
export interface AbortControllerLike {
  readonly signal: unknown;
  abort(): void;
}

/** What the tracker needs from a launch. Every member is optional; an absent one disables the stages that need it. */
export interface ProcessEnv {
  /** `performance.memory` (heap) and `performance.now()` (lag, uptime), read live. */
  performance?: { readonly memory?: HeapReading; now?(): number };
  /** Visibility is read here when a gated stage starts; unknown counts as not visible. */
  document?: { readonly visibilityState?: string };
  /** Shared lifecycle tracker for visibility changes (gates `mainThreadLag` and `idle`). */
  lifecycle?: Pick<ApplicationTracker, 'on'>;
  /** Bound to its window by the caller. */
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void) => number;
  cancelIdleCallback?: (handle: number) => void;
  /** `navigator.permissions` (the SDK only ever QUERIES it). */
  navigator?: {
    readonly permissions?: {
      query?(descriptor: { name: string }): Promise<PermissionStatusLike>;
    };
  };
  /** The `IdleDetector` constructor (Chromium, secure context). `requestPermission` is never touched. */
  IdleDetector?: new () => IdleDetectorLike;
  AbortController?: new () => AbortControllerLike;
  /** Drives every polled stage; default the global timers. */
  scheduler?: ProcessTimers;
  /** Sampling period in ms (default 1000). */
  intervalMs?: number;
  /** Idle Detection threshold in ms; floored at the spec's 60 000 (default 60 000). */
  userIdleThresholdMs?: number;
  /** Wall-clock ms for the age of the retained user-idle state; default `Date.now`. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 1000;
/**
 * A retained user-idle state older than this many detector thresholds is not handed out as `currentUserIdleFresh()`
 * (the detector reports only CHANGES, so an old snapshot may have been overtaken by something we never saw).
 */
export const USER_IDLE_FRESH_THRESHOLDS = 2;
const defaultNow = (): number => Date.now();
/** The Idle Detection spec's minimum threshold. */
export const USER_IDLE_MIN_THRESHOLD_MS = 60_000;
/** requestIdleCallback's spec cap on a granted idle period. */
export const IDLE_PERIOD_CAP_MS = 50;

const globalTimers = globalThis as unknown as ProcessTimers;
const defaultTimers: ProcessTimers = {
  setInterval: (cb, ms) => globalTimers.setInterval(cb, ms),
  clearInterval: (h) => globalTimers.clearInterval(h),
};

const SEAM_KEYS = [
  'performance',
  'document',
  'lifecycle',
  'requestIdleCallback',
  'cancelIdleCallback',
  'navigator',
  'IdleDetector',
  'AbortController',
  'scheduler',
  'intervalMs',
  'userIdleThresholdMs',
  'now',
] as const satisfies readonly (keyof ProcessEnv)[];

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export class ProcessTracker extends InterceptorBase<ProcessEvents> {
  readonly name = 'browser-process';
  #env: ProcessEnv;
  /** Teardown of every stage that is armed (or waiting on its async setup). */
  readonly #running = new Map<Stage, () => void>();
  /** Stages that found themselves unable to run; they retry only after their listeners have all left. */
  readonly #inert = new Set<Stage>();
  /** Retained across deactivation (see the retention rule). */
  #userIdle: UserIdleState | undefined;
  /** The armed user-idle run (`published` once its detector has reported a reading this run). */
  #userIdleRun: { published: boolean } | undefined;
  /** When `#userIdle` was read; only meaningful while `#userIdle` is defined (always set together). */
  #userIdleAt: number | undefined;
  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => void) | undefined };

  constructor(env: ProcessEnv, onError?: (error: unknown) => void) {
    const report = { fn: onError };
    // A throwing reporter must not escape into the emitter's dispatch (which runs inside the host's timers/events).
    super((error) => {
      try {
        report.fn?.(error);
      } catch {
        /* the reporter itself failed */
      }
    });
    this.#report = report;
    this.#env = env;
  }

  /**
   * Hand the latest launch's seams to this shared tracker. A defined `onError` replaces the reporter (undefined keeps
   * it). Every defined seam REPLACES ours; an undefined one never clobbers an earlier one (merge, never drop). When
   * a seam actually changed, every armed stage is first detached with the seams it was ARMED with (their captured
   * timers/cancel functions/detector), then the merged seams are swapped in and the stages that still have listeners
   * start again against the new ones (fresh lag baseline, permission re-queried).
   */
  rebind(env: ProcessEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    const merged: Record<string, unknown> = {};
    let changed = false;
    for (const key of SEAM_KEYS) {
      const next = env[key] ?? this.#env[key];
      if (next !== undefined) merged[key] = next;
      if (next !== this.#env[key]) changed = true;
    }
    if (!changed) return;
    this.#stopAll(); // OLD seams (captured by each stage's teardown)
    this.#env = merged as ProcessEnv;
    this.#sync();
  }

  #onError(error: unknown): void {
    try {
      this.#report.fn?.(error);
    } catch {
      /* the reporter itself failed */
    }
  }

  /** The live heap reading, or undefined when the engine has none, the read threw, or a figure is unusable. */
  currentHeap(): HeapState | undefined {
    return this.#readHeap(this.#env);
  }

  /** Last Idle Detection state; retained after the last unsubscribe. Undefined until one is read. */
  currentUserIdle(): UserIdleState | undefined {
    return this.#userIdle;
  }

  /**
   * The retained user-idle state, but only while it is younger than {@link USER_IDLE_FRESH_THRESHOLDS} detector
   * thresholds (the threshold in force: the configured one, floored at the spec minimum). Undefined once older,
   * unknown, or when the clock cannot vouch for the age (unreadable, non-finite, or stepped backwards). For consumers
   * that publish the state as a HELD reading: a stale snapshot must not seed one.
   */
  currentUserIdleFresh(): UserIdleState | undefined {
    // The stage is armed: the state is trustworthy exactly once THIS run's detector has PUBLISHED (the permission was
    // re-confirmed and the detector's own start() settled with a reading). Until then the retained snapshot is from an
    // earlier run: the permission query / start() may still be pending (or refuse), and a revoke may have outdated it.
    // A published state does not age while its detector stays live: it reports changes only.
    const run = this.#userIdleRun;
    if (run !== undefined) return run.published ? this.#userIdle : undefined;
    const at = this.#userIdleAt;
    if (this.#userIdle === undefined || at === undefined) return undefined;
    let age: number;
    try {
      age = (this.#env.now ?? defaultNow)() - at;
    } catch (error) {
      this.#onError(error);
      return undefined;
    }
    const limit = USER_IDLE_FRESH_THRESHOLDS * this.#userIdleThreshold(this.#env);
    // NaN fails both comparisons, so a non-finite age is stale too
    return age >= 0 && age <= limit ? this.#userIdle : undefined;
  }

  #userIdleThreshold(env: ProcessEnv): number {
    const requested = env.userIdleThresholdMs;
    return usable(requested)
      ? Math.max(USER_IDLE_MIN_THRESHOLD_MS, requested)
      : USER_IDLE_MIN_THRESHOLD_MS;
  }

  /**
   * Test/teardown: drop EVERY listener (which releases every stage, and keeps a later listener change from re-arming
   * a stage for a subscriber that no longer exists) and forget the retained state.
   */
  reset(): void {
    this.removeAllListeners();
    this.#userIdle = undefined;
  }

  // Activation is per stage (onListenersChanged); the whole-tracker hook has nothing to do.
  protected onActivate(): void {}

  protected override onListenersChanged(): void {
    this.#sync();
  }

  #stopAll(): void {
    for (const stage of [...this.#running.keys()]) this.#stop(stage);
    this.#inert.clear();
  }

  #stop(stage: Stage): void {
    const teardown = this.#running.get(stage);
    this.#running.delete(stage);
    if (teardown === undefined) return;
    try {
      teardown();
    } catch (error) {
      this.#onError(error);
    }
  }

  #sync(): void {
    for (const stage of STAGES) {
      const wanted = this.listenerCount(stage) > 0;
      if (!wanted) {
        this.#stop(stage);
        this.#inert.delete(stage);
        continue;
      }
      if (this.#running.has(stage) || this.#inert.has(stage)) continue;
      let teardown: (() => void) | undefined;
      try {
        teardown = this.#start(stage, this.#env);
      } catch (error) {
        this.#onError(error);
      }
      if (teardown === undefined) this.#inert.add(stage);
      else this.#running.set(stage, teardown);
    }
  }

  #start(stage: Stage, env: ProcessEnv): (() => void) | undefined {
    switch (stage) {
      case 'heap':
        return this.#startHeap(env);
      case 'mainThreadLag':
        return this.#startLag(env);
      case 'idle':
        return this.#startIdle(env);
      case 'userIdle':
        return this.#startUserIdle(env);
      case 'uptime':
        return this.#startUptime(env);
    }
  }

  /** One polled run on the env's scheduler (captured, so the teardown clears with the SAME one). Ticks never throw. */
  #every(env: ProcessEnv, tick: () => void): () => void {
    const scheduler = env.scheduler ?? defaultTimers;
    let alive = true;
    const handle = scheduler.setInterval(() => {
      if (!alive) return; // a timer whose clear failed must stay silent
      try {
        tick();
      } catch (error) {
        this.#onError(error); // inside the host's timer dispatch: never throw
      }
    }, env.intervalMs ?? DEFAULT_INTERVAL_MS);
    return () => {
      alive = false;
      scheduler.clearInterval(handle);
    };
  }

  /**
   * Runs `begin` only while the page is visible: subscribes to the lifecycle's visibility, begins now when visible,
   * and tears the run down on hidden. The caller has checked that a lifecycle exists.
   */
  #gated(
    env: ProcessEnv,
    lifecycle: NonNullable<ProcessEnv['lifecycle']>,
    begin: () => () => void,
  ): () => void {
    let stop: (() => void) | undefined;
    const close = (): void => {
      const current = stop;
      stop = undefined;
      if (current === undefined) return;
      try {
        current();
      } catch (error) {
        this.#onError(error);
      }
    };
    const open = (): void => {
      if (stop !== undefined) return;
      try {
        stop = begin(); // a throwing setup rolls back: nothing half-started is left behind
      } catch (error) {
        this.#onError(error);
      }
    };
    const unsubscribe = lifecycle.on('visibility', ({ visible }) => (visible ? open() : close()));
    const visible = hostRead(
      () => env.document?.visibilityState,
      (error) => this.#onError(error),
    );
    if (visible === 'visible') open();
    return () => {
      try {
        unsubscribe();
      } finally {
        close(); // a throwing unsubscribe must never leave the run armed
      }
    };
  }

  // A SUCCESSFUL clock read is memoised per env object (re-reading a live getter on every stage start buys nothing).
  // A FAILED read is never cached, so the stage is looked at again on its next activation (the retry rule); a failure
  // that persists is reported once per env (until a read succeeds), not once per activation.
  readonly #clocks = new WeakMap<ProcessEnv, () => number>();
  readonly #clockFailing = new WeakSet<ProcessEnv>();

  #clockOf(env: ProcessEnv): (() => number) | undefined {
    const cached = this.#clocks.get(env);
    if (cached !== undefined) return cached;
    const report = (error: unknown): void => {
      if (!this.#clockFailing.has(env)) {
        this.#clockFailing.add(env);
        this.#onError(error);
      }
    };
    const perf = hostRead(() => env.performance, report);
    const now = perf === undefined ? undefined : hostRead(() => perf.now, report);
    if (typeof now !== 'function' || perf === undefined) return undefined;
    const clock = (): number => (perf.now as () => number)();
    this.#clocks.set(env, clock);
    return clock;
  }

  // ---- heap -------------------------------------------------------------------------------------------------------

  #readHeap(env: ProcessEnv): HeapState | undefined {
    const report = (error: unknown): void => this.#onError(error);
    const memory = hostRead(() => env.performance?.memory, report);
    if (memory === undefined || memory === null) return undefined;
    const used = hostRead(() => memory.usedJSHeapSize, report);
    const limit = hostRead(() => memory.jsHeapSizeLimit, report);
    return usable(used) && usable(limit) ? { used, limit } : undefined;
  }

  #startHeap(env: ProcessEnv): (() => void) | undefined {
    // An engine that answers nothing has no performance.memory: never start a timer. A READ that threw is a transient
    // failure, not absence: it was reported and polling still starts so the next tick can recover.
    let threw = false;
    const memory = hostRead(
      () => env.performance?.memory,
      (error) => {
        threw = true;
        this.#onError(error);
      },
    );
    if ((memory === undefined || memory === null) && !threw) return undefined;
    return this.#every(env, () => {
      const state = this.#readHeap(env);
      if (state !== undefined) this.emit('heap', state);
    });
  }

  // ---- uptime -----------------------------------------------------------------------------------------------------

  #startUptime(env: ProcessEnv): (() => void) | undefined {
    const now = this.#clockOf(env);
    if (now === undefined) return undefined;
    return this.#every(env, () => {
      const uptimeMs = now();
      if (usable(uptimeMs)) this.emit('uptime', { uptimeMs });
    });
  }

  // ---- mainThreadLag ----------------------------------------------------------------------------------------------

  #startLag(env: ProcessEnv): (() => void) | undefined {
    const now = this.#clockOf(env);
    const lifecycle = env.lifecycle;
    if (now === undefined || lifecycle === undefined) return undefined;
    const interval = env.intervalMs ?? DEFAULT_INTERVAL_MS;
    return this.#gated(env, lifecycle, () => {
      let expectedAt = now() + interval; // a FRESH baseline every run (non-finite = no baseline, see the tick)
      return this.#every(env, () => {
        let at: number;
        try {
          at = now();
        } catch (error) {
          this.#onError(error); // an unreadable clock skips this tick without reading the skipped interval as lag
          expectedAt += interval;
          return;
        }
        if (!Number.isFinite(at)) {
          expectedAt += interval;
          return;
        }
        const baseline = expectedAt;
        expectedAt = at + interval;
        // No finite baseline (the clock was unreadable at the run's start): this tick only establishes one. A lag
        // computed from it would be NaN, and an unknown lag is omitted, never sent.
        if (!Number.isFinite(baseline)) return;
        const lagMs = Math.max(0, at - baseline); // fired early (a hair) is on time, not negative lag
        this.emit('mainThreadLag', { lagMs });
      });
    });
  }

  // ---- idle -------------------------------------------------------------------------------------------------------

  #startIdle(env: ProcessEnv): (() => void) | undefined {
    const report = (error: unknown): void => this.#onError(error);
    const request = hostRead(() => env.requestIdleCallback, report);
    const lifecycle = env.lifecycle;
    if (typeof request !== 'function' || lifecycle === undefined) return undefined;
    const cancel = hostRead(() => env.cancelIdleCallback, report);
    return this.#gated(env, lifecycle, () => {
      let pending: { handle: number } | undefined;
      const stopTimer = this.#every(env, () => {
        if (pending !== undefined) return; // one probe in flight at most: never a pile-up or a loop
        const mine: { handle: number } = { handle: 0 };
        pending = mine;
        try {
          mine.handle = request((deadline) => {
            if (pending !== mine) return; // torn down (or replaced) while waiting
            pending = undefined;
            try {
              const remaining = deadline.timeRemaining();
              if (usable(remaining)) {
                this.emit('idle', { idleMs: Math.min(IDLE_PERIOD_CAP_MS, remaining) });
              }
            } catch (error) {
              this.#onError(error); // inside the browser's idle dispatch
            }
          });
        } catch (error) {
          pending = undefined;
          throw error; // reported by the tick guard
        }
      });
      return () => {
        const outstanding = pending;
        pending = undefined;
        try {
          stopTimer();
        } finally {
          if (outstanding !== undefined && typeof cancel === 'function') {
            try {
              cancel(outstanding.handle);
            } catch (error) {
              this.#onError(error);
            }
          }
        }
      };
    });
  }

  // ---- userIdle ---------------------------------------------------------------------------------------------------

  /** Now, or undefined when the clock is unreadable (the state is then never "fresh"). */
  #stamp(env: ProcessEnv): number | undefined {
    try {
      return (env.now ?? defaultNow)();
    } catch (error) {
      this.#onError(error);
      return undefined;
    }
  }

  #startUserIdle(env: ProcessEnv): (() => void) | undefined {
    const report = (error: unknown): void => this.#onError(error);
    const nav = hostRead(() => env.navigator, report);
    const permissions = hostRead(() => nav?.permissions, report);
    const query = hostRead(() => permissions?.query, report);
    const Detector = hostRead(() => env.IdleDetector, report);
    const Abort = hostRead(() => env.AbortController, report);
    if (
      typeof query !== 'function' ||
      typeof Detector !== 'function' ||
      typeof Abort !== 'function'
    ) {
      return undefined;
    }
    const threshold = this.#userIdleThreshold(env);

    const run: {
      alive: boolean;
      detector?: IdleDetectorLike;
      controller?: AbortControllerLike;
      onChange?: () => void;
      detachPermission?: () => void;
      published: boolean;
    } = { alive: true, published: false };

    const publish = (detector: IdleDetectorLike): void => {
      const userState = hostRead(() => detector.userState, report);
      if (userState !== 'active' && userState !== 'idle') return; // nothing honest to say
      const screenState = hostRead(() => detector.screenState, report);
      const state: UserIdleState = {
        userState,
        ...(screenState === 'locked' || screenState === 'unlocked' ? { screenState } : {}),
      };
      run.published = true;
      this.#userIdle = state;
      this.#userIdleAt = this.#stamp(env);
      this.emit('userIdle', state);
    };

    const end = (): void => {
      const { detector, controller, onChange } = run;
      run.detector = undefined;
      run.controller = undefined;
      run.onChange = undefined;
      if (detector !== undefined && onChange !== undefined) {
        try {
          detector.removeEventListener?.('change', onChange);
        } catch {
          /* best-effort */
        }
      }
      try {
        controller?.abort();
      } catch (error) {
        report(error);
      }
    };

    const begin = (): void => {
      if (!run.alive || run.detector !== undefined) return;
      try {
        const controller = new Abort();
        const detector = new Detector();
        // publish() is total (every host read is guarded, emit() isolates listeners), so these callbacks cannot throw.
        const onChange = (): void => {
          if (run.detector === detector) publish(detector);
        };
        run.detector = detector;
        run.controller = controller;
        run.onChange = onChange;
        detector.addEventListener?.('change', onChange);
        detector.start({ threshold, signal: controller.signal }).then(
          () => {
            if (run.alive && run.detector === detector) publish(detector);
          },
          // Refused (policy blocked, aborted): the stage simply produces nothing; a later permission change retries.
          () => {
            if (run.detector === detector) end();
          },
        );
      } catch (error) {
        end();
        report(error);
      }
    };

    const decide = (status: PermissionStatusLike): void => {
      if (!run.alive) return;
      if (hostRead(() => status.state, report) === 'granted') {
        begin();
      } else {
        end(); // never granted, or revoked: stop, and do not keep serving a snapshot we may no longer read
        this.#userIdle = undefined;
      }
    };

    try {
      void Promise.resolve(query.call(permissions, { name: 'idle-detection' })).then(
        (status) => {
          if (!run.alive) return;
          try {
            const onPermission = (): void => decide(status);
            status.addEventListener?.('change', onPermission);
            run.detachPermission = () => status.removeEventListener?.('change', onPermission);
            decide(status);
          } catch (error) {
            report(error);
          }
        },
        () => {}, // the engine does not know the permission name (not Chromium): no user-idle trace
      );
    } catch {
      return undefined; // a synchronous throw from query() means the same
    }

    this.#userIdleRun = run; // only once the stage is really armed (a synchronous query() failure returns above)
    return () => {
      run.alive = false;
      if (this.#userIdleRun === run) this.#userIdleRun = undefined;
      end();
      const detach = run.detachPermission;
      run.detachPermission = undefined;
      try {
        detach?.();
      } catch {
        /* best-effort */
      }
    };
  }
}

const registry = createTrackerRegistry<ProcessTracker>();

/** A {@link ProcessEnv} plus the objects the singleton is keyed on. */
export interface ProcessTrackerEnv extends ProcessEnv {
  window?: object;
}

// The key is the window the SDK is bound to; failing that the performance object; failing that the env object itself
// (an ad-hoc env then gets a private tracker). Host reads are guarded AND reported.
function keyOf(env: ProcessTrackerEnv, onError?: (error: unknown) => void): object {
  const win = hostRead(() => env.window, onError);
  if (typeof win === 'object' && win !== null) return win;
  const perf = hostRead(() => env.performance, onError);
  if (typeof perf === 'object' && perf !== null) return perf;
  return env;
}

// Each seam is read ONCE through hostRead (a hostile env getter costs only that seam, reported).
function seamsOf(env: ProcessTrackerEnv, onError?: (error: unknown) => void): ProcessEnv {
  const seams: Record<string, unknown> = {};
  for (const key of SEAM_KEYS) {
    const value = hostRead(() => env[key], onError);
    if (value !== undefined) seams[key] = value;
  }
  return seams as ProcessEnv;
}

/**
 * The singleton ProcessTracker for the env's window. Every call (a relaunch included) hands the shared tracker the
 * latest launch's `onError` and seams (see {@link ProcessTracker.rebind}); nothing else of the env is kept.
 */
export function processTrackerFor(
  env: ProcessTrackerEnv,
  onError?: (error: unknown) => void,
): ProcessTracker {
  const seams = seamsOf(env, onError);
  return registry.for(
    keyOf(env, onError),
    () => new ProcessTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/** Test/teardown: drop the env's tracker (resetting it, so its timers and listeners are released). */
export function resetProcessTracker(env: ProcessTrackerEnv): void {
  registry.reset(keyOf(env));
}
