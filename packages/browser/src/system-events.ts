import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import {
  type ApplicationTracker,
  applicationTrackerFor,
  type EnvironmentTracker,
  environmentTrackerFor,
  hostRead,
} from '@bugsee/trackers/browser';
import type { WindowEvents } from './detection-providers';
import { hostGlobal } from './host-global';

// Browser system-event SOURCE for @bugsee/capture's systemEventsProvider (the node lifecycle-source
// analog). A listenable InterceptorBase: on activate it emits a 'process_started' marker and subscribes
// to the browser lifecycle/context signals, mapping each to an events.system entry; on deactivate it
// removes the listeners. Captured (Android events.system parity, web-native):
//   pagehide               → process_exiting (the best "about to unload — flush now" signal + bfcache flag)
//   visibilitychange       → process_foreground / process_background (app fg/bg, from document.visibilityState)
//   online / offline       → online / offline (connectivity transitions)
//   orientationchange      → orientation_changed ({type, angle} from screen.orientation)
//   languagechange         → language_changed ({language?, languages?, previousLanguage?}) — from the EnvironmentTracker
//   time zone / UTC offset → timezone_changed ({timezone?, utcOffsetMinutes?, previousTimezone?, previousUtcOffsetMinutes?})
//   private-mode heuristic → private_mode_detected ({method}) ONLY for a `yes` answer, and ONLY when the launch opted in
//                            (`captureEnvironmentHints`); `no`/`unknown` never produce an event (never claim certainty)
// Each signal degrades gracefully where its global is absent (e.g. no document/screen in a worker).

/** The document surface the source needs: visibilitychange + the current visibility state. */
interface DocumentLike extends WindowEvents {
  readonly visibilityState: DocumentVisibilityState;
}
/** The screen surface: the current orientation (absent on some browsers). */
interface ScreenLike {
  readonly orientation?: { readonly type: OrientationType; readonly angle: number };
}

/** The slice of a `MediaQueryList` the dark-mode event needs. */
interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: (event: { readonly matches: boolean }) => void): void;
  removeEventListener?(
    type: 'change',
    listener: (event: { readonly matches: boolean }) => void,
  ): void;
}

/** The slice of a scheduler the environment tracker's slow tick needs. */
type EnvironmentTimersLike = NonNullable<Parameters<typeof environmentTrackerFor>[0]['scheduler']>;

/** Drops the keys whose value is undefined (an unknown value is omitted from event params, never sent as null). */
function defined(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/** Injected globals (each defaults to the real global; an absent one is skipped). */
export interface BrowserSystemEventsEnv {
  window?: WindowEvents;
  document?: DocumentLike;
  screen?: ScreenLike;
  /**
   * `window.matchMedia` of the window the SDK is bound to (pass it bound; never defaulted to the host global).
   * Absent = no `dark_mode_changed`.
   */
  matchMedia?: (query: string) => MediaQueryLike;
  /** The shared lifecycle tracker; when absent one is created over `window` + `document`. */
  lifecycle?: Pick<ApplicationTracker, 'on'>;
  /** The shared environment tracker; when absent the window's singleton is used (created over `window`/`document`). */
  environment?: Pick<EnvironmentTracker, 'on'>;
  /** Run the private-mode heuristic (default false; see `captureEnvironmentHints`). Ignored when `environment` is supplied. */
  detectPrivateMode?: boolean;
  /** Drives the time-zone re-read tick; default the global timers. Ignored when `environment` is supplied. */
  scheduler?: EnvironmentTimersLike;
  onError?: (error: unknown) => void;
}

class BrowserSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'browser-system-events';
  readonly #lifecycle: Pick<ApplicationTracker, 'on'>;
  readonly #environment: Pick<EnvironmentTracker, 'on'>;
  readonly #screen: ScreenLike | undefined;
  readonly #matchMedia: ((query: string) => MediaQueryLike) | undefined;
  readonly #onError: (error: unknown) => void;
  #unsubscribe: Array<() => void> = [];

  constructor(
    lifecycle: Pick<ApplicationTracker, 'on'>,
    environment: Pick<EnvironmentTracker, 'on'>,
    screenLike: ScreenLike | undefined,
    matchMedia?: (query: string) => MediaQueryLike,
    onError?: (error: unknown) => void,
  ) {
    // A throwing reporter must not escape into the browser's event dispatch or abort activation.
    const report = (error: unknown): void => {
      try {
        onError?.(error);
      } catch {
        /* the reporter itself failed */
      }
    };
    super(report);
    this.#lifecycle = lifecycle;
    this.#environment = environment;
    this.#screen = screenLike;
    this.#matchMedia = matchMedia;
    this.#onError = report;
  }

  protected onActivate(): void {
    const l = this.#lifecycle;
    this.emit('event', { name: 'process_started' });
    this.#unsubscribe = [
      l.on('pagehide', ({ persisted }) =>
        this.emit('event', { name: 'process_exiting', params: { persisted } }),
      ),
      l.on('visibility', ({ visible }) =>
        this.emit('event', { name: visible ? 'process_foreground' : 'process_background' }),
      ),
      l.on('freeze', () => this.emit('event', { name: 'freeze' })),
      l.on('resume', () => this.emit('event', { name: 'resume' })),
      l.on('online', () => this.emit('event', { name: 'online' })),
      l.on('offline', () => this.emit('event', { name: 'offline' })),
      l.on('orientationchange', () => {
        const orientation = this.#screen?.orientation;
        this.emit('event', {
          name: 'orientation_changed',
          ...(orientation !== undefined
            ? { params: { type: orientation.type, angle: orientation.angle } }
            : {}),
        });
      }),
    ];
    const env = this.#environment;
    this.#unsubscribe.push(
      env.on('language', ({ language, languages, previous }) =>
        this.emit('event', {
          name: 'language_changed',
          params: defined({ language, languages, previousLanguage: previous.language }),
        }),
      ),
      env.on('timezone', ({ timeZone, utcOffsetMinutes, previous }) =>
        this.emit('event', {
          name: 'timezone_changed',
          params: defined({
            timezone: timeZone,
            utcOffsetMinutes,
            previousTimezone: previous.timeZone,
            previousUtcOffsetMinutes: previous.utcOffsetMinutes,
          }),
        }),
      ),
      env.on('privateMode', ({ private: answer, method }) => {
        if (answer === 'yes') {
          this.emit('event', { name: 'private_mode_detected', params: defined({ method }) });
        }
      }),
    );
    this.#watchDarkMode();
  }

  // `prefers-color-scheme` is a MediaQueryList you listen on (not a window event). Attached on its own, guarded:
  // an unguarded throw here would abort the capture coordinator's start and every provider registered after
  // the events source (input, viewtree, ...).
  #watchDarkMode(): void {
    try {
      const list = this.#matchMedia?.('(prefers-color-scheme: dark)');
      if (list === undefined || typeof list.addEventListener !== 'function') return;
      const onChange = (event: { readonly matches: boolean }): void => {
        try {
          this.emit('event', { name: 'dark_mode_changed', params: { dark: event.matches } });
        } catch (error) {
          this.#onError(error); // never throw into the browser's event dispatch
        }
      };
      list.addEventListener('change', onChange);
      this.#unsubscribe.push(() => {
        try {
          list.removeEventListener?.('change', onChange);
        } catch {
          /* best-effort */
        }
      });
    } catch (error) {
      this.#onError(error);
    }
  }

  protected override onDeactivate(): void {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = [];
    for (const off of unsubscribe) off();
  }
}

export function createBrowserSystemEventsSource(
  env: BrowserSystemEventsEnv = {},
): Interceptor<{ event: SystemEvent }> {
  // The host globals are read only when a tracker has to be built (a supplied one already owns them), and only
  // once for both: a blocked global is reported once. Host globals only when NEITHER window nor document was
  // injected: an injected window never borrows the host's document.
  let surfaces: { win: WindowEvents | undefined; doc: DocumentLike | undefined } | undefined;
  const hostSurfaces = (): NonNullable<typeof surfaces> => {
    if (surfaces === undefined) {
      const injected = env.window !== undefined || env.document !== undefined;
      surfaces = {
        win: injected ? env.window : hostGlobal('window', env.onError),
        doc: injected ? env.document : hostGlobal('document', env.onError),
      };
    }
    return surfaces;
  };
  const lifecycle =
    env.lifecycle ??
    ((): ApplicationTracker => {
      const { win, doc } = hostSurfaces();
      return applicationTrackerFor(
        {
          ...(win !== undefined ? { window: win } : {}),
          ...(doc !== undefined ? { document: doc } : {}),
        },
        env.onError,
      );
    })();
  const environment =
    env.environment ??
    ((): Pick<EnvironmentTracker, 'on'> => {
      const { win, doc } = hostSurfaces();
      const nav =
        win === undefined
          ? undefined
          : hostRead(() => (win as { navigator?: object }).navigator, env.onError);
      return environmentTrackerFor(
        {
          ...(win !== undefined ? { window: win } : {}),
          ...(doc !== undefined ? { document: doc } : {}),
          ...(nav !== undefined ? { navigator: nav } : {}),
          ...(env.scheduler !== undefined ? { scheduler: env.scheduler } : {}),
          ...(env.detectPrivateMode !== undefined
            ? { detectPrivateMode: env.detectPrivateMode }
            : {}),
        },
        env.onError,
      );
    })();
  return new BrowserSystemEventsSource(
    lifecycle,
    environment,
    env.screen ?? hostGlobal('screen', env.onError),
    env.matchMedia,
    env.onError,
  );
}
