import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import type { Scheduler } from '@bugsee/core';
import { chargingToWire, connectionTypeToWire, orientationToWire } from './system-trace-values';
import {
  type BatteryEnv,
  type BatteryManagerLike,
  type BatteryState,
  BatteryTracker,
} from './trackers/battery-tracker';
import {
  type ConnectionEnv,
  type ConnectionState,
  ConnectionTracker,
} from './trackers/connection-tracker';
import { type FpsEnv, FpsTracker } from './trackers/fps-tracker';
import { type MainThreadLagEnv, MainThreadLagTracker } from './trackers/main-thread-lag-tracker';
import { type MemoryReading, type MemoryState, MemoryTracker } from './trackers/memory-tracker';
import {
  type OrientationEnv,
  type OrientationState,
  OrientationTracker,
} from './trackers/orientation-tracker';
import type { PageLifecycleTracker } from './trackers/page-lifecycle-tracker';
import {
  type ScreenSizeEnv,
  type ScreenSizeState,
  ScreenSizeTracker,
} from './trackers/screen-size-tracker';

// Browser `traces.system` producers (mirrors the mobile tracker/producer split). Each producer subscribes to
// one shared tracker in start() and turns its state into the Android-vocabulary wire values; the trackers own
// every OS resource and attach it only while a producer is subscribed.
//
// The `connection` and `orientation` values carry ANDROID's vocabulary, not the browser's — see
// ./system-trace-values.ts for why and how. `traces.system` is a cross-platform stream and the viewer
// renders it from fixed tables, so a browser-shaped value is a value nothing can render.

export class BatteryProducer extends TraceProducerBase {
  readonly name = 'battery';
  readonly #tracker: BatteryTracker;
  #off: (() => void) | undefined;

  constructor(tracker: BatteryTracker) {
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
  }

  #publish(s: BatteryState): void {
    this.emitIfChanged('battery', Math.round(s.level * 100)); // 0-1 -> 0-100 (Android parity)
    this.emitIfChanged('charging', chargingToWire(s));
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
  readonly #tracker: MemoryTracker;
  #off: (() => void) | undefined;

  constructor(tracker: MemoryTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('memory', (m) => this.#publish(m));
    const cur = this.#tracker.current();
    if (cur !== undefined) this.#publish(cur);
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #publish(m: MemoryState): void {
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
  readonly #tracker: ConnectionTracker;
  #off: (() => void) | undefined;

  constructor(tracker: ConnectionTracker) {
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

  #publish({ onLine, connection }: ConnectionState): void {
    this.emitIfChanged('connection', {
      type: connectionTypeToWire(connection, onLine),
      // Everything below is DETAIL (the viewer renders `item.data`), so it is omitted rather than sent
      // as undefined — an explicitly absent key is what the other tiers send.
      ...(connection?.effectiveType !== undefined
        ? { effective_type: connection.effectiveType }
        : {}),
      // Android reports bandwidth in kbps (`link_downstream_kbps`); `downlink` is Mbps.
      ...(connection?.downlink !== undefined
        ? { link_downstream_kbps: Math.round(connection.downlink * 1000) }
        : {}),
      ...(connection?.rtt !== undefined ? { rtt: connection.rtt } : {}),
      ...(connection?.saveData !== undefined ? { save_data: connection.saveData } : {}),
    });
  }
}

export class OrientationProducer extends TraceProducerBase {
  readonly name = 'orientation';
  readonly #tracker: OrientationTracker;
  #off: (() => void) | undefined;

  constructor(tracker: OrientationTracker) {
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

  #publish(s: OrientationState): void {
    this.emitIfChanged('orientation', orientationToWire(s.type, s.angle));
  }
}

/**
 * `document.visibilityState` → `app_state`, in Android's vocabulary (`foreground` / `background`; the viewer's
 * table is `started` / `foreground` / `background`), never the raw `visible` / `hidden` / `prerender`. A step
 * curve, so it is held and de-duplicated; the initial value is read from the document (absent = no initial
 * value, only changes). `process_foreground` / `process_background` events stay in the events source.
 */
export class AppStateProducer extends TraceProducerBase {
  readonly name = 'app-state';
  readonly #lifecycle: Pick<PageLifecycleTracker, 'on'>;
  readonly #document: { readonly visibilityState?: string } | undefined;
  #off: (() => void) | undefined;

  constructor(
    lifecycle: Pick<PageLifecycleTracker, 'on'>,
    document: { readonly visibilityState?: string } | undefined,
  ) {
    super();
    this.#lifecycle = lifecycle;
    this.#document = document;
  }

  protected onStart(): void {
    this.#off = this.#lifecycle.on('visibility', ({ visible }) =>
      this.emitIfChanged('app_state', visible ? 'foreground' : 'background'),
    );
    try {
      const state = this.#document?.visibilityState;
      if (state !== undefined)
        this.emitIfChanged('app_state', state === 'visible' ? 'foreground' : 'background');
    } catch {
      /* an unreadable document yields no initial value; the next visibility change still reports */
    }
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/** `fps` (Android parity): polled, so each window's rate is emitted and never held or refreshed. */
export class FpsProducer extends TraceProducerBase {
  readonly name = 'fps';
  readonly #tracker: FpsTracker;
  #off: (() => void) | undefined;

  constructor(tracker: FpsTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('fps', (fps) => this.emit('fps', fps));
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/**
 * `screen_size` (JS-specific; deliberately NOT Android's `displays`, a display LIST): `{ width, height, dpr }` in
 * CSS px, re-read on `resize` / `orientationchange`. A step curve, so it is held and de-duplicated (a resize that
 * moved nothing is dropped); the initial value is emitted at start. Omitted entirely when the screen or the pixel
 * ratio cannot be read as finite positive numbers.
 */
export class ScreenSizeProducer extends TraceProducerBase {
  readonly name = 'screen-size';
  readonly #tracker: ScreenSizeTracker;
  #off: (() => void) | undefined;

  constructor(tracker: ScreenSizeTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('state', (s) => this.#publish(s)); // subscribing attaches the listeners
    const cur = this.#tracker.current();
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
 * `main_thread_lag_ms`: the latest `MessageChannel` round-trip delta, once per sampling tick, ONLY while the page
 * is visible (a hidden tab's throttled timers would paint a hang that did not happen). Polled, so each value is
 * emitted and never held or refreshed; nothing measured yet means nothing emitted.
 */
export class MainThreadLagProducer extends TraceProducerBase {
  readonly name = 'main-thread-lag';
  readonly #tracker: MainThreadLagTracker;
  #off: (() => void) | undefined;

  constructor(tracker: MainThreadLagTracker) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#off = this.#tracker.on('lag', (ms) => this.emit('main_thread_lag_ms', ms));
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/**
 * Injected browser surfaces. Each is optional and an absent one is simply not sampled; pass the LIVE
 * objects (`navigator`, `performance`, `screen`, `window`) — never a spread copy, since a real
 * `navigator` keeps `onLine` / `connection` / `deviceMemory` as accessors on its prototype.
 */
export interface BrowserTraceEnv extends BatteryEnv {
  performance?: { readonly memory?: MemoryReading; now?(): number };
  navigator?: ConnectionEnv['navigator'] & {
    /** `navigator.deviceMemory` in GiB — a coarse bucket, not a measurement. */
    readonly deviceMemory?: number;
  };
  screen?: OrientationEnv['screen'] & ScreenSizeEnv['screen'];
  /** Source of `online` / `offline` / `orientationchange` / `resize`, and the live `devicePixelRatio`. */
  window?: ConnectionEnv['window'] & ScreenSizeEnv['window'];
  /** The document the SDK is bound to: visibility for `app_state` and `fps`. */
  document?: FpsEnv['document'];
  /** `window.requestAnimationFrame` / `cancelAnimationFrame` (bound to that window): drive `fps`. */
  requestAnimationFrame?: FpsEnv['requestAnimationFrame'];
  cancelAnimationFrame?: FpsEnv['cancelAnimationFrame'];
  /** `window.MessageChannel` (the injected window's constructor): drives `main_thread_lag_ms`. */
  MessageChannel?: MainThreadLagEnv['MessageChannel'];
  /**
   * `false` builds the battery producer ONLY: a caller-supplied `systemMetricsSampler` replaces the heap,
   * connection, orientation, `app_state`, `fps`, `screen_size` and `main_thread_lag_ms` traces (as on Node), so the sensor producers must not also emit them.
   */
  sensors?: boolean;
  /** Drives the heap poll; default the global timers. */
  scheduler?: Scheduler;
  /** Shared page-lifecycle tracker for connection/orientation; when absent each listens on `window`. */
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
}

interface WindowSurfaces {
  navigator?: BrowserTraceEnv['navigator'] & { getBattery?: () => Promise<BatteryManagerLike> };
  performance?: BrowserTraceEnv['performance'];
  screen?: BrowserTraceEnv['screen'];
  requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  MessageChannel?: BrowserTraceEnv['MessageChannel'];
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
  // A constructor needs no `this`, so it is handed over as read (it still belongs to THIS window).
  const messageChannel = read(() => win.MessageChannel);
  return {
    ...(nav !== undefined ? { navigator: nav } : {}),
    ...(performance !== undefined ? { performance } : {}),
    ...(screen !== undefined ? { screen } : {}),
    window: source as NonNullable<BrowserTraceEnv['window']>,
    ...(document !== undefined ? { document } : {}),
    ...(typeof raf === 'function' ? { requestAnimationFrame: (cb) => raf.call(win, cb) } : {}),
    ...(typeof caf === 'function' ? { cancelAnimationFrame: (h) => caf.call(win, h) } : {}),
    ...(typeof messageChannel === 'function' ? { MessageChannel: messageChannel } : {}),
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
  const perf = env.performance;
  const nav = env.navigator;
  const battery = new BatteryProducer(
    new BatteryTracker(env.getBattery ? { getBattery: env.getBattery } : {}, onError),
  );
  if (env.sensors === false) return [battery];
  return [
    battery,
    new MemoryProducer(
      new MemoryTracker({
        // Read through `env.performance` on every poll: `performance.memory` is a live getter.
        memory: () => perf?.memory,
        ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
        ...(onError !== undefined ? { onError } : {}),
      }),
    ),
    new AdvertisedMemoryProducer(() => nav?.deviceMemory),
    new ConnectionProducer(
      new ConnectionTracker(
        {
          ...(env.lifecycle !== undefined ? { lifecycle: env.lifecycle } : {}),
          ...(env.window !== undefined ? { window: env.window } : {}),
          ...(nav !== undefined ? { navigator: nav } : {}),
        },
        onError,
      ),
    ),
    new OrientationProducer(
      new OrientationTracker(
        {
          ...(env.lifecycle !== undefined ? { lifecycle: env.lifecycle } : {}),
          ...(env.window !== undefined ? { window: env.window } : {}),
          ...(env.screen !== undefined ? { screen: env.screen } : {}),
        },
        onError,
      ),
    ),
    ...(env.lifecycle !== undefined
      ? [
          new AppStateProducer(env.lifecycle, env.document),
          new ScreenSizeProducer(
            new ScreenSizeTracker(
              {
                lifecycle: env.lifecycle,
                ...(env.window !== undefined ? { window: env.window } : {}),
                ...(env.screen !== undefined ? { screen: env.screen } : {}),
              },
              onError,
            ),
          ),
          new MainThreadLagProducer(
            new MainThreadLagTracker(
              {
                lifecycle: env.lifecycle,
                ...(env.document !== undefined ? { document: env.document } : {}),
                ...(env.MessageChannel !== undefined ? { MessageChannel: env.MessageChannel } : {}),
                ...(safePerformanceNow(env, onError) !== undefined
                  ? { now: () => (env.performance as { now(): number }).now() }
                  : {}),
                ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
              },
              onError,
            ),
          ),
          new FpsProducer(
            new FpsTracker(
              {
                lifecycle: env.lifecycle,
                ...(env.document !== undefined ? { document: env.document } : {}),
                ...(env.requestAnimationFrame !== undefined
                  ? { requestAnimationFrame: env.requestAnimationFrame }
                  : {}),
                ...(env.cancelAnimationFrame !== undefined
                  ? { cancelAnimationFrame: env.cancelAnimationFrame }
                  : {}),
                ...(safePerformanceNow(env, onError) !== undefined
                  ? // A clock that becomes unreadable later THROWS (the tracker's tick reports and skips the window)
                    // rather than answering a made-up 0.
                    { now: () => (env.performance as { now(): number }).now() }
                  : {}),
                ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
              },
              onError,
            ),
          ),
        ]
      : []),
  ];
}
