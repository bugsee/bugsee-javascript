import { createTrackerRegistry } from '../tracker-registry';
import { bindAll, ElectronStageTracker, type EmitterSource } from './stage-tracker';

// Electron MAIN-process DISPLAY tracker (domain tracker, design §15.2/§15.4 TR9; Android reference: BugseeTrackerDisplay).
// It owns what Electron's `screen` can say, as FOUR stages, each arming its own `screen` listeners only while it has a
// subscriber:
//
//   displayAdded          'display-added'           -> DisplayInfo
//   displayRemoved        'display-removed'         -> DisplayInfo
//   displayMetricsChanged 'display-metrics-changed' -> { display: DisplayInfo, changed: string[] }
//   displays              any of the three above    -> { displays: DisplayInfo[] }   (the fresh `getAllDisplays()` list)
//
// `current('displays')` is a LIVE `screen.getAllDisplays()` read. {@link DisplayInfo} keeps only what is safe and stable:
// `id`, `width`/`height` (Electron's `size`, device-independent pixels; `bounds` as a fallback), and, when Electron gave
// them, `scaleFactor`, `rotation` (0/90/180/270), `internal`, `refreshRate` (Hz). A display with no usable id or size is
// DROPPED (id -1 is Electron's 'invalid or not yet known' marker; id -10, the virtual unified display, is kept as
// reported), an empty list is `undefined`, and a throwing/hostile `getAllDisplays` is reported and omitted: nothing is
// fabricated and absence is never zero. Display `label`, `bounds` position and `workArea` are not kept.
// `electron` is never imported: `screen` is INJECTED as a structural {@link ScreenSource}.
//
// HELD-VALUE CAVEAT for the `electron_displays` trace built on `displays`: a refresh that cannot read a usable list
// emits nothing, so the previous list stays held (and is re-recorded every refreshMs). Absence is true only BEFORE the first
// emit. This is the same open owner decision as storage_estimate / user_idle_state (docs/PROGRESS.md).
//
// SINGLETON per `screen` object (`electronDisplayTrackerFor`); a relaunch only rebinds the reporter.

/** The slice of Electron's `screen` this tracker reads. */
export interface ScreenSource extends EmitterSource {
  getAllDisplays?(): unknown;
}

export interface DisplayInfo {
  id: number;
  /** Device-independent pixels (Electron's `size`). */
  width: number;
  height: number;
  scaleFactor?: number;
  rotation?: 0 | 90 | 180 | 270;
  internal?: boolean;
  /** Hz. */
  refreshRate?: number;
}

export interface ElectronDisplayEvents {
  displayAdded: DisplayInfo;
  displayRemoved: DisplayInfo;
  displayMetricsChanged: { display: DisplayInfo; changed: string[] };
  displays: { displays: DisplayInfo[] };
}

export interface ElectronDisplayEnv {
  /** Electron's `screen` (or a structural fake). */
  screen?: ScreenSource;
}

type DisplayStage = keyof ElectronDisplayEvents;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const positive = (value: unknown): number | undefined => {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
};

/** Maps one Electron `Display`; undefined unless it has an id and a positive size. */
/** At most 2 decimals: Electron reports raw floats (real: `displayFrequency` 59.996700286865234). */
const round2 = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : positive(Math.round(n * 100) / 100); // a value that rounds to 0 is unusable, like 0

export function mapDisplay(raw: unknown): DisplayInfo | undefined {
  const d = record(raw);
  if (d === undefined) return undefined;
  const id = finite(d.id);
  // -1 is Electron's 'invalid or not yet known' id: never a real display. (-10 is the virtual unified display and is kept.)
  if (id === -1) return undefined;
  const size = record(d.size) ?? record(d.bounds);
  const width = positive(size?.width);
  const height = positive(size?.height);
  if (id === undefined || width === undefined || height === undefined) return undefined;
  const scaleFactor = round2(positive(d.scaleFactor));
  const rotation =
    d.rotation === 0 || d.rotation === 90 || d.rotation === 180 || d.rotation === 270
      ? d.rotation
      : undefined;
  const refreshRate = round2(positive(d.displayFrequency));
  return {
    id,
    width,
    height,
    ...(scaleFactor !== undefined ? { scaleFactor } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(typeof d.internal === 'boolean' ? { internal: d.internal } : {}),
    ...(refreshRate !== undefined ? { refreshRate } : {}),
  };
}

export class ElectronDisplayTracker extends ElectronStageTracker<ElectronDisplayEvents> {
  readonly name = 'electron-display';
  protected readonly stages: readonly DisplayStage[] = [
    'displayAdded',
    'displayRemoved',
    'displayMetricsChanged',
    'displays',
  ];
  readonly #screen: ScreenSource | undefined;

  constructor(env: ElectronDisplayEnv = {}, onError?: (error: unknown) => unknown) {
    super(onError);
    this.#screen = env.screen;
  }

  /** Hand the latest launch's reporter to this shared tracker (a defined `onError` replaces it, undefined keeps it). */
  rebind(onError?: (error: unknown) => unknown): void {
    this.setReporter(onError);
  }

  /** The live display list, or undefined when Electron cannot say (never an empty/zero list). */
  current(stage: 'displays'): ElectronDisplayEvents['displays'] | undefined {
    const screen = this.#screen;
    if (stage !== 'displays' || screen === undefined) return undefined;
    try {
      // inside the guard: Electron's real `screen` throws on ANY property read before the app is ready
      if (typeof screen.getAllDisplays !== 'function') return undefined;
      const raw = screen.getAllDisplays();
      if (!Array.isArray(raw)) return undefined;
      const displays = raw.map(mapDisplay).filter((d): d is DisplayInfo => d !== undefined);
      return displays.length > 0 ? { displays } : undefined;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  protected attachStage(stage: DisplayStage): (() => void) | undefined {
    const screen = this.#screen;
    if (screen === undefined) return undefined;
    const events: Array<[string, (...args: unknown[]) => void]> = [];
    const mapped =
      (fn: (display: DisplayInfo, args: unknown[]) => void) =>
      (...args: unknown[]) => {
        const display = mapDisplay(args[1]);
        if (display !== undefined) fn(display, args);
      };
    if (stage === 'displayAdded') {
      events.push(['display-added', mapped((d) => this.emit('displayAdded', d))]);
    } else if (stage === 'displayRemoved') {
      events.push(['display-removed', mapped((d) => this.emit('displayRemoved', d))]);
    } else if (stage === 'displayMetricsChanged') {
      events.push([
        'display-metrics-changed',
        mapped((display, args) =>
          this.emit('displayMetricsChanged', { display, changed: changedList(args[2]) }),
        ),
      ]);
    } else {
      const refresh = (): void => {
        const list = this.current('displays');
        if (list !== undefined) this.emit('displays', list);
      };
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
        events.push([event, refresh]);
      }
    }
    return bindAll(
      events.map(([event, listener]) => ({ src: screen, event, listener })),
      this.report,
    );
  }
}

const changedList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const registry = createTrackerRegistry<ElectronDisplayTracker>();

/**
 * The singleton ElectronDisplayTracker for `env.screen` (keyed on that object; without one the call throws). Every call
 * (a relaunch included) hands the shared tracker the latest launch's `onError`.
 */
export function electronDisplayTrackerFor(
  env: ElectronDisplayEnv,
  onError?: (error: unknown) => unknown,
): ElectronDisplayTracker {
  const key = env.screen;
  if (key === undefined) throw new TypeError('electronDisplayTrackerFor needs a `screen`');
  return registry.for(
    key,
    () => new ElectronDisplayTracker(env, onError),
    (tracker) => tracker.rebind(onError),
  );
}

/** Test/teardown: drop the screen's tracker (resetting it, so every Electron listener is released). */
export function resetElectronDisplayTracker(key: object): void {
  registry.reset(key);
}
