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

  readonly #onError: ((error: unknown) => void) | undefined;

  constructor(env: BatteryEnv, onError?: (error: unknown) => void) {
    super(onError);
    this.#env = env;
    this.#onError = onError;
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
          this.#attach(manager);
        },
        () => {}, // unsupported / denied -> no battery traces
      );
    } catch {
      /* a synchronous SecurityError just means no battery traces */
    }
  }

  // Runs inside the getBattery() fulfilment: a throw here would reject a promise nobody handles, so the
  // whole body is guarded. On failure everything attached so far is detached and no baseline is kept;
  // the next activation retries.
  #attach(manager: BatteryManagerLike): void {
    const onChange = (): void => {
      try {
        this.#publish(manager);
      } catch (error) {
        this.#onError?.(error); // never throw into the BatteryManager's event dispatch
      }
    };
    // Recorded BEFORE attaching (and before the baseline publish), so a subscriber that leaves
    // synchronously during the publish — or the unwind below — detaches exactly these.
    this.#manager = manager;
    this.#onChange = onChange;
    try {
      manager.addEventListener?.('levelchange', onChange);
      manager.addEventListener?.('chargingchange', onChange);
      this.#publish(manager);
    } catch (error) {
      this.#detach(); // removing a never-added listener is a no-op (DOM semantics)
      this.#onError?.(error);
    }
  }

  protected override onDeactivate(): void {
    this.#generation += 1; // invalidate any in-flight fetch
    this.#detach();
  }

  /** Removes the change listeners (best-effort) and forgets the manager and its state. */
  #detach(): void {
    const manager = this.#manager;
    const onChange = this.#onChange;
    this.#manager = undefined;
    this.#onChange = undefined;
    this.#state = undefined;
    if (manager === undefined || onChange === undefined) return;
    for (const type of ['levelchange', 'chargingchange']) {
      try {
        manager.removeEventListener?.(type, onChange);
      } catch {
        /* best-effort */
      }
    }
  }

  #publish(manager: BatteryManagerLike): void {
    const state = { level: manager.level, charging: manager.charging }; // getters may throw
    this.#state = state;
    this.emit('state', state);
  }
}
