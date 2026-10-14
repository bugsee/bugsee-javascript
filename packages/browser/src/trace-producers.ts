import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import { chargingToWire } from './system-trace-values';
import {
  type BatteryEnv,
  type BatteryManagerLike,
  type BatteryState,
  BatteryTracker,
} from './trackers/battery-tracker';

// Browser `traces.system` producers (mirrors the mobile tracker/producer split).

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

/** Reads `navigator` lazily (workers / Node tests may have none) and binds getBattery to it. */
function realBatteryEnv(): BatteryEnv {
  const nav = (
    globalThis as unknown as {
      navigator?: { getBattery?: () => Promise<BatteryManagerLike> };
    }
  ).navigator;
  if (nav === undefined || typeof nav.getBattery !== 'function') return {};
  const getBattery = nav.getBattery;
  return { getBattery: () => getBattery.call(nav) };
}

/**
 * The browser trace producers. `onError` receives a battery failure that happens after getBattery()
 * resolves (a throwing manager getter / addEventListener), which would otherwise be swallowed.
 */
export function createBrowserSystemTraceProducers(
  env?: BatteryEnv,
  onError?: (error: unknown) => void,
): TraceProducer[] {
  return [new BatteryProducer(new BatteryTracker(env ?? realBatteryEnv(), onError))];
}
