import { createTrackerRegistry } from '../tracker-registry';
import { bindAll, ElectronStageTracker, type EmitterSource } from './stage-tracker';

// Electron MAIN-process APPLICATION tracker (domain tracker, design §15.2/§15.4 TR9; Android reference:
// BugseeTrackerApplication). It owns the app's WINDOWS and renderers as FIVE stages, each armed only while it has a
// subscriber and released when the last leaves:
//
//   windowFocus            BrowserWindow 'focus' / 'blur'              -> { focused: boolean, windowId? }
//   keyWindow              focus / blur / show / hide / closed         -> { windowId? }   (the KEY window changed; `{}` = none)
//   windowVisibility       BrowserWindow 'show' / 'hide'               -> { visible: boolean, windowId? }
//   windowMoved            BrowserWindow 'moved'                       -> { windowId? }   (macOS: an alias of `move`, so it fires
//                                                                       throughout a drag; Windows: end of drag; consumers debounce)
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
// KEY WINDOW (spec platforms/javascript.md "Several windows in one session"): `keyWindowBounds()` resolves the ONE window
// the session records per-window state for: the focused `BrowserWindow` (`getFocusedWindow`), else the most recently
// focused one (remembered while the `windowFocus` stage is armed; forgotten on its `closed`), else the first window
// `getAllWindows()` lists (creation order). Every read is guarded and reported; a destroyed window is never the key window.
//
// The `keyWindow` stage reports WHEN that answer changes (a focus, a blur, a show/hide or a close that moves it), so the
// session can tell each renderer whether it is the key window's (`keyWindowId()` is the live read). It shares the
// most-recently-focused memory with `windowFocus`: that memory is dropped only when NEITHER stage observes focus.
//
// Ids are Electron's numeric `id`, omitted when absent: the window TITLE/URL is never read. `electron` is never
// imported: `app` and `BrowserWindow` are INJECTED structurally. SINGLETON per `app` object
// (`electronApplicationTrackerFor`); a relaunch rebinds the reporter and the `BrowserWindow` seam.

/** The slice of Electron's `app` this tracker uses. */
export type ApplicationAppSource = EmitterSource;

/** The slice of Electron's `BrowserWindow` class this tracker uses: only the static `getAllWindows`. */
export interface BrowserWindowSource {
  getAllWindows?(): unknown;
  /** The focused window, or null when the app is not focused. */
  getFocusedWindow?(): unknown;
  /** The window that owns a webContents (a BrowserView/WebContentsView included), or null. Read by the session's key-window rule. */
  fromWebContents?(contents: unknown): unknown;
}

export interface ElectronApplicationEvents {
  windowFocus: { focused: boolean; windowId?: number };
  /** The key window changed; no `windowId` means there is none now. */
  keyWindow: { windowId?: number };
  windowVisibility: { visible: boolean; windowId?: number };
  windowMoved: { windowId?: number };
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
  getBounds?(): unknown;
  isVisible?(): unknown;
}

interface WatchConfig<S extends AppStage> {
  /** For the stage that reports KEY-WINDOW changes: the window events (and the close) that re-read the key instead of mapping a payload. */
  keyChange?: readonly string[];
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

/** The window list, or null when it cannot be read at all (no `getAllWindows`, or it did not return an array). */
const readWindows = (env: ElectronApplicationEnv): unknown[] | null => {
  const all = env.BrowserWindow?.getAllWindows?.();
  return Array.isArray(all) ? all : null;
};
const windowsOf = (env: ElectronApplicationEnv): unknown[] => readWindows(env) ?? [];

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
  keyWindow: {
    keyChange: ['focus', 'blur', 'show', 'hide'],
    createdEvent: 'browser-window-created',
    closeEvent: 'closed',
    existing: windowsOf,
    idKey: 'windowId',
    events: {}, // no payload mapping: every listed event re-reads the key window
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
  windowMoved: {
    createdEvent: 'browser-window-created',
    closeEvent: 'closed',
    existing: windowsOf,
    idKey: 'windowId',
    events: {
      moved: (id) => withId('windowId', id),
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

const visible = (w: Watched): boolean => {
  try {
    return w.isVisible?.() === true;
  } catch {
    return false;
  }
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
    'keyWindow',
    'windowVisibility',
    'windowMoved',
    'rendererResponsiveness',
  ];
  readonly #app: ApplicationAppSource | undefined;
  #env: ElectronApplicationEnv;
  /** The window that last took focus (only seen while `windowFocus` or `keyWindow` is armed). */
  #lastFocused: Watched | undefined;
  /** The key window id the `keyWindow` stage last published (or saw when it armed): changes only are emitted. */
  #publishedKey: number | undefined | null;

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

  /** The key window (see the header), or undefined when there is none. Never throws. */
  #keyWindow(): Watched | undefined | null {
    const usable = (w: unknown): w is Watched =>
      typeof w === 'object' && w !== null && !destroyed(w as Watched);
    try {
      const focused = this.#env.BrowserWindow?.getFocusedWindow?.();
      if (usable(focused)) return focused;
    } catch (error) {
      this.report(error);
    }
    const last = this.#lastFocused;
    if (last !== undefined && usable(last)) return last;
    try {
      // `getAllWindows()` order is not documented (in practice creation order): the first VISIBLE window is preferred so a hidden
      // background window (a tray/worker window) is not taken as the first created; with none visible, the first usable one.
      const list = readWindows(this.#env);
      if (list === null) return null; // CANNOT SAY: not the same as a list with no usable window
      const all = list.filter(usable);
      return all.find(visible) ?? all[0];
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /**
   * The key window's id; `undefined` when there is none (an empty or all-destroyed window list); `null` when the tracker
   * CANNOT SAY (the window list cannot be read, or the key window has no numeric id), which a consumer must not read as "no
   * key window". Never throws.
   */
  keyWindowId(): number | undefined | null {
    const win = this.#keyWindow();
    if (win === undefined) return undefined;
    // `win` is null when the tracker cannot say; `idOf` answers undefined for it (its read is guarded), and so does a window
    // with no numeric id: both are "cannot say"
    return idOf(win as Watched) ?? null;
  }

  /** Publish the key window id once per change (`{}` when there is none, or it cannot be said: consumers re-read). */
  #publishKey(): void {
    const id = this.keyWindowId();
    if (id === this.#publishedKey) return;
    this.#publishedKey = id;
    this.emit('keyWindow', id === undefined || id === null ? {} : { windowId: id });
  }

  /** The key window's bounds (a rectangle), or undefined when there is no key window or it cannot say. Never throws. */
  keyWindowBounds(): unknown {
    const win = this.#keyWindow();
    if (win === undefined || win === null) return undefined;
    try {
      return win.getBounds?.();
    } catch (error) {
      this.report(error);
      return undefined;
    }
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
      // [window event, what it does]: a payload stage emits its mapped payload, the key stage re-reads the key window
      const events: Array<[string, () => void]> =
        config.keyChange !== undefined
          ? config.keyChange.map((event) => [event, () => this.#publishKey()])
          : Object.entries(config.events).map(([event, payload]) => [
              event,
              () => this.emit(stage, payload(idOf(obj)) as never),
            ]);
      const bindings = events.map(([event, fire]) => ({
        src: obj,
        event,
        listener: () => {
          if (event === 'focus') this.#lastFocused = obj; // the windowFocus and keyWindow stages bind `focus`
          fire();
        },
      }));
      bindings.push({
        src: obj,
        event: config.closeEvent,
        // closed/destroyed: forget it without touching the (dead) object
        listener: () => {
          tracked.delete(candidate);
          if (this.#lastFocused === obj) this.#lastFocused = undefined;
          if (config.keyChange !== undefined) this.#publishKey(); // the key may have moved to another window
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
    // a re-arm starts from the CURRENT key, so the first event is a real change
    if (config.keyChange !== undefined) this.#publishedKey = this.keyWindowId();
    return () => {
      // the most-recently-focused memory is only valid while focus is observed: a re-arm must not trust a stale window
      // (both focus-observing stages share it, so it is dropped only when the OTHER one is not armed either)
      if (
        (stage === 'windowFocus' && this.listenerCount('keyWindow') === 0) ||
        (stage === 'keyWindow' && this.listenerCount('windowFocus') === 0)
      ) {
        this.#lastFocused = undefined;
      }
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
