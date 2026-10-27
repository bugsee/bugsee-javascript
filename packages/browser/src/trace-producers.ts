import {
  ScreenProducer,
  type ScreenSource,
  type TraceProducer,
  TraceProducerBase,
} from '@bugsee/capture';
import type { Scheduler } from '@bugsee/core';
import { bytesToMegabytes, TraceName } from '@bugsee/protocol';
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
import { UrlProducer, type UrlProducerDeps } from './url-producer';

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
    // 0-1 -> 0-100 (Android parity). An unusable level (omitted by the tracker) means an unreadable battery: NO
    // `battery` and NO `charging` entry (never a state derived from a substituted level, never `state: 0`).
    // Known edge: both are held, and the provider has no retract path, so a level that goes readable -> unreadable
    // mid-session leaves the last values being re-recorded (same as `battery` before). Unreachable in practice.
    if (s.level !== undefined) {
      this.emitIfChanged(TraceName.BATTERY, Math.round(s.level * 100));
      this.emitIfChanged(
        TraceName.CHARGING,
        chargingToWire({ charging: s.charging, level: s.level }),
      );
    }
    this.#publishTime(TraceName.BATTERY_CHARGING_TIME_S, s.chargingTimeS);
    this.#publishTime(TraceName.BATTERY_DISCHARGING_TIME_S, s.dischargingTimeS);
  }

  // The two time traces are deliberately NOT `emitIfChanged`: that sends `hold: true`, and the provider re-records a
  // held value every refreshMs with no way to retract it. A time that later disappears from the snapshot (Infinity:
  // charger unplugged, estimate not yet available) would then be re-recorded forever as a stale, fabricated reading.
  // So they use plain `emit` (never held, never refreshed) with a change-only guard of our own: a disappearance
  // simply records nothing and forgets the last value, so the same value reappearing is emitted again.
  #publishTime(name: TraceName, seconds: number | undefined): void {
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
    this.emitIfChanged(TraceName.STORAGE_ESTIMATE, {
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
    this.emit(TraceName.RAM_JS_HEAP_TOTAL, m.limit);
    this.emit(TraceName.RAM_JS_HEAP_FREE, Math.max(m.limit - m.used, 0));
    this.emit(TraceName.RAM_JS_HEAP_USED, m.used);
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
    if (gib !== undefined) this.emitIfChanged(TraceName.RAM_SYSTEM_ADVERTISED, gib * 1024 ** 3);
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
    this.emitIfChanged(TraceName.CONNECTION, {
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
    // Both `type` and `angle`, or nothing: a bare or partial notification has nothing to report (spec).
    if (s.type === undefined || s.angle === undefined) return;
    this.emitIfChanged(TraceName.ORIENTATION, orientationToWire(s.type));
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
      this.emitIfChanged(TraceName.APP_STATE, state),
    );
    // No known state (no/unreadable document) = no initial value; the next change still reports.
    const initial = this.#application.current();
    if (initial !== undefined) this.emitIfChanged(TraceName.APP_STATE, initial);
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
    this.#off = this.#tracker.on('frameRate', (fps) => this.emit(TraceName.FPS, fps));
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/**
 * `displays` (the MOBILE name and list shape, spec bundle/traces.md `displays`; it replaces the retired JS-specific
 * `screen_size`): a ONE-entry list `[{ id: 0, state: 'on', width, height, scale, zoom?, rotation? }]`. `width`/`height` are
 * DEVICE pixels, `round(screen.width * deviceScale)` / `round(screen.height * deviceScale)`, `scale` is that device scale
 * factor, `zoom` the page zoom (`1` = 100%) and `rotation` the Screen Orientation `angle` / 90 (quarter turns; the trace field
 * means Android's `Surface.ROTATION_*`, and the direction of the web `angle` against it is UNVERIFIED on a real rotated device),
 * omitted when the engine gives no angle or one that is not a multiple of 90. The browser cannot tell the display `type`,
 * `natural_*` or `max_fps`, so those keys are omitted. `state:'on'` marks the display the page is on, as iOS does (a page
 * cannot observe power).
 *
 * PAGE ZOOM (spec C27). On Chromium `screen.width/height` are device-independent pixels that IGNORE page zoom, while
 * `devicePixelRatio` INCLUDES it. The UiTracker `screenSize` stage derives `zoom = outerWidth / innerWidth` and
 * `deviceScale = devicePixelRatio / zoom` (measured in Chrome 156 at 69%-144%), but TRUSTS it only when the ratio is within
 * 1.5% of a real browser zoom preset (it is then snapped to the preset), on a Chromium engine, in the top-level window and on
 * a pointer-fine device. Trusted: `width/height = round(screen.* x devicePixelRatio / zoom)`, `scale = devicePixelRatio / zoom`
 * (2 decimals) and the `zoom` key (2 decimals). NOT trusted: `zoom` is OMITTED and the product uses `devicePixelRatio` alone.
 * A docked DevTools or side panel (the common case for developers) narrows `innerWidth`, the ratio then matches no preset
 * and the entry keeps the `devicePixelRatio`-only size; a custom (non-preset) zoom, Firefox (its `outerWidth` scales with
 * zoom) and Safari (older `devicePixelRatio` excludes zoom, fingerprinting protection hides `outerWidth`) behave the same.
 * iOS Safari is reported not to swap `screen.width/height` on rotation (unverified): there the entry is portrait-only like
 * native iOS.
 *
 * Re-read on `resize` / `orientationchange` / `screen` `change`, a `(resolution: Ndppx)` change and a `(pointer: coarse)`
 * change (UiTracker `screenSize` + `orientation` stages). The first value is emitted at start; later changes are SETTLED:
 * published once the inputs have been quiet for {@link DISPLAYS_SETTLE_MS} (a macOS maximize/fullscreen animation fires about
 * twenty `resize` events with `outerWidth`/`innerWidth` out of step, which must not each become a trace value). A step
 * curve, so held and de-duplicated. Omitted entirely when the screen or the pixel ratio cannot be read as finite positive
 * numbers.
 */
/** How long the displays inputs must stay unchanged before a change is written (the first value is immediate). */
export const DISPLAYS_SETTLE_MS = 250;

const globalTimers = globalThis as unknown as {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export class DisplaysProducer extends TraceProducerBase {
  readonly name = 'displays';
  readonly #tracker: UiTracker;
  readonly #scheduler: Scheduler;
  #offs: Array<() => void> = [];
  #timer: unknown;
  #pending = false;

  constructor(tracker: UiTracker, scheduler?: Scheduler) {
    super();
    this.#tracker = tracker;
    this.#scheduler = scheduler ?? {
      setInterval: (cb, ms) => globalTimers.setInterval(cb, ms),
      clearInterval: (h) => globalTimers.clearInterval(h),
    };
  }

  protected onStart(): void {
    // subscribing attaches the listeners; both stages re-publish the whole entry (the angle and the size can change apart)
    this.#offs = [
      this.#tracker.on('screenSize', () => this.#settle()),
      this.#tracker.on('orientation', () => this.#settle()),
    ];
    this.#publish();
  }

  protected override onStop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#cancel();
  }

  #cancel(): void {
    if (this.#pending) this.#scheduler.clearInterval(this.#timer);
    this.#pending = false;
    this.#timer = undefined;
  }

  /** Trailing debounce: the value is written once no change has arrived for DISPLAYS_SETTLE_MS. */
  #settle(): void {
    this.#cancel();
    this.#pending = true;
    this.#timer = this.#scheduler.setInterval(() => {
      this.#cancel();
      this.#publish();
    }, DISPLAYS_SETTLE_MS);
  }

  #publish(): void {
    const s = this.#tracker.current('screenSize');
    if (s === undefined) return;
    // dpr / zoom when the page zoom is trusted (spec formula), else the pixel ratio alone
    const factor = s.deviceScale ?? s.dpr;
    const width = Math.round(s.width * factor);
    const height = Math.round(s.height * factor);
    if (!(width > 0) || !(height > 0)) return;
    // at most 2 decimals (zoom gives 1.100000023841858), like the Electron producer; the held value is the rounded one
    const scale = Math.round(factor * 100) / 100 || factor;
    const angle = this.#tracker.current('orientation')?.angle;
    const turns =
      angle !== undefined && angle % 90 === 0 ? (((angle / 90) % 4) + 4) % 4 : undefined;
    this.emitIfChanged(TraceName.DISPLAYS, [
      {
        id: 0,
        state: 'on',
        width,
        height,
        scale,
        ...(s.zoom !== undefined ? { zoom: s.zoom } : {}),
        ...(turns !== undefined ? { rotation: turns } : {}),
      },
    ]);
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
      this.emit(TraceName.MAIN_THREAD_LAG_MS, lagMs),
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
    this.#off = this.#tracker.on('idle', ({ idleMs }) =>
      this.emit(TraceName.MAIN_THREAD_IDLE_MS, idleMs),
    );
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
    this.emitIfChanged(
      TraceName.USER_IDLE_STATE,
      s.screenState === 'locked' ? 'locked' : s.userState,
    );
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
   * Trace names the HOST of this page already writes, which this producer list must therefore NOT write (one writer per
   * name per session; spec platforms/javascript.md host-owned table). Only `displays` is honoured today: an Electron
   * renderer (main writes the full list) and a native WebView (the host writes it) pass `['displays']`.
   */
  hostOwnedTraces?: readonly string[];
  /**
   * Build the `url` producer (the page's sanitized address, held) from these dependencies; absent = no `url` trace.
   * It is not a sensor: it is kept when `sensors` is `false`, and it is built from the page itself, so it needs no
   * `lifecycle`. Build it with `urlProducerDepsFor`.
   */
  url?: UrlProducerDeps;
  /**
   * The route / view state the application reports (`client.setRoute` / `setView`, fed by the framework adapters); present
   * builds the `route` and `view` producer, absent = neither. Not a sensor either (kept when `sensors` is `false`) and
   * independent of `lifecycle`. The launch passes the carrier-shared tracker (`screenTrackerFor`), which is what the client
   * writes to.
   */
  screenState?: ScreenSource;
  /**
   * `false` builds the battery producer (and `url`, when given) ONLY: a caller-supplied `systemMetricsSampler` replaces the heap,
   * connection, orientation, `app_state`, `fps`, `displays` and `main_thread_lag_ms` traces (as on Node), so the sensor producers must not also emit them.
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
   * The shared ApplicationTracker feeding `app_state`. Its presence also GATES the `app_state`, `displays`, `fps`
   * and `main_thread_lag_ms` producers (they are omitted without it); `displays`, `fps` and `orientation` get their
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
  const url = env.url !== undefined ? [new UrlProducer(env.url)] : [];
  const screen = env.screenState !== undefined ? [new ScreenProducer(env.screenState)] : [];
  if (env.sensors === false) return [battery, ...url, ...screen];
  // Read ONCE and SILENTLY (only to decide whether the UiTracker's frame-rate gets a clock): the ProcessTracker owns
  // reporting an unreadable `performance.now` when its lag/uptime stage activates, so a hostile getter is reported once.
  const clock = safePerformanceNow(env, undefined);
  // ONE UI/display tracker per window serves orientation, displays and fps (and the events source).
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
    ...url,
    ...screen,
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
          ...(Array.isArray(env.hostOwnedTraces) && env.hostOwnedTraces.includes(TraceName.DISPLAYS)
            ? []
            : [new DisplaysProducer(ui, env.scheduler)]),
          new MainThreadLagProducer(processTracker),
          new MainThreadIdleProducer(processTracker),
          new FpsProducer(ui),
        ]
      : []),
  ];
}
