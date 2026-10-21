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
// `current('displays')` is a LIVE `screen.getAllDisplays()` read. {@link DisplayInfo} is the MOBILE `displays` entry in
// camelCase (spec bundle/traces.md `displays`): `id` is a small per-session index (the display set at the first read is
// numbered from 0 with `screen.getPrimaryDisplay()` FIRST, later displays take the next unused number, a number is NEVER
// reused within a SESSION even after a display is removed; the numbering is forgotten when the LAST subscriber leaves
// (a session stop / relaunch), so the next session numbers again from 0 with the then-current primary first), `nativeId` is Electron's own id (can exceed int32),
// `width`/`height` are DEVICE pixels in the CURRENT orientation (`size` x `scaleFactor`, rounded), `naturalWidth`/
// `naturalHeight` the rotation-0 device pixels (swapped for quarter turns 1 and 3; omitted when the rotation is unknown),
// `scale` = `scaleFactor`, `maxFps` = `displayFrequency` rounded, `rotation` in QUARTER TURNS 0-3 (Electron's 0/90/180/270
// divided by 90), `type` internal|external from `internal`, and `state:'on'` on the CURRENT primary display only (Electron
// cannot observe power; the spec says a producer that cannot observe power marks the one display the app is on).
// A display with no usable id or size is DROPPED (id -1 is Electron's 'invalid or not yet known' marker; id -10, the
// virtual unified display, is kept as reported), an empty list is `undefined`, and a throwing/hostile `getAllDisplays` is
// reported and omitted: nothing is fabricated and absence is never zero. Without a readable `scaleFactor` the factor is 1
// and `scale` is omitted (Electron always supplies it). Display `label`, `bounds` position and `workArea` are not kept.
// `electron` is never imported: `screen` is INJECTED as a structural {@link ScreenSource}.
//
// HELD-VALUE CAVEAT for the `displays` trace built on the `displays` stage: a refresh that cannot read a usable list
// emits nothing, so the previous list stays held (and is re-recorded every refreshMs). Absence is true only BEFORE the first
// emit. This is the same open owner decision as storage_estimate / user_idle_state (docs/PROGRESS.md).
//
// SINGLETON per `screen` object (`electronDisplayTrackerFor`); a relaunch only rebinds the reporter.

/** The slice of Electron's `screen` this tracker reads. */
export interface ScreenSource extends EmitterSource {
  getAllDisplays?(): unknown;
  getPrimaryDisplay?(): unknown;
}

/** What one Electron `Display` says, before the session index is assigned (see {@link DisplayInfo}). */
export interface MappedDisplay {
  /** Electron's own display id (`Display.id`). */
  nativeId: number;
  /** Device pixels, current orientation. */
  width: number;
  height: number;
  /** Device pixels, rotation 0. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Device pixels per DIP (`scaleFactor`). */
  scale?: number;
  /** Hz, rounded. */
  maxFps?: number;
  /** Quarter turns, 0-3. */
  rotation?: 0 | 1 | 2 | 3;
  type?: 'internal' | 'external';
}

/** A {@link MappedDisplay} with its stable per-session `id` (and `state` on the primary display of a list read). */
export interface DisplayInfo extends MappedDisplay {
  id: number;
  state?: 'on';
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

/**
 * Electron's `rotation` degrees -> quarter turns. Electron's typings document `Display.rotation` as clockwise degrees
 * (0/90/180/270). The trace field means Android's `Surface.ROTATION_*` (0-3). Whether Electron's clockwise degrees map to
 * Android's quarter turns by plain division by 90 on a real rotated display is UNVERIFIED (docs/PROGRESS.md); the numbers
 * here are the plain division and are not adjusted.
 */
const ROTATION_TURNS = new Map<number, 0 | 1 | 2 | 3>([
  [0, 0],
  [90, 1],
  [180, 2],
  [270, 3],
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const positive = (value: unknown): number | undefined => {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
};

/** At most 2 decimals: Electron reports raw floats (real: `displayFrequency` 59.996700286865234). */
const round2 = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : positive(Math.round(n * 100) / 100); // a value that rounds to 0 is unusable, like 0

/** Maps one Electron `Display`; undefined unless it has an id and a positive size. */
export function mapDisplay(raw: unknown): MappedDisplay | undefined {
  const d = record(raw);
  if (d === undefined) return undefined;
  const nativeId = finite(d.id);
  // -1 is Electron's 'invalid or not yet known' id: never a real display. (-10 is the virtual unified display and is kept.)
  if (nativeId === -1) return undefined;
  const size = record(d.size) ?? record(d.bounds);
  const dipWidth = positive(size?.width);
  const dipHeight = positive(size?.height);
  if (nativeId === undefined || dipWidth === undefined || dipHeight === undefined) return undefined;
  const factor = positive(d.scaleFactor) ?? 1;
  const width = Math.round(dipWidth * factor);
  const height = Math.round(dipHeight * factor);
  if (width <= 0 || height <= 0) return undefined;
  const scale = round2(positive(d.scaleFactor));
  const turns = ROTATION_TURNS.get(d.rotation as number);
  const swap = turns === 1 || turns === 3;
  const maxFps = positive(d.displayFrequency);
  const roundedFps = maxFps === undefined ? undefined : positive(Math.round(maxFps));
  return {
    nativeId,
    width,
    height,
    ...(turns !== undefined
      ? { naturalWidth: swap ? height : width, naturalHeight: swap ? width : height }
      : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(roundedFps !== undefined ? { maxFps: roundedFps } : {}),
    ...(turns !== undefined ? { rotation: turns } : {}),
    ...(typeof d.internal === 'boolean' ? { type: d.internal ? 'internal' : 'external' } : {}),
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
  /** Electron's display id -> the session index. Grows within a session (a number is never reused); cleared with the last subscriber. */
  readonly #ids = new Map<number, number>();

  constructor(env: ElectronDisplayEnv = {}, onError?: (error: unknown) => unknown) {
    super(onError);
    this.#screen = env.screen;
  }

  /** Hand the latest launch's reporter to this shared tracker (a defined `onError` replaces it, undefined keeps it). */
  rebind(onError?: (error: unknown) => unknown): void {
    this.setReporter(onError);
  }

  /** The session index for an Electron display id: the first sight takes the next unused number. */
  #indexOf(nativeId: number): number {
    let id = this.#ids.get(nativeId);
    if (id === undefined) {
      id = this.#ids.size;
      this.#ids.set(nativeId, id);
    }
    return id;
  }

  /** A new session starts numbering from 0 again: forget the numbers once nothing listens any more. */
  protected override onListenersChanged(): void {
    super.onListenersChanged();
    if (this.stages.every((stage) => this.listenerCount(stage) === 0)) this.#ids.clear();
  }

  /**
   * The Electron id of the primary display, GUARDED on its own: a throwing/hostile `getPrimaryDisplay` is reported once
   * and answers undefined, so the list is still produced (just without `state`, and not primary-first).
   */
  #primaryNativeId(screen: ScreenSource): number | undefined {
    try {
      if (typeof screen.getPrimaryDisplay !== 'function') return undefined;
      return mapDisplay(screen.getPrimaryDisplay())?.nativeId;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /** The first read numbers the primary display 0 (the order of `getAllDisplays()` is not documented), then the rest. */
  #seed(primary: number | undefined, all: readonly MappedDisplay[]): void {
    if (this.#ids.size > 0) return;
    if (primary !== undefined) this.#indexOf(primary);
    for (const d of all) this.#indexOf(d.nativeId);
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
      const mapped = raw.map(mapDisplay).filter((d): d is MappedDisplay => d !== undefined);
      if (mapped.length === 0) return undefined;
      const primary = this.#primaryNativeId(screen);
      this.#seed(primary, mapped);
      const displays = mapped.map(
        (d): DisplayInfo => ({
          id: this.#indexOf(d.nativeId),
          ...d,
          ...(d.nativeId === primary ? { state: 'on' as const } : {}),
        }),
      );
      return { displays };
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /** A display from an event argument, with its session index (seeding the numbering on the first sight). */
  #identify(raw: unknown): DisplayInfo | undefined {
    const display = mapDisplay(raw);
    const screen = this.#screen;
    if (display === undefined || screen === undefined) return undefined;
    try {
      if (this.#ids.size === 0 && typeof screen.getAllDisplays === 'function') {
        const all = screen.getAllDisplays();
        this.#seed(
          this.#primaryNativeId(screen),
          Array.isArray(all)
            ? all.map(mapDisplay).filter((d): d is MappedDisplay => d !== undefined)
            : [],
        );
      }
    } catch (error) {
      this.report(error);
    }
    // Without `getAllDisplays` nothing seeds the numbering, so an event's display takes the next unused number (0 when it
    // is the first thing seen) even when it is not the primary.
    return { id: this.#indexOf(display.nativeId), ...display };
  }

  protected attachStage(stage: DisplayStage): (() => void) | undefined {
    const screen = this.#screen;
    if (screen === undefined) return undefined;
    const events: Array<[string, (...args: unknown[]) => void]> = [];
    const mapped =
      (fn: (display: DisplayInfo, args: unknown[]) => void) =>
      (...args: unknown[]) => {
        const display = this.#identify(args[1]);
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
