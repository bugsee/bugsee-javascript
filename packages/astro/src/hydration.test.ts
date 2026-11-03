import type { Bugsee } from '@bugsee/bugsee';
import { setCarrierClient } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { flushQueuedAstroHydrationErrors, listenForAstroHydrationErrors } from './hydration';

const clientWith = (logException = vi.fn(() => Promise.resolve(undefined))) =>
  ({ logException }) as unknown as Bugsee;
const hydrationError = (error: unknown, cancelable = true): Event =>
  new CustomEvent('astro:hydration-error', { detail: { error }, cancelable, bubbles: true });

describe('listenForAstroHydrationErrors', () => {
  it('reports the error carried by astro:hydration-error, once per event, without cancelling the event', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    listenForAstroHydrationErrors({ target, getClient: () => clientWith(logException) });
    const error = new Error('island failed');
    const event = hydrationError(error);
    target.dispatchEvent(event);
    expect(logException).toHaveBeenCalledTimes(1);
    const [reported, options] = logException.mock.calls[0] as unknown as [
      unknown,
      { labels?: string[] },
    ];
    expect(reported).toBe(error); // the SAME object: instance dedupe and the async-origin lookup both key on it
    expect(options.labels).toContain('astro.hydration');
    expect(event.defaultPrevented).toBe(false); // Astro's own console.error still happens
  });

  it('ignores an event without an error, and does nothing when no client is launched', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    listenForAstroHydrationErrors({ target, getClient: () => clientWith(logException) });
    target.dispatchEvent(new CustomEvent('astro:hydration-error', { detail: {} }));
    target.dispatchEvent(new CustomEvent('astro:hydration-error'));
    expect(logException).not.toHaveBeenCalled();

    const noClient = new EventTarget();
    listenForAstroHydrationErrors({ target: noClient, getClient: () => undefined });
    expect(() => noClient.dispatchEvent(hydrationError(new Error('x')))).not.toThrow();
  });

  it('never throws into the page when reporting fails, and tells onError', () => {
    const target = new EventTarget();
    const onError = vi.fn();
    const boom = vi.fn(() => {
      throw new Error('sdk down');
    });
    listenForAstroHydrationErrors({ target, getClient: () => clientWith(boom as never), onError });
    expect(() => target.dispatchEvent(hydrationError(new Error('x')))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('is idempotent per target (a repeated launch does not report twice) and stops on request', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    const options = { target, getClient: () => clientWith(logException) };
    const stop = listenForAstroHydrationErrors(options);
    listenForAstroHydrationErrors(options);
    target.dispatchEvent(hydrationError(new Error('a')));
    expect(logException).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(hydrationError(new Error('b')));
    expect(logException).toHaveBeenCalledTimes(1);
    // and a stopped listener can be installed again
    listenForAstroHydrationErrors(options);
    target.dispatchEvent(hydrationError(new Error('c')));
    expect(logException).toHaveBeenCalledTimes(2);
  });

  it('is a no-op without a document (server render)', () => {
    const stop = listenForAstroHydrationErrors({ target: undefined });
    expect(() => stop()).not.toThrow();
  });

  it('defaults to the page document and to the process client (none launched here: nothing to report, nothing thrown)', () => {
    const document = new EventTarget();
    (globalThis as { document?: unknown }).document = document;
    try {
      const stop = listenForAstroHydrationErrors();
      expect(() => document.dispatchEvent(hydrationError(new Error('x')))).not.toThrow();
      stop();
    } finally {
      (globalThis as { document?: unknown }).document = undefined;
    }
  });

  // The listener is attached BEFORE launch() resolves (the carrier client is set after an async device-id read), so an island error
  // dispatched in that window must not be dropped.
  it('queues an error that arrives before the client exists, and reports it on flush', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    let client: Bugsee | undefined;
    const options = { target, getClient: () => client };
    listenForAstroHydrationErrors(options);
    const early = new Error('during launch');
    target.dispatchEvent(hydrationError(early));
    expect(logException).not.toHaveBeenCalled();
    client = clientWith(logException);
    flushQueuedAstroHydrationErrors(options);
    expect(logException).toHaveBeenCalledTimes(1);
    expect((logException.mock.calls[0] as unknown as [unknown])[0]).toBe(early);
    flushQueuedAstroHydrationErrors(options); // the queue is emptied: nothing is reported twice
    expect(logException).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue bounded (the newest errors survive)', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    let client: Bugsee | undefined;
    const options = { target, getClient: () => client };
    listenForAstroHydrationErrors(options);
    for (let i = 0; i < 25; i += 1) {
      target.dispatchEvent(hydrationError(new Error(`e${i}`)));
    }
    client = clientWith(logException);
    flushQueuedAstroHydrationErrors(options);
    const reported = logException.mock.calls.map((c) => (c as unknown as [Error])[0].message);
    expect(reported).toHaveLength(20);
    expect(reported[0]).toBe('e5');
    expect(reported[19]).toBe('e24');
  });

  it('a later registration (relaunch) replaces the onError the listener uses; flush with nothing queued or no document is a no-op', () => {
    const target = new EventTarget();
    const first = vi.fn();
    const second = vi.fn();
    const boom = vi.fn(() => {
      throw new Error('sdk down');
    });
    const getClient = () => clientWith(boom as never);
    listenForAstroHydrationErrors({ target, getClient, onError: first });
    const again = listenForAstroHydrationErrors({ target, getClient, onError: second }); // relaunch: the new options win
    again(); // the second registration's stop is a no-op: the first registration owns the listener
    target.dispatchEvent(hydrationError(new Error('x')));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(() => flushQueuedAstroHydrationErrors({ target, getClient })).not.toThrow();
    expect(() => flushQueuedAstroHydrationErrors({ target: undefined })).not.toThrow();
    expect(() => flushQueuedAstroHydrationErrors({ target: new EventTarget() })).not.toThrow(); // never listened
  });

  it('a client lookup that throws is reported to onError and the error is queued, not lost', () => {
    const target = new EventTarget();
    const onError = vi.fn();
    const logException = vi.fn(() => Promise.resolve(undefined));
    let healthy = false;
    const options = {
      target,
      onError,
      getClient: () => {
        if (!healthy) {
          throw new Error('carrier unavailable');
        }
        return clientWith(logException);
      },
    };
    listenForAstroHydrationErrors(options);
    target.dispatchEvent(hydrationError(new Error('x')));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(logException).not.toHaveBeenCalled();
    healthy = true;
    flushQueuedAstroHydrationErrors(options);
    expect(logException).toHaveBeenCalledTimes(1);
  });

  // The queue covers ONLY the launch window: after the flush that ends it, an error with no client (a stopped or killed SDK) is dropped,
  // not queued for ever and not reported by a later, unrelated flush.
  it('stops queueing once the launch window has been flushed', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    let client: Bugsee | undefined;
    const options = { target, getClient: () => client };
    listenForAstroHydrationErrors(options);
    flushQueuedAstroHydrationErrors(options); // launch resolved (or failed): the window is over
    target.dispatchEvent(hydrationError(new Error('after the SDK went away'))); // no client
    client = clientWith(logException);
    flushQueuedAstroHydrationErrors(options);
    expect(logException).not.toHaveBeenCalled();
  });

  it('a relaunch opens a new queueing window', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    let client: Bugsee | undefined;
    const options = { target, getClient: () => client };
    listenForAstroHydrationErrors(options);
    flushQueuedAstroHydrationErrors(options);
    listenForAstroHydrationErrors(options); // registerClient again (relaunch)
    target.dispatchEvent(hydrationError(new Error('during the relaunch')));
    client = clientWith(logException);
    flushQueuedAstroHydrationErrors(options);
    expect(logException).toHaveBeenCalledTimes(1);
  });

  it('a throwing onError never escapes the listener (and the error is still queued)', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    let healthy = false;
    const options = {
      target,
      onError: () => {
        throw new Error('sink failed');
      },
      getClient: () => {
        if (!healthy) {
          throw new Error('carrier unavailable');
        }
        return clientWith(logException);
      },
    };
    listenForAstroHydrationErrors(options);
    expect(() => target.dispatchEvent(hydrationError(new Error('x')))).not.toThrow();
    healthy = true;
    flushQueuedAstroHydrationErrors(options);
    expect(logException).toHaveBeenCalledTimes(1);
  });

  // Two overlapping registrations: one fails (no client) while the other is still resolving. The window stays open until the LAST settles.
  it('keeps the launch window open while another registration is still pending', () => {
    const target = new EventTarget();
    const logException = vi.fn(() => Promise.resolve(undefined));
    let client: Bugsee | undefined;
    const options = { target, getClient: () => client };
    listenForAstroHydrationErrors(options); // registration A
    listenForAstroHydrationErrors(options); // registration B, overlapping
    target.dispatchEvent(hydrationError(new Error('during both')));
    flushQueuedAstroHydrationErrors(options); // A fails: no client, B still pending
    expect(logException).not.toHaveBeenCalled();
    target.dispatchEvent(hydrationError(new Error('while B resolves'))); // must still queue
    client = clientWith(logException);
    flushQueuedAstroHydrationErrors(options); // B succeeds
    expect(logException).toHaveBeenCalledTimes(2);
    target.dispatchEvent(hydrationError(new Error('after both'))); // window closed, client exists: reported directly
    expect(logException).toHaveBeenCalledTimes(3);
  });

  it('a client lookup that throws while flushing drops the queue only once the last registration has settled, and never throws', () => {
    const target = new EventTarget();
    const options = {
      target,
      getClient: () => {
        throw new Error('carrier unavailable');
      },
      onError: () => undefined,
    };
    listenForAstroHydrationErrors(options);
    target.dispatchEvent(hydrationError(new Error('x')));
    expect(() => flushQueuedAstroHydrationErrors(options)).not.toThrow();
    // the window is closed now: nothing is queued any more
    target.dispatchEvent(hydrationError(new Error('y')));
    expect(() => flushQueuedAstroHydrationErrors(options)).not.toThrow();
  });

  // `launch({ carrier })` keeps the client on a custom carrier object, not on globalThis: the listener must look there.
  it('finds the client on a custom carrier', () => {
    const target = new EventTarget();
    const carrier = {};
    const logException = vi.fn(() => Promise.resolve(undefined));
    setCarrierClient(clientWith(logException), carrier);
    listenForAstroHydrationErrors({ target, carrier });
    flushQueuedAstroHydrationErrors({ target, carrier });
    target.dispatchEvent(hydrationError(new Error('on a custom carrier')));
    expect(logException).toHaveBeenCalledTimes(1);
  });
});
