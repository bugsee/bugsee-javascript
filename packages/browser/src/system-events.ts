import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { WindowEvents } from './detection-providers';
import { hostGlobal } from './host-global';
import { PageLifecycleTracker } from './trackers/page-lifecycle-tracker';

// Browser system-event SOURCE for @bugsee/capture's systemEventsProvider (the node lifecycle-source
// analog). A listenable InterceptorBase: on activate it emits a 'process_started' marker and subscribes
// to the browser lifecycle/context signals, mapping each to an events.system entry; on deactivate it
// removes the listeners. Captured (Android events.system parity, web-native):
//   pagehide               → process_exiting (the best "about to unload — flush now" signal + bfcache flag)
//   visibilitychange       → process_foreground / process_background (app fg/bg, from document.visibilityState)
//   online / offline       → online / offline (connectivity transitions)
//   orientationchange      → orientation_changed ({type, angle} from screen.orientation)
// Each signal degrades gracefully where its global is absent (e.g. no document/screen in a worker).

/** The document surface the source needs: visibilitychange + the current visibility state. */
interface DocumentLike extends WindowEvents {
  readonly visibilityState: DocumentVisibilityState;
}
/** The screen surface: the current orientation (absent on some browsers). */
interface ScreenLike {
  readonly orientation?: { readonly type: OrientationType; readonly angle: number };
}

/** Injected globals (each defaults to the real global; an absent one is skipped). */
export interface BrowserSystemEventsEnv {
  window?: WindowEvents;
  document?: DocumentLike;
  screen?: ScreenLike;
  /** The shared lifecycle tracker; when absent one is created over `window` + `document`. */
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
  onError?: (error: unknown) => void;
}

class BrowserSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'browser-system-events';
  readonly #lifecycle: Pick<PageLifecycleTracker, 'on'>;
  readonly #screen: ScreenLike | undefined;
  #unsubscribe: Array<() => void> = [];

  constructor(lifecycle: Pick<PageLifecycleTracker, 'on'>, screenLike: ScreenLike | undefined) {
    super();
    this.#lifecycle = lifecycle;
    this.#screen = screenLike;
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
  const win = env.window ?? hostGlobal('window', env.onError);
  const doc = env.document ?? hostGlobal('document', env.onError);
  const lifecycle =
    env.lifecycle ??
    new PageLifecycleTracker(
      {
        ...(win !== undefined ? { window: win } : {}),
        ...(doc !== undefined ? { document: doc } : {}),
      },
      env.onError,
    );
  return new BrowserSystemEventsSource(lifecycle, env.screen ?? hostGlobal('screen', env.onError));
}
