import { createTrackerRegistry } from '../tracker-registry';
import { bindAll, ElectronStageTracker, type EmitterSource } from './stage-tracker';

// Electron MAIN-process POWER tracker (domain tracker, design §15.2/§15.4 TR9; Android reference: BugseeTrackerPower).
// It owns what Electron's `powerMonitor` can say, as THREE stages, each arming its own pair of `powerMonitor`
// listeners only while it has a subscriber and releasing them when the last leaves:
//
//   suspendResume  'suspend' / 'resume'            -> { state: 'suspend' | 'resume' }
//   lockScreen     'lock-screen' / 'unlock-screen' -> { state: 'lock' | 'unlock' }      (macOS/Windows; never fires on Linux)
//   powerSource    'on-ac' / 'on-battery'          -> { source: 'ac' | 'battery' }
//
// `current('powerSource')` is a LIVE read of `powerMonitor.isOnBatteryPower()`; it answers undefined when the monitor has
// no such method, it throws (reported) or returns a non-boolean: a source is never guessed. `thermal-state-change` and
// `speed-limit-change` are deliberately NOT mapped: they are macOS-only and the thermal state is not Android's int enum.
// `electron` is never imported: the monitor is INJECTED as a structural {@link PowerMonitorSource}.
//
// SINGLETON per `powerMonitor` object (`electronPowerTrackerFor`); a relaunch only rebinds the reporter.

/** The slice of Electron's `powerMonitor` this tracker reads. Every member is optional: an absent one means the stage is absent. */
export interface PowerMonitorSource extends EmitterSource {
  isOnBatteryPower?(): unknown;
}

export interface ElectronPowerEvents {
  suspendResume: { state: 'suspend' | 'resume' };
  lockScreen: { state: 'lock' | 'unlock' };
  powerSource: { source: 'ac' | 'battery' };
}

export interface ElectronPowerEnv {
  /** Electron's `powerMonitor` (or a structural fake). */
  powerMonitor?: PowerMonitorSource;
}

type PowerStage = keyof ElectronPowerEvents;

const STAGE_EVENTS: Record<PowerStage, Array<[string, ElectronPowerEvents[PowerStage]]>> = {
  suspendResume: [
    ['suspend', { state: 'suspend' }],
    ['resume', { state: 'resume' }],
  ],
  lockScreen: [
    ['lock-screen', { state: 'lock' }],
    ['unlock-screen', { state: 'unlock' }],
  ],
  powerSource: [
    ['on-ac', { source: 'ac' }],
    ['on-battery', { source: 'battery' }],
  ],
};

export class ElectronPowerTracker extends ElectronStageTracker<ElectronPowerEvents> {
  readonly name = 'electron-power';
  protected readonly stages: readonly PowerStage[] = ['suspendResume', 'lockScreen', 'powerSource'];
  readonly #monitor: PowerMonitorSource | undefined;

  constructor(env: ElectronPowerEnv = {}, onError?: (error: unknown) => unknown) {
    super(onError);
    this.#monitor = env.powerMonitor;
  }

  /** Hand the latest launch's reporter to this shared tracker (a defined `onError` replaces it, undefined keeps it). */
  rebind(onError?: (error: unknown) => unknown): void {
    this.setReporter(onError);
  }

  /** The live power source: `battery` / `ac`, or undefined when the monitor cannot say (never guessed). */
  current(stage: 'powerSource'): ElectronPowerEvents['powerSource'] | undefined {
    const monitor = this.#monitor;
    if (stage !== 'powerSource' || typeof monitor?.isOnBatteryPower !== 'function')
      return undefined;
    try {
      const onBattery = monitor.isOnBatteryPower();
      if (typeof onBattery !== 'boolean') return undefined;
      return { source: onBattery ? 'battery' : 'ac' };
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  protected attachStage(stage: PowerStage): (() => void) | undefined {
    const monitor = this.#monitor;
    if (monitor === undefined) return undefined;
    return bindAll(
      STAGE_EVENTS[stage].map(([event, payload]) => ({
        src: monitor,
        event,
        listener: () => this.emit(stage, { ...payload } as never),
      })),
      this.report,
    );
  }
}

const registry = createTrackerRegistry<ElectronPowerTracker>();

/**
 * The singleton ElectronPowerTracker for `env.powerMonitor` (keyed on that object; without one there is nothing to key
 * on and the call throws). Every call (a relaunch included) hands the shared tracker the latest launch's `onError`.
 */
export function electronPowerTrackerFor(
  env: ElectronPowerEnv,
  onError?: (error: unknown) => unknown,
): ElectronPowerTracker {
  const key = env.powerMonitor;
  if (key === undefined) throw new TypeError('electronPowerTrackerFor needs a `powerMonitor`');
  return registry.for(
    key,
    () => new ElectronPowerTracker(env, onError),
    (tracker) => tracker.rebind(onError),
  );
}

/** Test/teardown: drop the monitor's tracker (resetting it, so every Electron listener is released). */
export function resetElectronPowerTracker(key: object): void {
  registry.reset(key);
}
