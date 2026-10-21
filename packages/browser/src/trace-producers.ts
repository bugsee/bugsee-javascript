import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import type { Scheduler } from '@bugsee/core';
import { bytesToMegabytes } from '@bugsee/protocol';
import {
  type ApplicationTracker,
  type BatteryEnv,
  type BatteryManagerLike,
  type BatteryState,
  type ConnectivityState,
  type ConnectivityTracker,
  connectivityTrackerFor,
  type HeapReading,
  type HeapState,
  type OrientationState,
  type PowerTracker,
  type ProcessEnv,
  type ProcessTracker,
  powerTrackerFor,
  processTrackerFor,
  type ScreenSizeState,
  type StorageEstimate,
  type StorageManagerLike,
  type StorageTracker,
  storageTrackerFor,
  type UiEnv,
  type UiTracker,
  type UserIdleState,
  uiTrackerFor,
} from '@bugsee/trackers/browser';
import { boundMatchMedia } from './host-global';
import { chargingToWire, connectionTypeToWire, orientationToWire } from './system-trace-values';

// Browser `traces.system` producers (mirrors the mobile tracker/producer split). Each producer subscribes to
// one shared tracker in start() and turns its state into the Android-vocabulary wire values; the trackers own
// every OS resource and attach it only while a producer is subscribed.
//
// The `connection` and `orientation` values carry ANDROID's vocabulary, not the browser's — see
// ./system-trace-values.ts for why and how. `traces.system` is a cross-platform stream and the viewer
// renders it from fixed tables, so a browser-shaped value is a value nothing can render.

export class BatteryProducer extends TraceProducerBase {
  readonly name = 'battery';
  readonly #tracker: PowerTracker;
  #off: (() => void) | undefined;
  /** Last value sent per time trace (see #publishTime); cleared on stop. */
  readonly #lastTime = new Map<string, number>();

  constructor(tracker: PowerTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('state', (s) => this.#publish(s)); // subscribing activates the tracker
    const cur = this.#tracker.current();
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
    this.#lastTime.clear();
  }

  #publish(s: BatteryState): void {
    // 0-1 -> 0-100 (Android parity); an unusable level (omitted by the tracker) emits no `battery` at all.
    if (s.level !== undefined) this.emitIfChanged('battery', Math.round(s.level * 100));
    this.emitIfChanged('charging', chargingToWire({ charging: s.charging, level: s.level ?? 0 }));
    this.#publishTime('battery_charging_time_s', s.chargingTimeS);
    this.#publishTime('battery_discharging_time_s', s.dischargingTimeS);
  }

  // The two time traces are deliberately NOT `emitIfChanged`: that sends `hold: true`, and the provider re-records a
  // held value every refreshMs with no way to retract it. A time that later disappears from the snapshot (Infinity:
  // charger unplugged, estimate not yet available) would then be re-recorded forever as a stale, fabricated reading.
  // So they use plain `emit` (never held, never refreshed) with a change-only guard of our own: a disappearance
  // simply records nothing and forgets the last value, so the same value reappearing is emitted again.
  #publishTime(name: string, seconds: number | undefined): void {
    if (seconds === undefined) {
      this.#lastTime.delete(name);
      return;
    }
    const rounded = Math.round(seconds);
    if (this.#lastTime.get(name) === rounded) return;
    this.#lastTime.set(name, rounded);
    this.emit(name, rounded);
  }
}

/**
 * `navigator.storage.estimate()` → `storage_estimate` `{usage, quota}` in integer MB (floored, `bytesToMegabytes`).
 * An ORIGIN quota ESTIMATE that browsers fuzz and pad — NOT device free space — so it is a JS-specific trace and
 * deliberately not the Android `disk_mem_*` group. A key the browser did not give a usable number for is omitted
 * (never 0); an estimate with neither key emits nothing.
 *
 * Held and de-duplicated (`emitIfChanged`): the tracker polls every few minutes, far longer than the default
 * recording window, so a non-held value would almost never be inside a report. Known limit (owner decision pending,
 * see docs/PROGRESS.md TR6): a held value cannot be retracted, so after failed polls the last known estimate keeps
 * being re-recorded. usage below 1 MiB floors to 0 MB (an honest floor, not a measurement of zero).
 */
export class StorageProducer extends TraceProducerBase {
  readonly name = 'storage';
  readonly #tracker: StorageTracker;
  #off: (() => void) | undefined;

  constructor(tracker: StorageTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('storageEstimate', (e) => this.#publish(e));
    // The retained estimate from an earlier subscription gives a value at once — but only while it is younger than
    // 2x the poll interval: a held trace is re-recorded for as long as it lives, so an old snapshot must not seed it.
    const cur = this.#tracker.currentFresh();
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #publish(e: StorageEstimate): void {
    if (e.usageBytes === undefined && e.quotaBytes === undefined) return; // `persisted` alone is not a trace
    this.emitIfChanged('storage_estimate', {
      ...(e.usageBytes !== undefined ? { usage: bytesToMegabytes(e.usageBytes) } : {}),
      ...(e.quotaBytes !== undefined ? { quota: bytesToMegabytes(e.quotaBytes) } : {}),
    });
  }
}

/**
 * `performance.memory` → the grouped `ram_js_heap_{total,free,used}` series (Android `ram_jvm_heap`).
 * `total` is the heap CEILING (jsHeapSizeLimit) and `free` is total - used, which is Android's contract
 * exactly (BugseeTrackerProcess: heapSize is the max, heapFree = heapSize - used) — NOT totalJSHeapSize,
 * which is only what the engine has committed so far and would make `free` shrink as the heap grew.
 * Polled, so every reading is emitted (never de-duplicated or refreshed).
 */
export class MemoryProducer extends TraceProducerBase {
  readonly name = 'memory';
  readonly #tracker: ProcessTracker;
  #off: (() => void) | undefined;

  constructor(tracker: ProcessTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('heap', (m) => this.#publish(m));
    const cur = this.#tracker.currentHeap();
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #publish(m: HeapState): void {
    this.emit('ram_js_heap_total', m.limit);
    this.emit('ram_js_heap_free', m.limit - m.used);
    this.emit('ram_js_heap_used', m.used);
  }
}

/**
 * `navigator.deviceMemory` → `ram_system_advertised`, in BYTES. A deliberately coarse bucket (32 on a
 * 64 GB machine), so it is the ADVERTISED figure — Android already has that name for exactly this — and
 * not the environment's `memory_total`. Static, so it is emitted once and the provider keeps it fresh.
 */
export class AdvertisedMemoryProducer extends TraceProducerBase {
  readonly name = 'ram-system-advertised';
  readonly #gib: () => number | undefined;

  constructor(deviceMemoryGiB: () => number | undefined) {
    super();
    this.#gib = deviceMemoryGiB;
  }

  protected onStart(): void {
    const gib = this.#gib();
    if (gib !== undefined) this.emitIfChanged('ram_system_advertised', gib * 1024 ** 3);
  }
}

export class ConnectionProducer extends TraceProducerBase {
  readonly name = 'connection';
  readonly #tracker: ConnectivityTracker;
  #off: (() => void) | undefined;

  constructor(tracker: ConnectivityTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('state', (s) => this.#publish(s));
    const cur = this.#tracker.current();
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #publish({ online, networkInfo: connection }: ConnectivityState): void {
    if (online === undefined) return; // an unreadable onLine is not evidence of anything: no row
    const type = connectionTypeToWire(connection, online);
    // Measurements (effectiveType/downlink/downlinkMax/rtt) are omitted on a `not_reachable` row, whether the page is
    // offline or the browser reports connection type `none`: the browser keeps reporting its last measurement, which
    // would read as a live link (honesty rule: omit, never stale). `save_data` is a user preference, so it stays.
    const reachable = type !== 'not_reachable';
    this.emitIfChanged('connection', {
      type,
      // Everything below is DETAIL (the viewer renders `item.data`), so it is omitted rather than sent
      // as undefined — an explicitly absent key is what the other tiers send.
      ...(reachable && connection?.effectiveType !== undefined
        ? { effective_type: connection.effectiveType }
        : {}),
      // Android reports bandwidth in kbps (`link_downstream_kbps`); `downlink` is Mbps.
      ...(reachable && connection?.downlink !== undefined
        ? { link_downstream_kbps: Math.round(connection.downlink * 1000) }
        : {}),
      // `downlinkMax` (the link's ceiling, Mbps) rides the same unit; the key is additive detail on the open object.
      ...(reachable && connection?.downlinkMax !== undefined
        ? { link_downstream_max_kbps: Math.round(connection.downlinkMax * 1000) }
        : {}),
      ...(reachable && connection?.rtt !== undefined ? { rtt: connection.rtt } : {}),
      ...(connection?.saveData !== undefined ? { save_data: connection.saveData } : {}),
    });
  }
}

export class OrientationProducer extends TraceProducerBase {
  readonly name = 'orientation';
  readonly #tracker: UiTracker;
  #off: (() => void) | undefined;

  constructor(tracker: UiTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('orientation', (s) => this.#publish(s));
    const cur = this.#tracker.current('orientation');
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #publish(s: OrientationState): void {
    // A bare notification (the engine could not read an orientation) has nothing to report.
    if (s.type === undefined || s.angle === undefined) return;
    this.emitIfChanged('orientation', orientationToWire(s.type, s.angle));
  }
}

/**
 * `document.visibilityState` → `app_state`, in Android's vocabulary (`foreground` / `background`; the viewer's
 * table is `started` / `foreground` / `background`), never the raw `visible` / `hidden` / `prerender`. A step
 * curve, so it is held and de-duplicated; the initial value is read from the document (absent = no initial
 * value, only changes). `UIApplicationDidBecomeActiveNotification` / `UIApplicationDidEnterBackgroundNotification` events stay in the events source.
 */
export class AppStateProducer extends TraceProducerBase {
  readonly name = 'app-state';
  readonly #application: Pick<ApplicationTracker, 'on' | 'current'>;
  #off: (() => void) | undefined;

  constructor(application: Pick<ApplicationTracker, 'on' | 'current'>) {
    super();
    this.#application = application;
  }

  protected onStart(): void {
    // Subscribe first (it activates the tracker and refreshes its retained state), then read the initial value.
    this.#off = this.#application.on('state', ({ state }) =>
      this.emitIfChanged('app_state', state),
    );
    // No known state (no/unreadable document) = no initial value; the next change still reports.
    const initial = this.#application.current();
    if (initial !== undefined) this.emitIfChanged('app_state', initial);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/** `fps` (Android parity): polled, so each window's rate is emitted and never held or refreshed. */
export class FpsProducer extends TraceProducerBase {
  readonly name = 'fps';
  readonly #tracker: UiTracker;
  #off: (() => void) | undefined;

  constructor(tracker: UiTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('frameRate', (fps) => this.emit('fps', fps));
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/**
 * `screen_size` (JS-specific; deliberately NOT Android's `displays`, a display LIST): `{ width, height, dpr }` in
 * CSS px, re-read on `resize` / `orientationchange` / `screen` `change` (UiTracker). A step curve, so it is held and de-duplicated (a resize that
 * moved nothing is dropped); the initial value is emitted at start. Omitted entirely when the screen or the pixel
 * ratio cannot be read as finite positive numbers.
 *
 * Known staleness: moving the window to another monitor with the SAME pixel ratio but a different size fires no
 * `resize`, so the value can go stale until the next one, unless the engine fires the `screen` `change` event the
 * tracker listens for (a `(resolution: Xdppx)` media-query listener is a follow-up); and iOS Safari's `screen.width/height` do not swap on rotation.
 */
export class ScreenSizeProducer extends TraceProducerBase {
  readonly name = 'screen-size';
  readonly #tracker: UiTracker;
  #off: (() => void) | undefined;

  constructor(tracker: UiTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('screenSize', (s) => this.#publish(s)); // subscribing attaches the listeners
    const cur = this.#tracker.current('screenSize');
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #publish(s: ScreenSizeState): void {
    this.emitIfChanged('screen_size', { width: s.width, height: s.height, dpr: s.dpr });
  }
}

/**
 * `main_thread_lag_ms`: TIMER DRIFT — how late the 1 s sampling timer fired on the page's main thread, emitted
 * every tick, ONLY while the page is visible (a hidden tab's throttled timers would paint a hang that did not
 * happen). A measured ~0 is a true value and is emitted. A block of B >= 1 s reads between B - 1000 and B; a block
 * shorter than 1 s that crosses no due tick reads 0 (see the tracker header for the numbers and the follow-ups).
 * Throttling of a page that still says `visible` (occluded window) may read as lag (unverified).
 * Polled, so each value is emitted and never held or refreshed.
 */
export class MainThreadLagProducer extends TraceProducerBase {
  readonly name = 'main-thread-lag';
  readonly #tracker: ProcessTracker;
  #off: (() => void) | undefined;

  constructor(tracker: ProcessTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('mainThreadLag', ({ lagMs }) =>
      this.emit('main_thread_lag_ms', lagMs),
    );
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/**
 * `main_thread_idle_ms` (JS-specific): how long the browser says the main thread can stay idle, from ONE
 * `requestIdleCallback` probe per sampling tick (`deadline.timeRemaining()`, capped at 50 ms by the spec). Visible pages
 * only. A tick in which no idle period was granted produces NO sample (absence, never 0); engines without
 * `requestIdleCallback` (Safari) never produce it. Polled, so each value is emitted and never held.
 */
export class MainThreadIdleProducer extends TraceProducerBase {
  readonly name = 'main-thread-idle';
  readonly #tracker: ProcessTracker;
  #off: (() => void) | undefined;

  constructor(tracker: ProcessTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('idle', ({ idleMs }) => this.emit('main_thread_idle_ms', idleMs));
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/**
 * `user_idle_state` (JS-specific): the Idle Detection API, a string like `app_state`: `active`, `idle`, or `locked`
 * (the screen is locked, which wins over `userState` since the user is away either way). Held, de-duplicated step
 * trace. OPT-IN: the factory builds this producer only for `captureUserIdle: true`. The SDK never prompts: even then
 * it exists ONLY in a page whose `idle-detection` permission is already `granted` (Chromium); otherwise no trace is
 * produced at all. Known limit (owner decision pending, see docs/PROGRESS.md TR5): a
 * held value cannot be retracted, so after the permission is revoked the last published value keeps being re-recorded
 * until the producer stops; only the SEED is gated (the armed detector must be live, i.e. the permission re-confirmed).
 */
export class UserIdleProducer extends TraceProducerBase {
  readonly name = 'user-idle';
  readonly #tracker: ProcessTracker;
  #off: (() => void) | undefined;

  constructor(tracker: ProcessTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('userIdle', (s) => this.#publish(s));
    // Held trace: only a FRESH retained state may seed it (an old snapshot would be re-recorded for as long as it lives).
    const cur = this.#tracker.currentUserIdleFresh();
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #publish(s: UserIdleState): void {
    this.emitIfChanged('user_idle_state', s.screenState === 'locked' ? 'locked' : s.userState);
  }
}

/**
 * Injected browser surfaces. Each is optional and an absent one is simply not sampled; pass the LIVE
 * objects (`navigator`, `performance`, `screen`, `window`) — never a spread copy, since a real
 * `navigator` keeps `onLine` / `connection` / `deviceMemory` as accessors on its prototype.
 */
export interface BrowserTraceEnv extends BatteryEnv {
  performance?: { readonly memory?: HeapReading; now?(): number };
  navigator?: {
    /** `navigator.deviceMemory` in GiB — a coarse bucket, not a measurement. */
    readonly deviceMemory?: number;
    /** `navigator.storage` (absent in insecure contexts): origin quota estimate. */
    readonly storage?: StorageManagerLike;
    readonly onLine?: boolean;
    /** NetworkInformation (read by the ConnectivityTracker). */
    readonly connection?: object;
    /** `navigator.permissions` (the ProcessTracker only ever QUERIES `idle-detection`). */
    readonly permissions?: NonNullable<ProcessEnv['navigator']>['permissions'];
  };
  screen?: UiEnv['screen'];
  /** Source of `online` / `offline` / `orientationchange` / `resize`, and the live `devicePixelRatio`. */
  window?: UiEnv['window'];
  /** The document the SDK is bound to: visibility for `app_state` and `fps`. */
  document?: UiEnv['document'] & { readonly visibilityState?: string };
  /** `window.requestAnimationFrame` / `cancelAnimationFrame` (bound to that window): drive `fps`. */
  requestAnimationFrame?: UiEnv['requestAnimationFrame'];
  cancelAnimationFrame?: UiEnv['cancelAnimationFrame'];
  /** `window.matchMedia` bound to that window: colour scheme / reduced motion / display mode (UiTracker). */
  matchMedia?: UiEnv['matchMedia'];
  /**
   * `false` builds the battery producer ONLY: a caller-supplied `systemMetricsSampler` replaces the heap,
   * connection, orientation, `app_state`, `fps`, `screen_size` and `main_thread_lag_ms` traces (as on Node), so the sensor producers must not also emit them.
   */
  sensors?: boolean;
  /** `window.requestIdleCallback` / `cancelIdleCallback` (bound to that window): drive `main_thread_idle_ms`. */
  requestIdleCallback?: ProcessEnv['requestIdleCallback'];
  cancelIdleCallback?: ProcessEnv['cancelIdleCallback'];
  /** `window.IdleDetector` (Chromium, secure context) and `window.AbortController`: drive `user_idle_state`. */
  IdleDetector?: ProcessEnv['IdleDetector'];
  AbortController?: ProcessEnv['AbortController'];
  /**
   * Build the `user_idle_state` producer. OFF unless exactly `true` (the launch's `captureUserIdle` option). It also
   * needs the page's `idle-detection` permission to be ALREADY granted; the SDK never prompts for it.
   */
  captureUserIdle?: boolean;
  /** Drives the heap poll; default the global timers. */
  scheduler?: Scheduler;
  /**
   * The shared ApplicationTracker feeding `app_state`. Its presence also GATES the `app_state`, `screen_size`, `fps`
   * and `main_thread_lag_ms` producers (they are omitted without it); `screen_size`, `fps` and `orientation` get their
   * sources from the per-window UiTracker, not from this.
   */
  lifecycle?: Pick<ApplicationTracker, 'on' | 'current'>;
}

interface WindowSurfaces {
  navigator?: BrowserTraceEnv['navigator'] & { getBattery?: () => Promise<BatteryManagerLike> };
  performance?: BrowserTraceEnv['performance'];
  screen?: BrowserTraceEnv['screen'];
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  requestIdleCallback?: (callback: (deadline: { timeRemaining(): number }) => void) => number;
  cancelIdleCallback?: (handle: number) => void;
  IdleDetector?: ProcessEnv['IdleDetector'];
  AbortController?: ProcessEnv['AbortController'];
}

// One bound wrapper per (window, function) pair, so wrapping the same window function twice yields the SAME closure.
const boundCache = new WeakMap<object, WeakMap<object, unknown>>();
function boundTo<F extends (...args: never[]) => unknown>(win: object, fn: F): F {
  let perWin = boundCache.get(win);
  if (perWin === undefined) {
    perWin = new WeakMap();
    boundCache.set(win, perWin);
  }
  const cached = perWin.get(fn);
  if (cached !== undefined) return cached as F;
  const bound = ((...args: never[]) => fn.apply(win, args)) as F;
  perWin.set(fn, bound);
  return bound;
}

/**
 * A COMPLETE traces env from ONE window (+ its document): every surface comes from that window and an absent
 * one is simply not sampled — nothing falls back to `globalThis`, so an injected window that lacks
 * `performance.memory` omits the heap instead of borrowing the host's. The live objects are passed (never a
 * spread copy: a real `navigator` keeps its accessors on the prototype); `requestAnimationFrame` is bound to
 * the window it belongs to.
 */
export function browserTraceEnvFrom(
  source: object,
  document: BrowserTraceEnv['document'],
  onError?: (error: unknown) => void,
): BrowserTraceEnv {
  const win = source as WindowSurfaces;
  // Every read of the host's window is guarded: a cross-origin proxy or a torn-down frame throws from a plain
  // property read, and that must cost only that one trace, never the customer's app (this runs inside launch()).
  const read = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        /* the reporter itself failed */
      }
      return undefined;
    }
  };
  const nav = read(() => win.navigator);
  const performance = read(() => win.performance);
  const screen = read(() => win.screen);
  const getBattery = nav === undefined ? undefined : read(() => nav.getBattery);
  const raf = read(() => win.requestAnimationFrame);
  const caf = read(() => win.cancelAnimationFrame);
  const ric = read(() => win.requestIdleCallback);
  const cic = read(() => win.cancelIdleCallback);
  const idleDetector = read(() => win.IdleDetector);
  const abortController = read(() => win.AbortController);
  // Stable identities: the shared trackers restart their armed stages when a seam changes identity, so wrapping the
  // SAME window function must hand back the SAME closure on every launch (a no-op relaunch stays a no-op).
  const raf2 = typeof raf === 'function' ? boundTo(win, raf) : undefined;
  const caf2 = typeof caf === 'function' ? boundTo(win, caf) : undefined;
  const ric2 = typeof ric === 'function' ? boundTo(win, ric) : undefined;
  const cic2 = typeof cic === 'function' ? boundTo(win, cic) : undefined;
  const matchMedia = boundMatchMedia(win, onError);
  return {
    ...(matchMedia !== undefined ? { matchMedia } : {}),
    ...(nav !== undefined ? { navigator: nav } : {}),
    ...(performance !== undefined ? { performance } : {}),
    ...(screen !== undefined ? { screen } : {}),
    window: source as NonNullable<BrowserTraceEnv['window']>,
    ...(document !== undefined ? { document } : {}),
    ...(raf2 !== undefined ? { requestAnimationFrame: raf2 } : {}),
    ...(caf2 !== undefined ? { cancelAnimationFrame: caf2 } : {}),
    ...(ric2 !== undefined ? { requestIdleCallback: ric2 } : {}),
    ...(cic2 !== undefined ? { cancelIdleCallback: cic2 } : {}),
    ...(typeof idleDetector === 'function' ? { IdleDetector: idleDetector } : {}),
    ...(typeof abortController === 'function' ? { AbortController: abortController } : {}),
    ...(nav !== undefined && typeof getBattery === 'function'
      ? { getBattery: () => getBattery.call(nav) }
      : {}),
  };
}

/** The real globals, read lazily (workers / Node tests may have none of them). */
export function defaultBrowserTraceEnv(onError?: (error: unknown) => void): BrowserTraceEnv {
  const g = globalThis as unknown as WindowSurfaces & {
    window?: BrowserTraceEnv['window'];
    document?: BrowserTraceEnv['document'];
  };
  // A blocked global (torn-down frame, hostile proxy) throws from the read itself: omit it, never throw.
  const safe = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        /* the reporter itself failed */
      }
      return undefined;
    }
  };
  const { window: _self, ...rest } = browserTraceEnvFrom(
    g,
    safe(() => g.document),
    onError,
  );
  const w = safe(() => g.window);
  return { ...rest, ...(w !== undefined ? { window: w } : {}) };
}

// `env.performance.now` can be a hostile getter (a proxy): an unreadable one just means the tracker falls back to
// its default clock.
function safePerformanceNow(
  env: BrowserTraceEnv,
  onError: ((error: unknown) => void) | undefined,
): unknown {
  try {
    return env.performance?.now;
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      /* the reporter itself failed */
    }
    return undefined;
  }
}

/**
 * The browser trace producers (battery first). Nothing activates at call time. `onError` receives a
 * failure that happens after the fact (a battery manager that throws after `getBattery()` resolves, a
 * throwing `performance.memory` getter, a throwing event-path read), which would otherwise be swallowed.
 */
export function createBrowserSystemTraceProducers(
  env: BrowserTraceEnv = defaultBrowserTraceEnv(),
  onError?: (error: unknown) => void,
): TraceProducer[] {
  const nav = env.navigator;
  const battery = new BatteryProducer(powerTrackerFor(env, onError));
  if (env.sensors === false) return [battery];
  // Read ONCE and SILENTLY (only to decide whether the UiTracker's frame-rate gets a clock): the ProcessTracker owns
  // reporting an unreadable `performance.now` when its lag/uptime stage activates, so a hostile getter is reported once.
  const clock = safePerformanceNow(env, undefined);
  // ONE UI/display tracker per window serves orientation, screen_size and fps (and the events source).
  const ui = uiTrackerFor(
    {
      ...(env.window !== undefined ? { window: env.window } : {}),
      ...(env.screen !== undefined ? { screen: env.screen } : {}),
      ...(env.matchMedia !== undefined ? { matchMedia: env.matchMedia } : {}),
      ...(env.document !== undefined ? { document: env.document } : {}),
      ...(env.requestAnimationFrame !== undefined
        ? { requestAnimationFrame: env.requestAnimationFrame }
        : {}),
      ...(env.cancelAnimationFrame !== undefined
        ? { cancelAnimationFrame: env.cancelAnimationFrame }
        : {}),
      ...(clock !== undefined
        ? // A clock that becomes unreadable later THROWS (the tracker's tick reports and skips the window)
          // rather than answering a made-up 0.
          { now: () => (env.performance as { now(): number }).now() }
        : {}),
      ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
    },
    onError,
  );
  // ONE domain tracker per window feeds the heap, main-thread lag/idle and user-idle traces. The live `performance`
  // object is passed (`performance.memory` is a live getter the tracker reads on every poll).
  const processTracker = processTrackerFor(
    {
      ...(env.window !== undefined ? { window: env.window } : {}),
      ...(env.performance !== undefined ? { performance: env.performance } : {}),
      ...(env.document !== undefined ? { document: env.document } : {}),
      ...(env.lifecycle !== undefined ? { lifecycle: env.lifecycle } : {}),
      ...(env.requestIdleCallback !== undefined
        ? { requestIdleCallback: env.requestIdleCallback }
        : {}),
      ...(env.cancelIdleCallback !== undefined
        ? { cancelIdleCallback: env.cancelIdleCallback }
        : {}),
      ...(nav !== undefined ? { navigator: nav } : {}),
      ...(env.IdleDetector !== undefined ? { IdleDetector: env.IdleDetector } : {}),
      ...(env.AbortController !== undefined ? { AbortController: env.AbortController } : {}),
      ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
    },
    onError,
  );
  return [
    battery,
    new MemoryProducer(processTracker),
    // OPT-IN, strictly `true`: idle/locked state is behavioural data, and a host page's own `idle-detection` grant is
    // not consent to record and upload it. Even when opted in, the tracker starts a detector only if the permission
    // is ALREADY granted (the SDK never prompts).
    ...(env.captureUserIdle === true ? [new UserIdleProducer(processTracker)] : []),
    new AdvertisedMemoryProducer(() => nav?.deviceMemory),
    new StorageProducer(
      storageTrackerFor(
        {
          ...(env.window !== undefined ? { window: env.window } : {}),
          ...(nav !== undefined ? { navigator: nav } : {}),
          ...(env.document !== undefined ? { document: env.document } : {}),
          ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
        },
        onError,
      ),
    ),
    new ConnectionProducer(connectivityTrackerFor(env, onError)),
    new OrientationProducer(ui),
    ...(env.lifecycle !== undefined
      ? [
          new AppStateProducer(env.lifecycle),
          new ScreenSizeProducer(ui),
          new MainThreadLagProducer(processTracker),
          new MainThreadIdleProducer(processTracker),
          new FpsProducer(ui),
        ]
      : []),
  ];
}
