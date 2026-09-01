import { neverThrow } from '@bugsee/core';
import type { Bugsee } from './launch';

// Service Worker event flush (design §3.x — the SW analog of the edge ctx.waitUntil). A Service Worker is
// TERMINATED when idle, so a fire-and-forget incident upload can be dropped before it completes. Wrapping a SW
// event handler hands the SDK flush to `event.waitUntil`, which keeps the worker alive until the upload
// finishes — the exact isolate-freeze guard the edge SDK uses (vercel-edge wait-until.ts). A dedicated/shared
// Web Worker is long-lived and does NOT need this; it's Service-Worker-only.

/**
 * Deadline for the incident flush handed to `waitUntil`.
 *
 * `waitUntil` is why the flush gets to run at all — it keeps a Service Worker that would otherwise be
 * killed on idle alive until the upload settles. That is a reason to bound the flush, not to leave it
 * open: a bundle's retry ladder is 10s + 20s + 40s inside `createIssue` and again inside the signed PUT,
 * so an unbounded flush asks the platform to keep the worker alive ~140 s per bundle — well past the
 * extend-lifetime budget any runtime actually grants, which means it is killed mid-flight regardless.
 * Overridable via the `flushTimeoutMs` parameter.
 */
export const SW_FLUSH_TIMEOUT_MS = 10_000;

/** The minimal ExtendableEvent surface: a SW event whose `waitUntil(promise)` extends the worker's life until
 *  the promise settles (FetchEvent / PushEvent / ExtendableMessageEvent / SyncEvent all extend it). */
export interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** A Service Worker event handler (it typically calls `event.respondWith(...)` and returns void). */
export type ServiceWorkerEventHandler<E extends ExtendableEventLike> = (event: E) => unknown;

/** Wrap a Service Worker event handler so an incident's upload completes BEFORE the worker is killed: the SDK
 *  flush is handed to `event.waitUntil`. A thrown handler error is captured (`logException`) + rethrown; an
 *  async handler's rejection is captured too. A clean event flushes a no-op.
 *
 *  ```ts
 *  self.addEventListener('fetch', withBugseeEvent(bugsee, (event) => {
 *    event.respondWith(handle(event.request));
 *  }));
 *  ```
 *
 *  CONTAINED at the host boundary (the Wave 2.1 `neverThrow` rule; the edge sibling guards the same seam —
 *  vercel-edge/src/edge-context.ts). This wrapper runs with the CUSTOMER'S error in flight, and neither
 *  side of it is total: `logException` reads `.message`/`.stack` off the thrown value (a Proxy with a
 *  throwing trap, a throwing `stack` getter or a throwing `toString` — all things a handler can throw —
 *  make it throw), and `waitUntil` throws InvalidStateError on an event that is no longer active. Either
 *  escape would REPLACE the application's error with an SDK one and skip the flush. The flush promise
 *  handed to `waitUntil` can likewise only RESOLVE: a rejected extend-lifetime promise fails the event —
 *  on `install`/`activate` that fails the Service Worker registration itself. SDK-internal failures go to
 *  the optional `onError` sink instead.
 *
 *  @param onError where an SDK-internal failure inside the wrapper is reported; it is never thrown into
 *  the handler. Default: dropped. */
export function withBugseeEvent<E extends ExtendableEventLike>(
  client: Bugsee,
  handler: ServiceWorkerEventHandler<E>,
  onError?: (error: unknown) => void,
  flushTimeoutMs: number = SW_FLUSH_TIMEOUT_MS,
): (event: E) => void {
  const capture = (error: unknown): void => {
    neverThrow(() => client.logException(error, { mechanism: 'uncaught' }), onError);
  };
  // A flush that can only resolve — see the note above on rejected extend-lifetime promises.
  const flushed = async (): Promise<void> => {
    try {
      await client.flush(flushTimeoutMs);
    } catch (error) {
      neverThrow(() => onError?.(error)); // a throwing sink must not defeat the guard either
    }
  };
  const keepAlive = (event: E, promise: Promise<unknown>): void => {
    neverThrow(() => event.waitUntil(promise), onError);
  };
  return (event: E): void => {
    try {
      const result = handler(event);
      if (result instanceof Promise) {
        // Async handler: capture a rejection (it would otherwise be an unhandledrejection), THEN flush — all
        // inside one waitUntil so the worker stays alive through both the handler's work and the upload.
        keepAlive(event, result.catch(capture).then(flushed));
      } else {
        keepAlive(event, flushed());
      }
    } catch (error) {
      // A synchronous throw: capture + flush (kept alive) + rethrow so the platform still sees the failure.
      capture(error);
      keepAlive(event, flushed());
      throw error;
    }
  };
}
