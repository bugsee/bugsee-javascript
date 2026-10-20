import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import { type UiTracker, uiTrackerFor } from '@bugsee/trackers/browser';
import type { WindowEvents } from './detection-providers';
import { hostGlobal, hostRead } from './host-global';
import { PageLifecycleTracker } from './trackers/page-lifecycle-tracker';

// Browser system-event SOURCE for @bugsee/capture's systemEventsProvider (the node lifecycle-source
// analog). A listenable InterceptorBase: on activate it emits a 'process_started' marker and subscribes
// to the browser lifecycle/context signals, mapping each to an events.system entry; on deactivate it
// removes the listeners. Captured (Android events.system parity, web-native):
//   pagehide               → process_exiting (the best "about to unload — flush now" signal + bfcache flag)
//   visibilitychange       → process_foreground / process_background (app fg/bg, from document.visibilityState)
//   online / offline       → online / offline (connectivity transitions)
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
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
  onError?: (error: unknown) => void;
}

class BrowserSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'browser-system-events';
  readonly #lifecycle: Pick<PageLifecycleTracker, 'on'>;
  readonly #ui: Pick<UiTracker, 'on'>;
  #unsubscribe: Array<() => void> = [];

  constructor(
    lifecycle: Pick<PageLifecycleTracker, 'on'>,
    ui: Pick<UiTracker, 'on'>,
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
    this.#ui = ui;
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
  // ONE read of the window (injected, else the host's) serves the lifecycle tracker and the UI tracker.
  const win = env.window ?? hostGlobal<WindowEvents>('window', env.onError);
  // The document is read only when no lifecycle tracker was supplied: a supplied one already owns it.
  const lifecycle =
    env.lifecycle ??
    ((): PageLifecycleTracker => {
      const doc = env.document ?? hostGlobal('document', env.onError);
      return new PageLifecycleTracker(
        {
          ...(win !== undefined ? { window: win } : {}),
          ...(doc !== undefined ? { document: doc } : {}),
        },
        env.onError,
      );
    })();
  // An injected window brings ITS screen (read guarded); only without a window does the host's global apply, so a
  // window whose `screen` is blocked never borrows the host's into the shared per-window UI tracker.
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
  return new BrowserSystemEventsSource(lifecycle, ui, env.onError);
}
