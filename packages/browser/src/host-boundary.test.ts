import type { Client, ReportingRequest } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import type { WindowEvents } from './detection-providers';
import { createUnhandledRejectionProvider, createWindowErrorProvider } from './detection-providers';

// WAVE 2.1/2.2 — the host-boundary contract for the browser window listeners.
//
// These run inside the BROWSER'S OWN event dispatch for `error` and `unhandledrejection` — the two events
// that fire precisely when the page is already in trouble. A throw from a listener on those events does not
// cost one report: the browser turns it into ANOTHER `error` event, which this same listener then handles,
// which can throw again. The failure mode is a loop on the page's worst moment.
//
// The event object is entirely page-supplied. `ErrorEvent.error` is whatever the app threw — commonly not an
// Error at all — and a getter on it can throw. `PromiseRejectionEvent.reason` likewise.

/** A window that records its listeners so a test can fire them the way the browser does. */
function fakeWindow() {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const win: WindowEvents = {
    addEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
  };
  return {
    win,
    fire: (type: string, event: unknown) => {
      for (const l of listeners.get(type) ?? []) l(event as Event);
    },
    count: (type: string) => (listeners.get(type) ?? []).length,
  };
}

/** An event whose every property access throws — the page handing us something exotic. */
const hostileEvent = (): Event =>
  new Proxy({} as Event, {
    get() {
      throw new Error('hostile event');
    },
  });

const dummyClient = {} as Client;

/** Start the provider and collect whatever reporting requests it produces. */
const init = (provider: ReturnType<typeof createWindowErrorProvider>): ReportingRequest[] => {
  const requests: ReportingRequest[] = [];
  provider.start(dummyClient, (r) => requests.push(r));
  return requests;
};

describe('the browser window listeners are contained host boundaries', () => {
  it('window error listener does not throw back into the browser’s dispatch', () => {
    const { win, fire } = fakeWindow();
    const provider = createWindowErrorProvider(win);
    init(provider);
    expect(() => fire('error', hostileEvent())).not.toThrow();
  });

  it('unhandledrejection listener does not throw back into the browser’s dispatch', () => {
    const { win, fire } = fakeWindow();
    const provider = createUnhandledRejectionProvider(win);
    init(provider);
    expect(() => fire('unhandledrejection', hostileEvent())).not.toThrow();
  });

  it('survives a rejection whose `reason` getter throws', () => {
    // The commonest real shape: the app rejected with something exotic, not a plain Error.
    const { win, fire } = fakeWindow();
    const provider = createUnhandledRejectionProvider(win);
    init(provider);
    const event = {
      get reason() {
        throw new Error('hostile reason');
      },
    };
    expect(() => fire('unhandledrejection', event)).not.toThrow();
  });

  it('survives an ErrorEvent whose `error` getter throws', () => {
    const { win, fire } = fakeWindow();
    const provider = createWindowErrorProvider(win);
    init(provider);
    const event = {
      message: 'boom',
      filename: 'app.js',
      lineno: 1,
      colno: 1,
      get error() {
        throw new Error('hostile error property');
      },
    };
    expect(() => fire('error', event)).not.toThrow();
  });

  it('still registers and unregisters its listener — the guard must not disable capture', () => {
    // The canary. Without it, every assertion above is satisfied by a provider that never listens at all.
    const { win, count } = fakeWindow();
    const provider = createWindowErrorProvider(win);
    provider.start(dummyClient, () => {});
    expect(count('error')).toBe(1);
    provider.stop();
    expect(count('error')).toBe(0);
  });

  it('still produces a report for a WELL-FORMED error event', () => {
    // The second canary, asserted through the REAL reporting seam rather than a monkey-patch: containment
    // must not turn the listener into a no-op for the errors it exists to capture.
    const { win, fire } = fakeWindow();
    const requests = init(createWindowErrorProvider(win));
    fire('error', {
      message: 'boom',
      filename: 'a.js',
      lineno: 1,
      colno: 2,
      error: new Error('x'),
    });
    expect(requests).toHaveLength(1);
  });
});
