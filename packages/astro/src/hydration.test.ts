import type { Bugsee } from '@bugsee/bugsee';
import { describe, expect, it, vi } from 'vitest';
import { listenForAstroHydrationErrors } from './hydration';

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
});
