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
import { type MemoryReading, type MemoryState, MemoryTracker } from './trackers/memory-tracker';
import {
  type OrientationEnv,
  type OrientationState,
  OrientationTracker,
} from './trackers/orientation-tracker';

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
 * Injected browser surfaces. Each is optional and an absent one is simply not sampled; pass the LIVE
 * objects (`navigator`, `performance`, `screen`, `window`) — never a spread copy, since a real
 * `navigator` keeps `onLine` / `connection` / `deviceMemory` as accessors on its prototype.
 */
export interface BrowserTraceEnv extends BatteryEnv {
  performance?: { readonly memory?: MemoryReading };
  navigator?: ConnectionEnv['navigator'] & {
    /** `navigator.deviceMemory` in GiB — a coarse bucket, not a measurement. */
    readonly deviceMemory?: number;
  };
  screen?: OrientationEnv['screen'];
  /** Source of `online` / `offline` / `orientationchange`. */
  window?: ConnectionEnv['window'];
  /**
   * `false` builds the battery producer ONLY: a caller-supplied `systemMetricsSampler` replaces the heap,
   * connection and orientation traces (as on Node), so the sensor producers must not also emit them.
   */
  sensors?: boolean;
  /** Drives the heap poll; default the global timers. */
  scheduler?: Scheduler;
}

/** The real globals, read lazily (workers / Node tests may have none of them). */
export function defaultBrowserTraceEnv(): BrowserTraceEnv {
  const g = globalThis as unknown as {
    navigator?: BrowserTraceEnv['navigator'] & {
      getBattery?: () => Promise<BatteryManagerLike>;
    };
    performance?: BrowserTraceEnv['performance'];
    screen?: BrowserTraceEnv['screen'];
    window?: BrowserTraceEnv['window'];
  };
  const nav = g.navigator;
  const getBattery = nav?.getBattery;
  return {
    ...(nav !== undefined ? { navigator: nav } : {}),
    ...(g.performance !== undefined ? { performance: g.performance } : {}),
    ...(g.screen !== undefined ? { screen: g.screen } : {}),
    ...(g.window !== undefined ? { window: g.window } : {}),
    ...(nav !== undefined && typeof getBattery === 'function'
      ? { getBattery: () => getBattery.call(nav) }
      : {}),
  };
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
          ...(env.window !== undefined ? { window: env.window } : {}),
          ...(nav !== undefined ? { navigator: nav } : {}),
        },
        onError,
      ),
    ),
    new OrientationProducer(
      new OrientationTracker(
        {
          ...(env.window !== undefined ? { window: env.window } : {}),
          ...(env.screen !== undefined ? { screen: env.screen } : {}),
        },
        onError,
      ),
    ),
  ];
}
