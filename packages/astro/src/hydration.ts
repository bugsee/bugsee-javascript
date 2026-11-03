// Astro catches an island's hydration failure itself: it re-dispatches it as a cancelable `astro:hydration-error` CustomEvent
// (`detail.error` is the SAME error object) and logs it with `console.error`. Nothing is rethrown, so neither `window.onerror` nor
// `unhandledrejection` ever sees it and the SDK would report nothing (docs/design/async-origin-capture.md §10.5). One document-level
// listener closes that gap. It never calls `preventDefault`, so Astro's own console.error still happens.
import { type AdapterClientOptions, reportError } from '@bugsee/web-adapter';

export interface AstroHydrationOptions extends AdapterClientOptions {
  /** Where the event is dispatched: the page `document`. Default `globalThis.document`; absent during a server render. */
  target?: EventTarget | undefined;
}

const EVENT = 'astro:hydration-error';
const listeners = new WeakMap<EventTarget, EventListener>();

/**
 * Report Astro's `astro:hydration-error` events to the launched client. Idempotent per target (a repeated launch does not report
 * twice). Returns a function that removes the listener. A no-op without a `document`.
 */
export function listenForAstroHydrationErrors(options: AstroHydrationOptions = {}): () => void {
  const target =
    'target' in options ? options.target : (globalThis as { document?: EventTarget }).document;
  if (target === undefined || listeners.has(target)) {
    return () => undefined;
  }
  const listener: EventListener = (event) => {
    const error = (event as CustomEvent<{ error?: unknown } | undefined>).detail?.error;
    if (error === undefined) {
      return;
    }
    reportError(error, {
      ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
      labels: ['astro.hydration'],
    });
  };
  listeners.set(target, listener);
  target.addEventListener(EVENT, listener);
  return () => {
    target.removeEventListener(EVENT, listener);
    listeners.delete(target);
  };
}
