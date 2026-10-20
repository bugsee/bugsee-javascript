import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import {
  type ApplicationTracker,
  applicationTrackerFor,
  type EnvironmentEvents,
  type EnvironmentTracker,
  environmentTrackerFor,
  type UiTracker,
  uiTrackerFor,
} from '@bugsee/trackers/browser';
import type { WindowEvents } from './detection-providers';
import { hostGlobal, hostRead } from './host-global';

// Browser system-event SOURCE for @bugsee/capture's systemEventsProvider (the node lifecycle-source
// analog). A listenable InterceptorBase: on activate it emits a 'process_started' marker and subscribes
// to the browser lifecycle/context signals, mapping each to an events.system entry; on deactivate it
// removes the listeners. Captured (Android events.system parity, web-native):
//   pagehide               → process_exiting (the best "about to unload — flush now" signal + bfcache flag)
//   visibilitychange       → process_foreground / process_background (app fg/bg, from document.visibilityState)
//   online / offline       → online / offline (connectivity transitions)
//   languagechange         → language_changed ({language?, languages?, previousLanguage?}) — from the EnvironmentTracker
//   time zone / UTC offset → timezone_changed ({timezone?, utcOffsetMinutes?, previousTimezone?, previousUtcOffsetMinutes?})
//   private-mode HEURISTIC → private_mode_detected ({method}) ONLY for a `yes` answer (a small storage quota; constrained
//                            storage can false-positive, so it is a hint, never a certainty), once per answer, ON by default (the
//                            launch opts out with `captureEnvironmentHints: false`); `no`/`unknown` never produce an event (never claim certainty)
//   orientation (UiTracker: screen.orientation change + orientationchange) → orientation_changed ({type, angle})
//   colorScheme (UiTracker) → dark_mode_changed ({dark} from prefers-color-scheme)
// Each signal degrades gracefully where its global is absent (e.g. no document/screen in a worker).

/** The document surface the source needs: visibilitychange + the current visibility state. */
interface DocumentLike extends WindowEvents {
  readonly visibilityState: DocumentVisibilityState;
}
/** The screen surface: the current orientation (absent on some browsers). */
interface ScreenLike {
  readonly orientation?: { readonly type: OrientationType; readonly angle: number };
}

type UiEnvWindow = NonNullable<Parameters<typeof uiTrackerFor>[0]['window']>;

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

/** What the source needs from the environment tracker; `current` lets it re-deliver a retained private-mode answer. */
type EnvironmentSource = Pick<EnvironmentTracker, 'onAny'> &
  Partial<Pick<EnvironmentTracker, 'current'>>;

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
  environment?: EnvironmentSource;
  /** Run the private-mode heuristic (default TRUE, opt-out; see `captureEnvironmentHints`). A `false` is also enforced at the event sink: `private_mode_detected` is never forwarded, even from a shared tracker another consumer enabled. */
  detectPrivateMode?: boolean;
  /** Drives the time-zone re-read tick; default the global timers. Ignored when `environment` is supplied. */
  scheduler?: EnvironmentTimersLike;
  onError?: (error: unknown) => void;
}

class BrowserSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'browser-system-events';
  readonly #lifecycle: Pick<ApplicationTracker, 'on'>;
  readonly #ui: Pick<UiTracker, 'on'>;
  readonly #environment: EnvironmentSource;
  /** This source's own opt-out, enforced at the sink: the shared tracker may run the probe for another consumer. */
  readonly #privateMode: boolean;
  #unsubscribe: Array<() => void> = [];

  constructor(
    lifecycle: Pick<ApplicationTracker, 'on'>,
    ui: Pick<UiTracker, 'on'>,
    environment: EnvironmentSource,
    onError: ((error: unknown) => void) | undefined,
    detectPrivateMode: boolean,
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
    this.#ui = ui;
    this.#environment = environment;
    this.#privateMode = detectPrivateMode;
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
      // The UiTracker de-duplicates the double delivery (screen.orientation change + window orientationchange); an
      // engine without a readable orientation still announces the bare event.
      this.#ui.on('orientation', ({ type, angle }) =>
        this.emit('event', {
          name: 'orientation_changed',
          ...(type !== undefined && angle !== undefined ? { params: { type, angle } } : {}),
        }),
      ),
      this.#ui.on('colorScheme', ({ dark }) =>
        this.emit('event', { name: 'dark_mode_changed', params: { dark } }),
      ),
    ];
    // ONE subscription for every environment stage: the first subscriber activates the tracker, whose activation read
    // may emit (a change made while we were stopped) straight away, so a stage subscribed later would miss it.
    // private_mode_detected is a PER-SESSION event but the tracker outlives sessions and never re-probes a retained
    // yes/no: so a retained `yes` is re-delivered once on subscribe (unless the activation already delivered it).
    let privateDelivered = false;
    const deliverPrivate = (method: string | undefined): void => {
      privateDelivered = true;
      this.emit('event', { name: 'private_mode_detected', params: defined({ method }) });
    };
    this.#unsubscribe.push(
      this.#environment.onAny((name, payload) => {
        if (name === 'language') {
          const { language, languages, previous } = payload as EnvironmentEvents['language'];
          this.emit('event', {
            name: 'language_changed',
            params: defined({ language, languages, previousLanguage: previous.language }),
          });
        } else if (name === 'timezone') {
          const { timeZone, utcOffsetMinutes, previous } = payload as EnvironmentEvents['timezone'];
          this.emit('event', {
            name: 'timezone_changed',
            params: defined({
              timezone: timeZone,
              utcOffsetMinutes,
              previousTimezone: previous.timeZone,
              previousUtcOffsetMinutes: previous.utcOffsetMinutes,
            }),
          });
        } else if (name === 'privateMode') {
          const { private: answer, method } = payload as EnvironmentEvents['privateMode'];
          if (answer === 'yes' && this.#privateMode) deliverPrivate(method);
        }
      }),
    );
    const retained = this.#privateMode ? this.#environment.current?.().privateMode : undefined;
    if (retained?.private === 'yes' && !privateDelivered) deliverPrivate(retained.method);
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
  // Host globals (window, document) only when NEITHER window nor document was injected: an injected env never
  // borrows the host's window or document. ONE read of the window serves the lifecycle tracker and the UI tracker.
  const injected = env.window !== undefined || env.document !== undefined;
  const win = injected ? env.window : hostGlobal<WindowEvents>('window', env.onError);
  // The document is read lazily, once, and only when a tracker built here needs it (a supplied one already owns it).
  let docRead: { doc: DocumentLike | undefined } | undefined;
  const hostDoc = (): DocumentLike | undefined => {
    docRead ??= { doc: injected ? env.document : hostGlobal('document', env.onError) };
    return docRead.doc;
  };
  const lifecycle =
    env.lifecycle ??
    ((): ApplicationTracker => {
      const doc = hostDoc();
      return applicationTrackerFor(
        {
          ...(win !== undefined ? { window: win } : {}),
          ...(doc !== undefined ? { document: doc } : {}),
        },
        env.onError,
      );
    })();
  // An injected WINDOW brings ITS screen (read guarded), so a window whose `screen` is blocked never borrows the
  // host's into the shared per-window UI tracker. Without an injected window — including an env that injected only a
  // document, as before — the host's screen global applies.
  const screen =
    env.screen ??
    (env.window !== undefined
      ? hostRead(() => (env.window as { screen?: ScreenLike }).screen, env.onError)
      : hostGlobal('screen', env.onError));
  // The SAME per-window tracker the traces use (keyed on the window; a relaunch's seams merge into it). Without an
  // injected window it gets the host's, exactly as the lifecycle tracker does above.
  const ui = uiTrackerFor(
    {
      ...(win !== undefined ? { window: win as UiEnvWindow } : {}),
      ...(screen !== undefined ? { screen } : {}),
      ...(env.matchMedia !== undefined ? { matchMedia: env.matchMedia } : {}),
    },
    env.onError,
  );
  const environment =
    env.environment ??
    ((): EnvironmentSource => {
      const doc = hostDoc();
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
          // Always explicit: an omitted field would be RETAINED by the window's shared tracker (an earlier source
          // may have changed it). Private-mode detection is on unless
          // `detectPrivateMode: false`. Hints and permission states have no consumer here, so they are never read.
          detectPrivateMode: env.detectPrivateMode ?? true,
          observeHints: false,
          queryPermissions: false,
        },
        env.onError,
      );
    })();
  return new BrowserSystemEventsSource(
    lifecycle,
    ui,
    environment,
    env.onError,
    env.detectPrivateMode ?? true,
  );
}
