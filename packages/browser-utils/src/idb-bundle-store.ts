import type { BundleStore } from '@bugsee/core';
import type { AsyncBlobStore } from './idb';

// The durable BundleStore the browser's crash-recovery queue persists to. The core BundleStore
// contract is SYNCHRONOUS (put/list/read/remove) but IndexedDB is async, so an in-memory mirror serves
// every sync call immediately while writes are persisted through to the blob store off the hot path,
// and `whenReady` resolves once the mirror has been hydrated from durable storage on open. The
// composition root defers recover() until whenReady so list() reflects bundles a prior run left behind.

/** A {@link BundleStore} backed by an async blob store via an in-memory mirror. */
export interface PersistentBundleStore extends BundleStore {
  /** Resolves once the mirror has hydrated from durable storage (recovery reads it after). */
  readonly whenReady: Promise<void>;
}

/**
 * Adapt an async {@link AsyncBlobStore} to the mostly-sync {@link BundleStore} contract. The mirror
 * serves reads synchronously; writes persist through asynchronously; hydration loads durable bundles
 * into the mirror on open (a live put during hydration wins). Removal and hydration failures route to
 * `onError` and never throw — best-effort durability must not break the upload path. A `put` failure
 * is the exception: it is REPORTED TO THE CALLER through the returned promise, because the durable
 * queue must know whether the blob is really staged before it tells the client the incident is safe.
 */
export function createPersistentBundleStore(
  blob: AsyncBlobStore,
  onError: (error: unknown) => void = () => {},
): PersistentBundleStore {
  const mirror = new Map<string, Uint8Array>();
  // Ids written or removed before hydration finishes: a live op always wins over the persisted value,
  // so hydration must not re-apply (put) NOR resurrect (remove) them.
  const touched = new Set<string>();
  const whenReady = blob.loadAll().then((entries) => {
    for (const [id, bytes] of entries) {
      if (!touched.has(id)) {
        mirror.set(id, bytes);
      }
    }
  }, onError); // hydration failure → empty mirror (no recovery this run); launch still proceeds

  return {
    whenReady,
    put(id, bytes) {
      touched.add(id);
      mirror.set(id, bytes);
      // RETURNED, not swallowed. The durable queue awaits this to decide `UploadResult.retained`, and
      // the client retires the incident's report marker on the strength of that. A `.catch(onError)`
      // here made the failure invisible to the only caller that can act on it, so on the tier where
      // quota exhaustion is routine the marker was retired with nothing durable behind it.
      const written = blob.put(id, bytes);
      // Marking it handled is NOT the same as swallowing it: `written` still rejects for the queue's
      // own handler, but a caller that ignores the return cannot leak an `unhandledrejection` into the
      // host page. The SDK must never alter application behaviour, and this store is public API.
      written.catch(() => {});
      return written;
    },
    list() {
      return [...mirror.keys()];
    },
    read(id) {
      return mirror.get(id);
    },
    remove(id) {
      touched.add(id);
      mirror.delete(id);
      blob.remove(id).catch(onError);
    },
  };
}
