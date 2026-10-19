import { InterceptorBase } from '../interceptor-base';
import { createTrackerRegistry } from '../tracker-registry';
import { hostRead } from './host-read';

// Browser POWER tracker (domain tracker, design §15.3 item 5; Android reference: BugseeTrackerPower). It wraps the
// FULL Battery Status API: level, charging, chargingTime, dischargingTime and the four events levelchange,
// chargingchange, chargingtimechange, dischargingtimechange. Every one of them yields the same `state` snapshot.
//
// SINGLETON per key object (see `powerTrackerFor`). RETENTION rule — what survives the last unsubscribe:
//   * the resolved BatteryManager (getBattery() is awaited ONCE per tracker, never again per activation), and
//   * the last snapshot (`current()` keeps answering with it).
// What does NOT survive: the DOM listeners on the manager. They are removed when nobody subscribes and re-attached
// on the next subscriber, which also reads a FRESH snapshot (the retained one may be stale). A getBattery() still in
// flight at the last unsubscribe is IGNORED when it resolves (a generation token) and the next activation asks again;
// a rejected/throwing getBattery() is likewise retried on the next activation.

export interface BatteryManagerLike {
  level: number;
  charging: boolean;
  chargingTime?: number;
  dischargingTime?: number;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
export interface BatteryState {
  /** 0..1. Omitted when the manager reports something that is not a finite number in [0, 1]. */
  level?: number;
  charging: boolean;
  /** Seconds until fully charged. Omitted when the browser reports Infinity/NaN/a negative (unknown). */
  chargingTimeS?: number;
  /** Seconds until empty. Omitted when the browser reports Infinity/NaN/a negative (unknown). */
  dischargingTimeS?: number;
}
/** All the tracker needs from a launch: the way to reach the BatteryManager. */
export interface BatteryEnv {
  getBattery?: () => Promise<BatteryManagerLike>;
}

const EVENTS = [
  'levelchange',
  'chargingchange',
  'chargingtimechange',
  'dischargingtimechange',
] as const;

/** A usable duration in seconds, or undefined (Infinity = "unknown", NaN/negative/non-number are never sent). */
function finiteSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class PowerTracker extends InterceptorBase<{ state: BatteryState }> {
  readonly name = 'browser-power';
  #getBattery: BatteryEnv['getBattery'];
  #generation = 0;
  #running = false;
  /** Retained across deactivation (see the retention rule). */
  #manager: BatteryManagerLike | undefined;
  #state: BatteryState | undefined;
  /** Present only while the DOM listeners are attached. */
  #attached: { manager: BatteryManagerLike; onChange: () => void } | undefined;

  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => void) | undefined };

  constructor(env: BatteryEnv, onError?: (error: unknown) => void) {
    const report = { fn: onError };
    super((error) => report.fn?.(error));
    this.#report = report;
    this.#getBattery = env.getBattery;
  }

  /**
   * Hand the latest launch's seams to this shared tracker. A defined `onError` replaces the reporter (undefined
   * keeps it). A defined `getBattery` replaces ours only while we hold no resolved manager (a resolved manager is
   * retained: it belongs to the same window) or when we had none at all; if the tracker is already running and
   * had no getBattery at all, it asks right away instead of waiting for the next activation.
   */
  rebind(env: BatteryEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    const next = env.getBattery;
    if (next === undefined) return; // a relaunch without one never clobbers ours
    const hadNone = this.#getBattery === undefined;
    this.#getBattery = next;
    // Only a tracker that had NOTHING to ask with kicks now (anything else already has a request in flight or a
    // retry pending on the next activation).
    if (hadNone && this.#running) this.#request(++this.#generation);
  }

  #onError(error: unknown): void {
    this.#report.fn?.(error);
  }

  /** Latest snapshot; undefined until the first one is read. Retained after the last unsubscribe. */
  current(): BatteryState | undefined {
    return this.#state;
  }

  /** Test/teardown: forget the manager and the snapshot and release the listeners. */
  reset(): void {
    this.#generation += 1;
    this.#detach();
    this.#manager = undefined;
    this.#state = undefined;
  }

  protected onActivate(): void {
    this.#running = true;
    const mine = ++this.#generation;
    if (this.#manager !== undefined) {
      this.#attach(this.#manager); // retained: no second getBattery()
      return;
    }
    this.#request(mine);
  }

  #request(mine: number): void {
    try {
      this.#getBattery?.().then(
        (manager) => {
          if (this.#generation !== mine) return; // stopped (or restarted) while in flight
          this.#manager = manager;
          this.#attach(manager);
        },
        () => {}, // unsupported / denied -> no power traces
      );
    } catch {
      /* a synchronous SecurityError just means no power traces */
    }
  }

  // May run inside the getBattery() fulfilment: a throw there would reject a promise nobody handles, so the
  // whole body is guarded. On failure the listeners attached so far are removed and no baseline is kept; the manager
  // stays retained and the next activation retries.
  #attach(manager: BatteryManagerLike): void {
    const onChange = (): void => {
      try {
        this.#publish(manager);
      } catch (error) {
        this.#onError(error); // never throw into the BatteryManager's event dispatch
      }
    };
    // Recorded BEFORE attaching (and before the baseline publish), so a subscriber that leaves
    // synchronously during the publish — or the unwind below — detaches exactly these.
    this.#attached = { manager, onChange };
    try {
      for (const type of EVENTS) manager.addEventListener?.(type, onChange);
      this.#publish(manager);
    } catch (error) {
      this.#detach(); // removing a never-added listener is a no-op (DOM semantics)
      this.#state = undefined; // no baseline was established
      this.#onError(error);
    }
  }

  protected override onDeactivate(): void {
    this.#running = false;
    this.#generation += 1; // invalidate any in-flight fetch
    this.#detach(); // listeners go; manager and snapshot are retained
  }

  /** Removes the change listeners (best-effort). */
  #detach(): void {
    const attached = this.#attached;
    this.#attached = undefined;
    if (attached === undefined) return;
    const { manager, onChange } = attached;
    for (const type of EVENTS) {
      try {
        manager.removeEventListener?.(type, onChange);
      } catch {
        /* best-effort */
      }
    }
  }

  #publish(manager: BatteryManagerLike): void {
    const rawLevel = manager.level; // getters may throw
    const charging = manager.charging;
    const level =
      typeof rawLevel === 'number' && rawLevel >= 0 && rawLevel <= 1 ? rawLevel : undefined; // unusable: omit, never emit NaN
    const report = (error: unknown): void => this.#onError(error);
    // The times are optional extras: a hostile getter costs only that field (reported), never level/charging.
    let chargingTimeS = finiteSeconds(hostRead(() => manager.chargingTime, report));
    let dischargingTimeS = finiteSeconds(hostRead(() => manager.dischargingTime, report));
    // Zero is not an estimate here: a battery-less desktop reports level 1, charging, chargingTime 0; and a
    // discharging battery can never have 0 s left.
    if (chargingTimeS === 0 && charging === true && level !== undefined && level >= 1) {
      chargingTimeS = undefined;
    }
    if (dischargingTimeS === 0) dischargingTimeS = undefined;
    const state: BatteryState = {
      ...(level !== undefined ? { level } : {}),
      charging,
      ...(chargingTimeS !== undefined ? { chargingTimeS } : {}),
      ...(dischargingTimeS !== undefined ? { dischargingTimeS } : {}),
    };
    this.#state = state;
    this.emit('state', state);
  }
}

const registry = createTrackerRegistry<PowerTracker>();

/** A {@link BatteryEnv} plus the objects the singleton is keyed on. */
export interface PowerEnv extends BatteryEnv {
  window?: object;
  navigator?: object;
}

// The key is the window the SDK is bound to; failing that the navigator getBattery came from; failing that the env
// object itself (an ad-hoc env then gets a private tracker). Host reads are guarded AND reported.
function keyOf(env: PowerEnv, onError?: (error: unknown) => void): object {
  const win = hostRead(() => env.window, onError);
  if (typeof win === 'object' && win !== null) return win;
  const nav = hostRead(() => env.navigator, onError);
  if (typeof nav === 'object' && nav !== null) return nav;
  return env;
}

/**
 * The singleton PowerTracker for the env's window. Every call (a relaunch included) hands the shared tracker the
 * latest launch's `onError` and `getBattery` (see {@link PowerTracker.rebind}); nothing else of the env is kept.
 */
export function powerTrackerFor(env: PowerEnv, onError?: (error: unknown) => void): PowerTracker {
  const seams: BatteryEnv = env.getBattery !== undefined ? { getBattery: env.getBattery } : {};
  return registry.for(
    keyOf(env, onError),
    () => new PowerTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/** Test/teardown: drop the env's tracker (resetting it, so its listeners are released). */
export function resetPowerTracker(env: PowerEnv): void {
  registry.reset(keyOf(env));
}
