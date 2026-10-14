import { InterceptorBase } from '@bugsee/core';

// Browser battery TRACKER (mirrors the mobile tracker/producer split): wraps navigator.getBattery(). It calls
// getBattery() only on first subscription, listens to levelchange/chargingchange, and releases everything on the
// last unsubscribe. A generation token makes a late-resolving getBattery() after stop (or stop -> start) inert.

export interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
export interface BatteryState {
  level: number;
  charging: boolean;
}
export interface BatteryEnv {
  getBattery?: () => Promise<BatteryManagerLike>;
}

export class BatteryTracker extends InterceptorBase<{ state: BatteryState }> {
  readonly name = 'browser-battery';
  readonly #env: BatteryEnv;
  #generation = 0;
  #manager: BatteryManagerLike | undefined;
  #state: BatteryState | undefined;
  #onChange: (() => void) | undefined;

  constructor(env: BatteryEnv, onError?: (error: unknown) => void) {
    super(onError);
    this.#env = env;
  }

  /** Latest state; undefined before getBattery() resolves and after deactivation. */
  current(): BatteryState | undefined {
    return this.#state;
  }

  protected onActivate(): void {
    const mine = ++this.#generation;
    try {
      this.#env.getBattery?.().then(
        (manager) => {
          if (this.#generation !== mine) return; // stopped (or restarted) while in flight
          const onChange = (): void => this.#publish(manager);
          this.#manager = manager;
          this.#onChange = onChange;
          manager.addEventListener?.('levelchange', onChange);
          manager.addEventListener?.('chargingchange', onChange);
          this.#publish(manager);
        },
        () => {}, // unsupported / denied -> no battery traces
      );
    } catch {
      /* a synchronous SecurityError just means no battery traces */
    }
  }

  protected override onDeactivate(): void {
    this.#generation += 1; // invalidate any in-flight fetch
    const onChange = this.#onChange;
    if (onChange !== undefined) {
      this.#manager?.removeEventListener?.('levelchange', onChange);
      this.#manager?.removeEventListener?.('chargingchange', onChange);
    }
    this.#onChange = undefined;
    this.#manager = undefined;
    this.#state = undefined;
  }

  #publish(manager: BatteryManagerLike): void {
    this.#state = { level: manager.level, charging: manager.charging };
    this.emit('state', this.#state);
  }
}
