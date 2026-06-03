import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { WindowEvents } from './detection-providers';

// Browser system-event SOURCE for @bugsee/capture's systemEventsProvider (the node lifecycle-source
// analog). A listenable InterceptorBase: on activate it emits a 'process_started' marker and forwards
// `pagehide` as 'process_exiting' (the browser's best "about to be unloaded — flush now" signal, with
// the bfcache `persisted` flag); on deactivate it removes the listener. Richer lifecycle
// (visibilitychange/freeze/resume/bfcache restore) is deferred.

class BrowserSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'browser-system-events';
  readonly #win: WindowEvents;
  readonly #onPageHide = (event: Event): void => {
    this.emit('event', {
      name: 'process_exiting',
      params: { persisted: (event as PageTransitionEvent).persisted },
    });
  };

  constructor(win: WindowEvents) {
    super();
    this.#win = win;
  }

  protected onActivate(): void {
    this.emit('event', { name: 'process_started' });
    this.#win.addEventListener('pagehide', this.#onPageHide);
  }

  protected override onDeactivate(): void {
    this.#win.removeEventListener('pagehide', this.#onPageHide);
  }
}

export function createBrowserSystemEventsSource(
  win: WindowEvents = window,
): Interceptor<{ event: SystemEvent }> {
  return new BrowserSystemEventsSource(win);
}
