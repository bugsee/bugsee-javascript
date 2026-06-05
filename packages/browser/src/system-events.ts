import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { WindowEvents } from './detection-providers';

// Browser system-event SOURCE for @bugsee/capture's systemEventsProvider (the node lifecycle-source
// analog). A listenable InterceptorBase: on activate it emits a 'process_started' marker and subscribes
// to the browser lifecycle/context signals, mapping each to an events.system entry; on deactivate it
// removes the listeners. Captured (Android events.system parity, web-native):
//   pagehide               → process_exiting (the best "about to unload — flush now" signal + bfcache flag)
//   visibilitychange       → process_foreground / process_background (app fg/bg, from document.visibilityState)
//   online / offline       → online / offline (connectivity transitions)
//   orientationchange      → orientation_changed ({type, angle} from screen.orientation)
// Each signal degrades gracefully where its global is absent (e.g. no document/screen in a worker).

/** A DOM event target (window or document) limited to the add/remove listener surface. */
type EventTarget = WindowEvents;
/** The document surface the source needs: visibilitychange + the current visibility state. */
interface DocumentLike extends EventTarget {
  readonly visibilityState: DocumentVisibilityState;
}
/** The screen surface: the current orientation (absent on some browsers). */
interface ScreenLike {
  readonly orientation?: { readonly type: OrientationType; readonly angle: number };
}

/** Injected globals (each defaults to the real global; an absent one is skipped). */
export interface BrowserSystemEventsEnv {
  window?: EventTarget;
  document?: DocumentLike;
  screen?: ScreenLike;
}

class BrowserSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'browser-system-events';
  readonly #window: EventTarget | undefined;
  readonly #document: DocumentLike | undefined;
  readonly #screen: ScreenLike | undefined;

  readonly #onPageHide = (event: Event): void => {
    this.emit('event', {
      name: 'process_exiting',
      params: { persisted: (event as PageTransitionEvent).persisted },
    });
  };
  readonly #onVisibility = (): void => {
    const visible = this.#document?.visibilityState === 'visible';
    this.emit('event', { name: visible ? 'process_foreground' : 'process_background' });
  };
  readonly #onOnline = (): void => this.emit('event', { name: 'online' });
  readonly #onOffline = (): void => this.emit('event', { name: 'offline' });
  readonly #onOrientation = (): void => {
    const orientation = this.#screen?.orientation;
    this.emit('event', {
      name: 'orientation_changed',
      ...(orientation !== undefined
        ? { params: { type: orientation.type, angle: orientation.angle } }
        : {}),
    });
  };

  constructor(env: BrowserSystemEventsEnv) {
    super();
    this.#window = env.window;
    this.#document = env.document;
    this.#screen = env.screen;
  }

  protected onActivate(): void {
    this.emit('event', { name: 'process_started' });
    this.#window?.addEventListener('pagehide', this.#onPageHide);
    this.#window?.addEventListener('online', this.#onOnline);
    this.#window?.addEventListener('offline', this.#onOffline);
    this.#window?.addEventListener('orientationchange', this.#onOrientation);
    this.#document?.addEventListener('visibilitychange', this.#onVisibility);
  }

  protected override onDeactivate(): void {
    this.#window?.removeEventListener('pagehide', this.#onPageHide);
    this.#window?.removeEventListener('online', this.#onOnline);
    this.#window?.removeEventListener('offline', this.#onOffline);
    this.#window?.removeEventListener('orientationchange', this.#onOrientation);
    this.#document?.removeEventListener('visibilitychange', this.#onVisibility);
  }
}

export function createBrowserSystemEventsSource(
  env: BrowserSystemEventsEnv = {},
): Interceptor<{ event: SystemEvent }> {
  return new BrowserSystemEventsSource({
    window: env.window ?? (typeof window !== 'undefined' ? window : undefined),
    document: env.document ?? (typeof document !== 'undefined' ? document : undefined),
    screen: env.screen ?? (typeof screen !== 'undefined' ? screen : undefined),
  });
}
