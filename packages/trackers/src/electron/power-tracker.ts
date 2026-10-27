import { createTrackerRegistry } from '../tracker-registry';
import { bindAll, ElectronStageTracker, type EmitterSource } from './stage-tracker';

// Electron MAIN-process POWER tracker (domain tracker, design §15.2/§15.4 TR9; Android reference: BugseeTrackerPower).
// It owns what Electron's `powerMonitor` can say, as FIVE stages, each arming its own `powerMonitor` listeners only
// while it has a subscriber and releasing them when the last leaves:
//
//   suspendResume  'suspend' / 'resume'            -> { state: 'suspend' | 'resume' }
//   lockScreen     'lock-screen' / 'unlock-screen' -> { state: 'lock' | 'unlock' }      (macOS/Windows; never fires on Linux)
//   powerSource    'on-ac' / 'on-battery'          -> { source: 'ac' | 'battery' }
//   thermalState   'thermal-state-change'          -> { state: ThermalState }            (macOS only; the Apple enum)
//   speedLimit     'speed-limit-change'            -> { limit: number }                  (macOS/Windows; percent 0-100)
//
// `current('powerSource')` is a LIVE read of `powerMonitor.isOnBatteryPower()`; it answers undefined when the monitor has
// no such method, it throws (reported) or returns a non-boolean: a source is never guessed. `current('thermalState')` is
// the same for `getCurrentThermalState()` (a string Electron documents for macOS; elsewhere the method answers
// 'unknown' or is absent). The tracker only NORMALISES: a thermal state that is not one of Electron's four named states is
// 'unknown' (never passed through) and a speed limit that is not a finite 0-100 number is dropped. WHICH wire value a state
// becomes is the producer's business (packages/electron/src/thermal-state-wire.ts), not this tracker's.
// PLATFORM DEPENDENT: per Electron's typings `on-ac` is documented for macOS and Windows and `on-battery` for macOS
// only, so on Linux (and `on-battery` on Windows) the event may simply never fire; `lock-screen`/`unlock-screen` are
// macOS/Windows. Absence of an event is never evidence of a state: read `current('powerSource')` for the live value.
// `electron` is never imported: the monitor is INJECTED as a structural {@link PowerMonitorSource}.
//
// SINGLETON per `powerMonitor` object (`electronPowerTrackerFor`); a relaunch only rebinds the reporter.

/** The slice of Electron's `powerMonitor` this tracker reads. Every member is optional: an absent one means the stage is absent. */
export interface PowerMonitorSource extends EmitterSource {
  isOnBatteryPower?(): unknown;
  /** macOS only. */
  getCurrentThermalState?(): unknown;
}

/** Electron's `powerMonitor` thermal states (NSProcessInfoThermalState), plus `unknown` for anything else. */
export type ElectronThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical';

const THERMAL_STATES: ReadonlySet<unknown> = new Set(['nominal', 'fair', 'serious', 'critical']);

export interface ElectronPowerEvents {
  suspendResume: { state: 'suspend' | 'resume' };
  lockScreen: { state: 'lock' | 'unlock' };
  powerSource: { source: 'ac' | 'battery' };
  thermalState: { state: ElectronThermalState };
  /** The operating system's advertised CPU speed limit, integer percent 0-100. */
  speedLimit: { limit: number };
}

export interface ElectronPowerEnv {
  /** Electron's `powerMonitor` (or a structural fake). */
  powerMonitor?: PowerMonitorSource;
}

type PowerStage = keyof ElectronPowerEvents;

/** A stage's Electron events: the payload is fixed, or computed from the event's first argument (undefined = drop it). */
type Payload =
  | ElectronPowerEvents[PowerStage]
  | ((detail: unknown) => ElectronPowerEvents[PowerStage] | undefined);

const normaliseThermal = (state: unknown): ElectronThermalState =>
  THERMAL_STATES.has(state) ? (state as ElectronThermalState) : 'unknown';

const thermalOf = (detail: unknown): { state: ElectronThermalState } => ({
  state: normaliseThermal((detail as { state?: unknown } | null | undefined)?.state),
});

const speedLimitOf = (detail: unknown): { limit: number } | undefined => {
  const limit = (detail as { limit?: unknown } | null | undefined)?.limit;
  // the range test also rejects NaN and the infinities (every comparison with them is false)
  return typeof limit === 'number' && limit >= 0 && limit <= 100
    ? { limit: Math.round(limit) }
    : undefined;
};

const STAGE_EVENTS: Record<PowerStage, Array<[string, Payload]>> = {
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
  thermalState: [['thermal-state-change', thermalOf]],
  speedLimit: [['speed-limit-change', speedLimitOf]],
};

export class ElectronPowerTracker extends ElectronStageTracker<ElectronPowerEvents> {
  readonly name = 'electron-power';
  protected readonly stages: readonly PowerStage[] = [
    'suspendResume',
    'lockScreen',
    'powerSource',
    'thermalState',
    'speedLimit',
  ];
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
  current(stage: 'powerSource'): ElectronPowerEvents['powerSource'] | undefined;
  /** The live thermal state (macOS), or undefined when there is no such method / it throws (reported). */
  current(stage: 'thermalState'): ElectronPowerEvents['thermalState'] | undefined;
  current(stage: 'powerSource' | 'thermalState'): unknown {
    const monitor = this.#monitor;
    if (monitor === undefined || (stage !== 'powerSource' && stage !== 'thermalState'))
      return undefined;
    try {
      // inside the guard: a host object that is not ready can throw on ANY property read
      if (stage === 'thermalState') {
        if (typeof monitor.getCurrentThermalState !== 'function') return undefined;
        return { state: normaliseThermal(monitor.getCurrentThermalState()) };
      }
      if (typeof monitor.isOnBatteryPower !== 'function') return undefined;
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
        listener: (detail) => {
          const value = typeof payload === 'function' ? payload(detail) : { ...payload };
          if (value !== undefined) this.emit(stage, value as never);
        },
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
