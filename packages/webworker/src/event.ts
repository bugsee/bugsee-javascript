import type { Bugsee } from './launch';

// Service Worker event flush (design §3.x — the SW analog of the edge ctx.waitUntil). A Service Worker is
// TERMINATED when idle, so a fire-and-forget incident upload can be dropped before it completes. Wrapping a SW
// event handler hands the SDK flush to `event.waitUntil`, which keeps the worker alive until the upload
// finishes — the exact isolate-freeze guard the edge SDK uses (vercel-edge wait-until.ts). A dedicated/shared
// Web Worker is long-lived and does NOT need this; it's Service-Worker-only.

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
 *  ``` */
export function withBugseeEvent<E extends ExtendableEventLike>(
  client: Bugsee,
  handler: ServiceWorkerEventHandler<E>,
): (event: E) => void {
  return (event: E): void => {
    try {
      const result = handler(event);
      if (result instanceof Promise) {
        // Async handler: capture a rejection (it would otherwise be an unhandledrejection), THEN flush — all
        // inside one waitUntil so the worker stays alive through both the handler's work and the upload.
        event.waitUntil(
          result
            .catch((error: unknown) => {
              void client.logException(error, { mechanism: 'uncaught' });
            })
            .then(() => client.flush()),
        );
      } else {
        event.waitUntil(client.flush());
      }
    } catch (error) {
      // A synchronous throw: capture + flush (kept alive) + rethrow so the platform still sees the failure.
      void client.logException(error, { mechanism: 'uncaught' });
      event.waitUntil(client.flush());
      throw error;
    }
  };
}
