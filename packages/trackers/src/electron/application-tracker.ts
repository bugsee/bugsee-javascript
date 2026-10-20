import { createTrackerRegistry } from '../tracker-registry';
import { bindAll, ElectronStageTracker, type EmitterSource } from './stage-tracker';

// Electron MAIN-process APPLICATION tracker (domain tracker, design §15.2/§15.4 TR9; Android reference:
// BugseeTrackerApplication). It owns the app's WINDOWS and renderers as THREE stages, each armed only while it has a
// subscriber and released when the last leaves:
//
//   windowFocus            BrowserWindow 'focus' / 'blur'              -> { focused: boolean, windowId? }
//   windowVisibility       BrowserWindow 'show' / 'hide'               -> { visible: boolean, windowId? }
//   rendererResponsiveness webContents 'unresponsive' / 'responsive'   -> { responsive: boolean, webContentsId? }
//
// DISCOVERY. Apps typically call `launchMain` and then `createWindow()` from `whenReady()`, so a stage watches BOTH the
// objects that already exist (`BrowserWindow.getAllWindows()`, and each window's `webContents`) AND the ones created
// later (`app.on('browser-window-created')` / `app.on('web-contents-created')`). Each object is bound at most once.
//
// HANG PAIR ON `webContents` ONLY. Electron documents `unresponsive`/`responsive` on BOTH `BrowserWindow` and
// `webContents`, and `BrowserWindow` RE-EMITS the `webContents` event, so listening on both would record every hang
// twice. `webContents` is the single source because it also covers renderers with no window (a `BrowserView`, a
// `<webview>`). Only the web contents that are reachable through `app.on('web-contents-created')` or an existing
// window are watched.
//
// DESTROYED OBJECTS. An object that is (or becomes) destroyed is never bound, and is forgotten on its `closed`
// (window) / `destroyed` (webContents) event WITHOUT removing listeners from it (touching a destroyed Electron object
// throws, and its listeners died with it); at release, destroyed objects are skipped. Nothing here keeps a closed window.
//
// Ids are Electron's numeric `id`, omitted when absent: the window TITLE/URL is never read. `electron` is never
// imported: `app` and `BrowserWindow` are INJECTED structurally. SINGLETON per `app` object
// (`electronApplicationTrackerFor`); a relaunch rebinds the reporter and the `BrowserWindow` seam.

/** The slice of Electron's `app` this tracker uses. */
export type ApplicationAppSource = EmitterSource;

/** The slice of Electron's `BrowserWindow` class this tracker uses: only the static `getAllWindows`. */
export interface BrowserWindowSource {
  getAllWindows?(): unknown;
}

export interface ElectronApplicationEvents {
  windowFocus: { focused: boolean; windowId?: number };
  windowVisibility: { visible: boolean; windowId?: number };
  rendererResponsiveness: { responsive: boolean; webContentsId?: number };
}

export interface ElectronApplicationEnv {
  /** Electron's `app` (the singleton key). */
  app?: ApplicationAppSource;
  /** Electron's `BrowserWindow` class, to find windows that already exist when a stage arms. */
  BrowserWindow?: BrowserWindowSource;
}

type AppStage = keyof ElectronApplicationEvents;

interface Watched extends EmitterSource {
  id?: unknown;
  isDestroyed?(): unknown;
  webContents?: unknown;
}

interface WatchConfig<S extends AppStage> {
  createdEvent: string;
  closeEvent: string;
  /** Existing objects at arm time. */
  existing(env: ElectronApplicationEnv): unknown[];
  /** Electron event -> payload, per object. */
  events: Record<string, (idOf: number | undefined) => ElectronApplicationEvents[S]>;
  idKey: 'windowId' | 'webContentsId';
}

const withId = <K extends string>(key: K, id: number | undefined): { [P in K]?: number } =>
  (id === undefined ? {} : { [key]: id }) as { [P in K]?: number };

const windowsOf = (env: ElectronApplicationEnv): unknown[] => {
  const all = env.BrowserWindow?.getAllWindows?.();
  return Array.isArray(all) ? all : [];
};

const WATCH: { [S in AppStage]: WatchConfig<S> } = {
  windowFocus: {
    createdEvent: 'browser-window-created',
    closeEvent: 'closed',
    existing: windowsOf,
    idKey: 'windowId',
    events: {
      focus: (id) => ({ focused: true, ...withId('windowId', id) }),
      blur: (id) => ({ focused: false, ...withId('windowId', id) }),
    },
  },
  windowVisibility: {
    createdEvent: 'browser-window-created',
    closeEvent: 'closed',
    existing: windowsOf,
    idKey: 'windowId',
    events: {
      show: (id) => ({ visible: true, ...withId('windowId', id) }),
      hide: (id) => ({ visible: false, ...withId('windowId', id) }),
    },
  },
  rendererResponsiveness: {
    createdEvent: 'web-contents-created',
    closeEvent: 'destroyed',
    existing: (env) =>
      windowsOf(env).map((w) => {
        try {
          return (w as Watched).webContents;
        } catch {
          return undefined; // a destroyed window throws on `webContents`
        }
      }),
    idKey: 'webContentsId',
    events: {
      unresponsive: (id) => ({ responsive: false, ...withId('webContentsId', id) }),
      responsive: (id) => ({ responsive: true, ...withId('webContentsId', id) }),
    },
  },
};

const destroyed = (obj: Watched): boolean => {
  try {
    return obj.isDestroyed?.() === true;
  } catch {
    return true; // an object that throws on the question is not one to bind to
  }
};

const idOf = (obj: Watched): number | undefined => {
  try {
    return typeof obj.id === 'number' && Number.isFinite(obj.id) ? obj.id : undefined;
  } catch {
    return undefined;
  }
};

export class ElectronApplicationTracker extends ElectronStageTracker<ElectronApplicationEvents> {
  readonly name = 'electron-application';
  protected readonly stages: readonly AppStage[] = [
    'windowFocus',
    'windowVisibility',
    'rendererResponsiveness',
  ];
  readonly #app: ApplicationAppSource | undefined;
  #env: ElectronApplicationEnv;

  constructor(env: ElectronApplicationEnv = {}, onError?: (error: unknown) => unknown) {
    super(onError);
    this.#app = env.app;
    this.#env = env;
  }

  /**
   * Hand the latest launch's seams to this shared tracker: a defined `onError` replaces the reporter, a defined
   * `BrowserWindow` replaces ours (an undefined one never clobbers). When the `BrowserWindow` changed, every stage is
   * released and re-armed against it.
   */
  rebind(env: ElectronApplicationEnv, onError?: (error: unknown) => unknown): void {
    this.setReporter(onError);
    const next = env.BrowserWindow ?? this.#env.BrowserWindow;
    if (next === this.#env.BrowserWindow) return;
    this.detachAll();
    this.#env = { ...this.#env, BrowserWindow: next };
    this.sync();
  }

  protected attachStage(stage: AppStage): (() => void) | undefined {
    const app = this.#app;
    if (app === undefined) return undefined;
    const config = WATCH[stage] as WatchConfig<AppStage>;
    const tracked = new Map<object, () => void>();
    const add = (candidate: unknown): void => {
      if (typeof candidate !== 'object' || candidate === null || tracked.has(candidate)) {
        return;
      }
      const obj = candidate as Watched;
      if (destroyed(obj)) return;
      const bindings = Object.entries(config.events).map(([event, payload]) => ({
        src: obj,
        event,
        listener: () => this.emit(stage, payload(idOf(obj)) as never),
      }));
      bindings.push({
        src: obj,
        event: config.closeEvent,
        // closed/destroyed: forget it without touching the (dead) object
        listener: () => {
          tracked.delete(candidate);
        },
      });
      const release = bindAll(bindings, this.report);
      if (release !== undefined) tracked.set(candidate, release);
    };
    const releaseApp = bindAll(
      [{ src: app, event: config.createdEvent, listener: (_event, created) => add(created) }],
      this.report,
    );
    if (releaseApp === undefined) return undefined;
    try {
      for (const existing of config.existing(this.#env)) add(existing);
    } catch (error) {
      this.report(error); // the creation listener still covers everything created from now on
    }
    return () => {
      releaseApp(); // bindAll's release never throws: failed removals are reported inside it
      for (const [candidate, release] of [...tracked]) {
        if (!destroyed(candidate as Watched)) release();
      }
    };
  }
}

const registry = createTrackerRegistry<ElectronApplicationTracker>();

/**
 * The singleton ElectronApplicationTracker for `env.app` (keyed on that object; without one the call throws). Every call
 * (a relaunch included) hands the shared tracker the latest launch's `onError` and `BrowserWindow`.
 */
export function electronApplicationTrackerFor(
  env: ElectronApplicationEnv,
  onError?: (error: unknown) => unknown,
): ElectronApplicationTracker {
  const key = env.app;
  if (key === undefined) throw new TypeError('electronApplicationTrackerFor needs an `app`');
  const seams: ElectronApplicationEnv = {
    app: key,
    ...(env.BrowserWindow !== undefined ? { BrowserWindow: env.BrowserWindow } : {}),
  };
  return registry.for(
    key,
    () => new ElectronApplicationTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/** Test/teardown: drop the app's tracker (resetting it, so every Electron listener is released). */
export function resetElectronApplicationTracker(key: object): void {
  registry.reset(key);
}
