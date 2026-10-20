import { MultiKeyEmitterBase } from '../emitter';
import { createTrackerRegistry } from '../tracker-registry';
import { hostRead } from './host-read';

// Browser UI / DISPLAY tracker (domain tracker; Android reference: BugseeTrackerUI/Display). ONE class
// owns every window-side display signal and exposes them as notification kinds ("stages"):
//
//   orientation    {type?, angle?}   screen.orientation `change` + window `orientationchange` (engines differ in which fire)
//   screenSize     {width,height,dpr} CSS px of screen.* and devicePixelRatio; window `resize`/`orientationchange`, screen `change`
//   viewport       {width,height}    window.innerWidth/innerHeight; window `resize`/`orientationchange`
//   colorScheme    {dark}            matchMedia (prefers-color-scheme: dark)
//   reducedMotion  {reduce}          matchMedia (prefers-reduced-motion: reduce)
//   visualViewport {scale?,offsetLeft?,offsetTop?,width?,height?} the VISUAL viewport (pinch zoom / pan); its `resize`/`scroll`
//   displayMode    {mode}            matchMedia (display-mode: fullscreen | standalone | minimal-ui), else 'browser'
//   frameRate      number            requestAnimationFrame callbacks per second, only while the page is visible
//
// It does NOT use the page-lifecycle tracker: the frame-rate gate listens for `visibilitychange` itself.
//
// PER-STAGE ACTIVATION. A listener/timer exists only while some subscriber wants a stage it feeds (window `resize`
// while screenSize or viewport has a listener, the rAF loop + interval + visibilitychange only while frameRate does,
// ...). Subscribing attaches, the last unsubscribe detaches, through the emitter's `onListenersChanged` hook.
//
// RETENTION. Nothing survives the last unsubscribe except (a) the env seams and (b) the per-stage DE-DUPLICATION
// baseline (the last emitted value, so a repeated reading is not re-announced). The baseline is RE-READ silently
// whenever a stage goes from no listener to one (and when a rebind swaps the sources under running stages), so a
// change that happened while nobody listened to THAT stage — even if its source stayed attached for a sibling
// stage — is never mistaken for "unchanged" later. A stage with no listener is not computed at all. `current(stage)` always reads live (never a stale value) and is `undefined` when the reading is
// unavailable or invalid. Invalid values (non-finite / non-positive sizes, a non-boolean query) are OMITTED, never
// zeroed. Only the frame-rate window state (frames counted, timer) is dropped on stop: a later window starts fresh.
//
// Failure isolation: every host read goes through `hostRead` and is reported via `onError`; a throwing `onError` never
// escapes; every DOM listener and timer/rAF callback is wrapped so nothing throws into the host's event dispatch.

export interface OrientationState {
  /** The engine's `screen.orientation.type`. Omitted when it is not a string. */
  type?: string;
  /** `screen.orientation.angle`. Omitted when it is not a finite number. */
  angle?: number;
}
export interface ScreenSizeState {
  width: number;
  height: number;
  dpr: number;
}
export interface ViewportState {
  width: number;
  height: number;
}
export interface ColorSchemeState {
  dark: boolean;
}
export interface ReducedMotionState {
  reduce: boolean;
}
export interface VisualViewportState {
  scale?: number;
  offsetLeft?: number;
  offsetTop?: number;
  width?: number;
  height?: number;
}
export type DisplayModeName = 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
export interface DisplayModeState {
  mode: DisplayModeName;
}

/** Notification kinds -> payloads. */
export interface UiStages {
  orientation: OrientationState;
  screenSize: ScreenSizeState;
  viewport: ViewportState;
  visualViewport: VisualViewportState;
  colorScheme: ColorSchemeState;
  reducedMotion: ReducedMotionState;
  displayMode: DisplayModeState;
  frameRate: number;
}
export type UiStage = keyof UiStages;
/** The stages that have a readable current state (everything but the polled frame rate). */
export type UiStateStage = Exclude<UiStage, 'frameRate'>;

interface TargetLike {
  addEventListener(type: string, listener: (event?: unknown) => void): void;
  removeEventListener(type: string, listener: (event?: unknown) => void): void;
}
export interface MediaQueryListLike {
  readonly matches?: unknown;
  addEventListener?(
    type: 'change',
    listener: (event: { readonly matches?: unknown }) => void,
  ): void;
  removeEventListener?(
    type: 'change',
    listener: (event: { readonly matches?: unknown }) => void,
  ): void;
}
export interface UiSchedulerLike {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The seams a launch hands the tracker. Every field is optional: an absent surface just omits its stages. */
export interface UiEnv {
  /** The window the SDK is bound to: `resize`/`orientationchange`, the LIVE `devicePixelRatio`, inner size. */
  window?: Partial<TargetLike> & {
    readonly devicePixelRatio?: unknown;
    readonly innerWidth?: unknown;
    readonly innerHeight?: unknown;
  };
  screen?: Partial<TargetLike> & {
    readonly width?: unknown;
    readonly height?: unknown;
    readonly orientation?: Partial<TargetLike> & {
      readonly type?: unknown;
      readonly angle?: unknown;
    };
  };
  /** `window.visualViewport` (pinch zoom and the visible region); absent in older engines. */
  visualViewport?: Partial<TargetLike> & {
    readonly scale?: unknown;
    readonly offsetLeft?: unknown;
    readonly offsetTop?: unknown;
    readonly width?: unknown;
    readonly height?: unknown;
  };
  /** `window.matchMedia` BOUND to that window (never the host's). */
  matchMedia?: (query: string) => MediaQueryListLike;
  /** Visibility source and `visibilitychange` target of the frame-rate gate. */
  document?: Partial<TargetLike> & { readonly visibilityState?: unknown };
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /** Monotonic ms. Default `performance.now()`, else `Date.now()`. */
  now?: () => number;
  scheduler?: UiSchedulerLike;
  /** Frame-rate window length. Default 1000. */
  intervalMs?: number;
}

// This package has no DOM/Node lib: the global timers are reached through a cast.
const timers = globalThis as unknown as {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};
const defaultScheduler: UiSchedulerLike = {
  setInterval: (cb, ms) => timers.setInterval(cb, ms),
  clearInterval: (h) => timers.clearInterval(h),
};
const defaultNow = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
};

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const UI_STAGES: readonly UiStage[] = [
  'orientation',
  'screenSize',
  'viewport',
  'visualViewport',
  'colorScheme',
  'reducedMotion',
  'displayMode',
  'frameRate',
];
const DARK = '(prefers-color-scheme: dark)';
const REDUCED = '(prefers-reduced-motion: reduce)';
const DISPLAY_MODES = ['fullscreen', 'standalone', 'minimal-ui'] as const;

const FUNCTION_SEAMS: ReadonlySet<string> = new Set([
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'now',
]);

const ENV_KEYS = [
  'window',
  'screen',
  'visualViewport',
  'matchMedia',
  'document',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'now',
  'scheduler',
  'intervalMs',
] as const;

interface Binding {
  readonly id: string;
  readonly kinds: readonly UiStage[];
  /** Attach the source(s); push each undo onto `offs` BEFORE doing anything that may throw. */
  attach(offs: Array<() => void>): void;
}

export class UiTracker extends MultiKeyEmitterBase<UiStages> {
  readonly name = 'browser-ui';
  readonly #env: UiEnv;
  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #reporter: { fn: ((error: unknown) => void) | undefined };
  readonly #report: (error: unknown) => void;
  /** De-duplication baselines (serialized last emitted value) per stage. */
  readonly #last = new Map<UiStage, string>();
  /** The stages that had a listener at the last sync (a stage entering it re-baselines). */
  readonly #wanted = new Set<UiStage>();
  readonly #attached = new Map<string, Array<() => void>>();
  readonly #bindings: readonly Binding[];
  // frame-rate machinery (alive only inside the frameRate binding)
  #timer: unknown = null;
  #raf: number | undefined;
  #running = false;
  #frames = 0;
  #seenFrame = false;
  #windowStart = 0;
  #loop = 0;

  constructor(env: UiEnv, onError?: (error: unknown) => void) {
    const reporter = { fn: onError };
    // A throwing reporter must not escape into the host's event dispatch, a timer, or `on()`.
    const report = (error: unknown): void => {
      try {
        reporter.fn?.(error);
      } catch {
        /* the reporter itself failed; nothing left to tell */
      }
    };
    super(report);
    this.#reporter = reporter;
    this.#report = report;
    // Copied field by field through `hostRead`: an env with a hostile getter costs only that field (reported).
    this.#env = {};
    Object.assign(this.#env, this.#pending(env));
    this.#bindings = this.#makeBindings();
  }

  /**
   * Hand the latest launch's seams to this shared tracker (latest launch wins, MERGE not drop). A defined `onError`
   * replaces the reporter; a defined env field replaces ours; an undefined one never clobbers it. If a replaced
   * field changes a source that is currently attached, those sources are re-attached to the new objects.
   */
  rebind(env: UiEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#reporter.fn = onError;
    const pending = this.#pending(env);
    // Only a change of a SOURCE (window/screen/document/scheduler/interval) re-attaches. The function seams
    // (matchMedia, rAF, cancelAnimationFrame, now) are rebuilt as fresh closures by every launch for the same
    // window, so they are swapped in place and a running frame-rate window is left alone.
    const resource = Object.keys(pending).some((key) => !FUNCTION_SEAMS.has(key));
    // Detach with the OLD seams (the old scheduler clears its own interval) BEFORE the new ones are applied: the
    // interval is cleared on `#env.scheduler`, so this ORDER is what keeps it on the scheduler that armed it.
    if (resource) {
      this.#detachAll();
      // The sources moved: every stage that STILL has listeners re-baselines silently from the new sources (a swap
      // is not announced as a change; a real change made while the old sources were detached is not announced
      // either, the new subscriber-visible value simply becomes the reference).
      this.#wanted.clear();
    }
    Object.assign(this.#env, pending);
    if (resource) this.#sync();
  }

  /** The env's defined fields that differ from ours (a hostile getter is reported and skipped). */
  #pending(env: UiEnv): Record<string, unknown> {
    const pending: Record<string, unknown> = {};
    const current = this.#env as Record<string, unknown>;
    for (const key of ENV_KEYS) {
      const next = hostRead(() => (env as Record<string, unknown>)[key], this.#report);
      if (next !== undefined && next !== current[key]) pending[key] = next;
    }
    return pending;
  }

  /** The LIVE reading of a stage (guarded, reported); undefined when unavailable or invalid. */
  current<K extends UiStateStage>(stage: K): UiStages[K] | undefined {
    return this.#read(stage) as UiStages[K] | undefined;
  }

  /** Test/teardown: release every listener, timer and baseline. */
  reset(): void {
    this.#detachAll();
    this.#last.clear();
    this.#wanted.clear();
  }

  protected override onListenersChanged(): void {
    this.#sync();
  }

  #sync(): void {
    // A stage that just gained its first listener re-reads its baseline silently — even when its source is already
    // attached for a sibling stage, which may have moved the value while this one was not being computed.
    for (const stage of UI_STAGES) {
      const listened = this.listenerCount(stage) > 0;
      if (!listened) this.#wanted.delete(stage);
      else if (!this.#wanted.has(stage)) {
        this.#wanted.add(stage);
        if (stage !== 'frameRate') this.#remember(stage, this.#read(stage));
      }
    }
    for (const binding of this.#bindings) {
      const want = binding.kinds.some((kind) => this.listenerCount(kind) > 0);
      const has = this.#attached.has(binding.id);
      if (want && !has) this.#attach(binding);
      else if (!want && has) this.#detach(binding.id);
    }
  }

  #attach(binding: Binding): void {
    const offs: Array<() => void> = [];
    this.#attached.set(binding.id, offs); // recorded first: a throw below still leaves something to undo
    try {
      binding.attach(offs);
    } catch (error) {
      this.#report(error);
    }
  }

  #detach(id: string): void {
    const offs = this.#attached.get(id) ?? [];
    this.#attached.delete(id);
    for (const off of offs) {
      try {
        off();
      } catch {
        /* best-effort: one failed removal must not leak the others */
      }
    }
  }

  #detachAll(): void {
    for (const id of [...this.#attached.keys()]) this.#detach(id);
  }

  // ---- readers (each value validated; undefined = omit) -------------------------------------------------------

  #read(stage: UiStateStage): UiStages[UiStateStage] | undefined {
    const report = this.#report;
    switch (stage) {
      case 'orientation': {
        const o = hostRead(() => this.#env.screen?.orientation, report);
        if (o === undefined) return undefined;
        const type = hostRead(() => o.type, report);
        const angle = hostRead(() => o.angle, report);
        const state: OrientationState = {
          ...(typeof type === 'string' ? { type } : {}),
          ...(typeof angle === 'number' && Number.isFinite(angle) ? { angle } : {}),
        };
        return Object.keys(state).length === 0 ? undefined : state;
      }
      case 'screenSize': {
        const screen = hostRead(() => this.#env.screen, report);
        if (screen === undefined) return undefined;
        const width = hostRead(() => screen.width, report);
        const height = hostRead(() => screen.height, report);
        const dpr = hostRead(() => this.#env.window?.devicePixelRatio, report);
        return positive(width) && positive(height) && positive(dpr)
          ? { width, height, dpr }
          : undefined;
      }
      case 'viewport': {
        const win = hostRead(() => this.#env.window, report);
        if (win === undefined) return undefined;
        const width = hostRead(() => win.innerWidth, report);
        const height = hostRead(() => win.innerHeight, report);
        return positive(width) && positive(height) ? { width, height } : undefined;
      }
      case 'visualViewport': {
        const vv = hostRead(() => this.#env.visualViewport, report);
        if (vv === undefined || vv === null) return undefined;
        const state: VisualViewportState = {};
        const scale = hostRead(() => vv.scale, report);
        const offsetLeft = hostRead(() => vv.offsetLeft, report);
        const offsetTop = hostRead(() => vv.offsetTop, report);
        const width = hostRead(() => vv.width, report);
        const height = hostRead(() => vv.height, report);
        if (positive(scale)) state.scale = scale;
        if (finite(offsetLeft)) state.offsetLeft = offsetLeft;
        if (finite(offsetTop)) state.offsetTop = offsetTop;
        if (positive(width)) state.width = width;
        if (positive(height)) state.height = height;
        return Object.keys(state).length === 0 ? undefined : state;
      }
      case 'colorScheme': {
        const dark = this.#matches(DARK);
        return dark === undefined ? undefined : { dark };
      }
      case 'reducedMotion': {
        const reduce = this.#matches(REDUCED);
        return reduce === undefined ? undefined : { reduce };
      }
      case 'displayMode':
        return this.#displayMode(
          DISPLAY_MODES.map((mode) => this.#matches(`(display-mode: ${mode})`)),
        );
    }
  }

  #matches(query: string): boolean | undefined {
    const report = this.#report;
    const mm = hostRead(() => this.#env.matchMedia, report);
    if (typeof mm !== 'function') return undefined;
    const list = hostRead(() => mm(query), report);
    if (list === undefined || list === null) return undefined;
    const matches = hostRead(() => list.matches, report);
    return typeof matches === 'boolean' ? matches : undefined;
  }

  /** The first matching mode; 'browser' when all queries answered and none matched; undefined when any failed and none matched. */
  #displayMode(matches: ReadonlyArray<boolean | undefined>): DisplayModeState | undefined {
    const hit = DISPLAY_MODES[matches.indexOf(true)]; // undefined when none matched (index -1)
    if (hit !== undefined) return { mode: hit };
    // 'browser' is a CLAIM that none of the modes apply: only made when every query answered.
    return matches.includes(undefined) ? undefined : { mode: 'browser' };
  }

  // ---- emission -------------------------------------------------------------------------------------------------

  #remember(stage: UiStage, value: unknown): void {
    if (value === undefined) this.#last.delete(stage);
    else this.#last.set(stage, JSON.stringify(value));
  }

  /** Emit `value` unless it equals the last emitted one. An undefined value (nothing valid to say) is never emitted. */
  #publish<K extends UiStage>(stage: K, value: UiStages[K] | undefined): void {
    if (value === undefined) return;
    const serialized = JSON.stringify(value);
    if (this.#last.get(stage) === serialized) return;
    this.#last.set(stage, serialized);
    this.emit(stage, value);
  }

  /** Re-read and publish the stages that have listeners. */
  #refresh(stages: readonly UiStateStage[]): void {
    for (const stage of stages) {
      if (this.listenerCount(stage) > 0) this.#publish(stage, this.#read(stage) as never);
    }
  }

  /** A DOM listener: nothing it does may throw into the host's event dispatch. */
  #guarded<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      try {
        fn(...args);
      } catch (error) {
        this.#report(error);
      }
    };
  }

  #listen(
    offs: Array<() => void>,
    target: Partial<TargetLike> | undefined,
    type: string,
    listener: (event?: unknown) => void,
  ): void {
    if (typeof target?.addEventListener !== 'function') return;
    offs.push(() => target.removeEventListener?.(type, listener));
    target.addEventListener(type, listener);
  }

  #watchQuery(
    offs: Array<() => void>,
    query: string,
    listener: (event: { readonly matches?: unknown }) => void,
  ): void {
    const mm = hostRead(() => this.#env.matchMedia, this.#report);
    if (typeof mm !== 'function') return;
    const list = hostRead(() => mm(query), this.#report);
    if (list === undefined || list === null || typeof list.addEventListener !== 'function') return;
    offs.push(() => list.removeEventListener?.('change', listener));
    list.addEventListener('change', listener);
  }

  // ---- sources --------------------------------------------------------------------------------------------------

  #makeBindings(): readonly Binding[] {
    const env = (): UiEnv => this.#env;
    const geometry: readonly UiStateStage[] = ['screenSize', 'viewport'];
    return [
      {
        id: 'resize',
        kinds: geometry,
        attach: (offs) =>
          this.#listen(
            offs,
            env().window,
            'resize',
            this.#guarded(() => this.#refresh(geometry)),
          ),
      },
      {
        id: 'orientation',
        kinds: ['orientation', ...geometry],
        attach: (offs) => {
          // Engines differ in which of the two fires; the de-duplication collapses a double delivery.
          const onChange = this.#guarded(() => this.#onOrientation());
          this.#listen(
            offs,
            hostRead(() => env().screen?.orientation, this.#report),
            'change',
            onChange,
          );
          this.#listen(offs, env().window, 'orientationchange', onChange);
        },
      },
      {
        id: 'screen',
        kinds: ['screenSize'],
        attach: (offs) =>
          this.#listen(
            offs,
            env().screen,
            'change',
            this.#guarded(() => this.#refresh(['screenSize'])),
          ),
      },
      {
        id: 'visualViewport',
        kinds: ['visualViewport'],
        attach: (offs) => {
          const onChange = this.#guarded(() => this.#refresh(['visualViewport']));
          const vv = env().visualViewport;
          this.#listen(offs, vv, 'resize', onChange);
          this.#listen(offs, vv, 'scroll', onChange);
        },
      },
      {
        id: 'colorScheme',
        kinds: ['colorScheme'],
        attach: (offs) =>
          this.#watchQuery(
            offs,
            DARK,
            this.#guarded((event) => {
              if (typeof event.matches === 'boolean')
                this.#publish('colorScheme', { dark: event.matches });
            }),
          ),
      },
      {
        id: 'reducedMotion',
        kinds: ['reducedMotion'],
        attach: (offs) =>
          this.#watchQuery(
            offs,
            REDUCED,
            this.#guarded((event) => {
              if (typeof event.matches === 'boolean')
                this.#publish('reducedMotion', { reduce: event.matches });
            }),
          ),
      },
      {
        id: 'displayMode',
        kinds: ['displayMode'],
        attach: (offs) => {
          const onChange = this.#guarded(() => this.#refresh(['displayMode']));
          for (const mode of DISPLAY_MODES)
            this.#watchQuery(offs, `(display-mode: ${mode})`, onChange);
        },
      },
      { id: 'frameRate', kinds: ['frameRate'], attach: (offs) => this.#attachFrameRate(offs) },
    ];
  }

  /** An orientation event: the orientation itself (an empty `{}` when the engine cannot read one) plus the geometry. */
  #onOrientation(): void {
    if (this.listenerCount('orientation') > 0) {
      const state = this.#read('orientation') as OrientationState | undefined;
      // Without a readable orientation there is nothing to compare: announce the bare event, undeduplicated.
      if (state === undefined) this.emit('orientation', {});
      else this.#publish('orientation', state);
    }
    this.#refresh(['screenSize', 'viewport']);
  }

  // ---- frame rate (rAF counter; only while the page is visible) -------------------------------------------------
  // Hidden, unmeasurable, or without rAF/visibility events it emits NOTHING: omit, never zero. Once frames have
  // flowed, the first window without any is reported as 0 (the main thread stopped painting) and a continuing stall
  // then goes quiet; before the first frame nothing is reported (rAF can be paused while the page says `visible`).

  #attachFrameRate(offs: Array<() => void>): void {
    const env = this.#env;
    // No frames to count, or no visibility events to gate on (a hidden tab must never keep a frame loop): omit.
    if (typeof env.requestAnimationFrame !== 'function') return;
    const doc = env.document;
    if (typeof doc?.addEventListener !== 'function') return;
    offs.push(() => this.#stopLoop());
    const onVisibility = this.#guarded(() => {
      if (this.#isVisible()) this.#startLoop();
      else this.#stopLoop();
    });
    this.#listen(offs, doc, 'visibilitychange', onVisibility);
    if (this.#isVisible()) this.#startLoop();
  }

  #isVisible(): boolean {
    return hostRead(() => this.#env.document?.visibilityState, this.#report) === 'visible';
  }

  #startLoop(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop += 1;
    this.#seenFrame = false;
    this.#frames = 0;
    try {
      // The clock read is inside the guarded setup: a throwing clock must roll the run back like any other setup
      // failure, or `#running` would stay true with no loop and block every later start.
      this.#windowStart = (this.#env.now ?? defaultNow)();
      this.#arm();
      const scheduler = this.#env.scheduler ?? defaultScheduler;
      const loop = this.#loop;
      this.#timer = scheduler.setInterval(
        // A tick from a loop that is no longer current (its clear failed) must never touch the live window.
        this.#guarded(() => {
          if (this.#running && loop === this.#loop) this.#tick();
        }),
        this.#env.intervalMs ?? 1000,
      );
    } catch (error) {
      this.#report(error);
      this.#stopLoop(); // never leave a half-started loop behind
    }
  }

  #stopLoop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      try {
        (this.#env.scheduler ?? defaultScheduler).clearInterval(this.#timer);
      } catch {
        /* best-effort */
      }
    }
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
      now = (this.#env.now ?? defaultNow)();
    } catch (error) {
      this.#report(error); // an unreadable clock skips this window
      return;
    }
    const elapsed = now - this.#windowStart;
    if (!(elapsed > 0)) return; // a zero-length (or non-finite) window has no rate
    if (!this.#seenFrame) {
      this.#windowStart = now; // the stalled stretch must not dilute the first measured window
      return;
    }
    const fps = Math.round(((this.#frames * 1000) / elapsed) * 10) / 10;
    if (this.#frames === 0) this.#seenFrame = false;
    this.#frames = 0;
    this.#windowStart = now;
    this.emit('frameRate', fps); // the emitter isolates and reports a throwing consumer
  }
}

const registry = createTrackerRegistry<UiTracker>();

// The key is the window the SDK is bound to; failing that the screen; failing that the env object itself (an
// ad-hoc env then gets a private tracker). Host reads are guarded AND reported.
function keyOf(env: UiEnv, onError?: (error: unknown) => void): object {
  const win = hostRead(() => env.window, onError);
  if (typeof win === 'object' && win !== null) return win;
  const screen = hostRead(() => env.screen, onError);
  if (typeof screen === 'object' && screen !== null) return screen;
  return env;
}

/**
 * The singleton UiTracker for the env's window. Every call (a relaunch included) hands the shared tracker the latest
 * launch's `onError` and the env fields it defines (see {@link UiTracker.rebind}: merge, never drop).
 */
export function uiTrackerFor(env: UiEnv, onError?: (error: unknown) => void): UiTracker {
  return registry.for(
    keyOf(env, onError),
    () => new UiTracker(env, onError),
    (tracker) => tracker.rebind(env, onError),
  );
}

/** Test/teardown: drop the env's tracker (resetting it, so its listeners and timers are released). */
export function resetUiTracker(env: UiEnv): void {
  registry.reset(keyOf(env));
}
