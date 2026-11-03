// Astro catches an island's hydration failure itself: it re-dispatches it as a cancelable `astro:hydration-error` CustomEvent
// (`detail.error` is the SAME error object) and logs it with `console.error`. Nothing is rethrown, so neither `window.onerror` nor
// `unhandledrejection` ever sees it and the SDK would report nothing (docs/design/async-origin-capture.md §10.5). One document-level
// listener closes that gap. It never calls `preventDefault`, so Astro's own console.error still happens.
//
// The listener is attached BEFORE `launch()` resolves (the carrier client is set after an asynchronous device-id read), so an error
// dispatched in that window is QUEUED (bounded) and reported by `flushQueuedAstroHydrationErrors` once the client exists. A repeated
// registration (a `relaunch()`) replaces the options the listener uses, so a later `onError` wins over the first one.

import { getCarrierClient } from '@bugsee/core';
import { type AdapterClientOptions, reportError } from '@bugsee/web-adapter';

export interface AstroHydrationOptions extends AdapterClientOptions {
  /** Where the event is dispatched: the page `document`. Default `globalThis.document`; absent during a server render. */
  target?: EventTarget | undefined;
}

// The client type the adapter kit resolves (astro does not depend on `@bugsee/browser` directly).
type Client = ReturnType<NonNullable<AdapterClientOptions['getClient']>>;

const EVENT = 'astro:hydration-error';
const MAX_QUEUED = 20;

interface Listening {
  listener: EventListener;
  options: AstroHydrationOptions;
  queue: unknown[];
  /** Registrations whose launch has not settled yet. The window is open while it is above zero; outside it a missing client drops the error. */
  pending: number;
}
const listening = new WeakMap<EventTarget, Listening>();

const targetOf = (options: AstroHydrationOptions): EventTarget | undefined =>
  'target' in options ? options.target : (globalThis as { document?: EventTarget }).document;

const clientOf = (options: AstroHydrationOptions): Client =>
  options.getClient !== undefined ? options.getClient() : getCarrierClient<NonNullable<Client>>();

const report = (error: unknown, options: AstroHydrationOptions): void => {
  reportError(error, {
    ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    labels: ['astro.hydration'],
  });
};

/**
 * Report Astro's `astro:hydration-error` events to the launched client; an error that arrives while no client exists yet is queued.
 * Idempotent per target (a repeated launch does not report twice), but the LATEST options win. Returns a function that removes the
 * listener. A no-op without a `document`.
 */
export function listenForAstroHydrationErrors(options: AstroHydrationOptions = {}): () => void {
  const target = targetOf(options);
  if (target === undefined) {
    return () => undefined;
  }
  const existing = listening.get(target);
  if (existing !== undefined) {
    existing.options = options; // relaunch: the new getClient / onError replace the first ones, and a new launch window opens
    existing.pending += 1;
    return () => undefined;
  }
  const state: Listening = {
    options,
    queue: [],
    pending: 1,
    listener: (event) => {
      const error = (event as CustomEvent<{ error?: unknown } | undefined>).detail?.error;
      if (error === undefined) {
        return;
      }
      let client: Client;
      try {
        client = clientOf(state.options);
      } catch (clientError) {
        try {
          state.options.onError?.(clientError);
        } catch {
          // a failing sink must not escape into Astro's event dispatch
        }
      }
      if (client === undefined && state.pending > 0) {
        state.queue.push(error);
        if (state.queue.length > MAX_QUEUED) {
          state.queue.shift(); // the newest survive
        }
        return;
      }
      report(error, state.options);
    },
  };
  listening.set(target, state);
  target.addEventListener(EVENT, state.listener);
  return () => {
    target.removeEventListener(EVENT, state.listener);
    listening.delete(target);
  };
}

/**
 * Settle one registration's launch window (call once its launch has settled, success or failure): report what was queued if a client
 * exists now, and close the window once the last pending registration has settled (afterwards an error with no client is dropped, not
 * queued), with the options of the latest registration. Never throws.
 */
export function flushQueuedAstroHydrationErrors(options: AstroHydrationOptions = {}): void {
  const target = targetOf(options);
  const state = target === undefined ? undefined : listening.get(target);
  if (state === undefined) {
    return;
  }
  // One registration has settled (launch resolved or failed). With a client, report what queued (even if another registration is still
  // resolving); the window closes, and the rest is dropped, only when the LAST pending registration has settled.
  state.pending = Math.max(0, state.pending - 1);
  let client: Client;
  try {
    client = clientOf(state.options);
  } catch {
    client = undefined;
  }
  if (client !== undefined) {
    for (const error of state.queue.splice(0)) {
      report(error, state.options);
    }
  }
  if (state.pending === 0) {
    state.queue.length = 0;
  }
}
