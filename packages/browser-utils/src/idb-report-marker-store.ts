import type { ReportMarker, ReportMarkerStore } from '@bugsee/core';
import type { AsyncBlobStore } from './idb';

// The durable ReportMarkerStore for browser capture recovery (the detected-incident gap). Core's
// contract is SYNCHRONOUS (put/list/remove) but IndexedDB is async, so — exactly like the bundle queue
// (createPersistentBundleStore) — an in-memory mirror serves every sync call immediately while writes
// persist through off the hot path, and `whenReady` resolves once the mirror has hydrated from durable
// storage on open. The browser launch defers capture recovery until whenReady so list() reflects the
// markers a prior (crashed) run left behind. A corrupt persisted marker is dropped + routed to onError.

/** A {@link ReportMarkerStore} backed by an async blob store via an in-memory mirror. */
export interface PersistentReportMarkerStore extends ReportMarkerStore {
  /** Resolves once the mirror has hydrated from durable storage (recovery reads it after). */
  readonly whenReady: Promise<void>;
}

const encode = (marker: ReportMarker): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(marker));
const decode = (bytes: Uint8Array): ReportMarker =>
  JSON.parse(new TextDecoder().decode(bytes)) as ReportMarker;

/**
 * Adapt an async {@link AsyncBlobStore} to the sync {@link ReportMarkerStore} contract. The mirror
 * serves reads/writes synchronously (keyed by `request.id`); writes persist through asynchronously;
 * hydration loads durable markers into the mirror on open (a live op during hydration wins). A corrupt
 * persisted marker is purged. Persistence/hydration failures route to `onError` and never throw.
 */
export function createPersistentReportMarkerStore(
  blob: AsyncBlobStore,
  onError: (error: unknown) => void = (): void => {},
): PersistentReportMarkerStore {
  const mirror = new Map<string, ReportMarker>();
  // Ids written or removed before hydration finishes: a live op always wins over the persisted value,
  // so hydration must not re-apply (put) NOR resurrect (remove) them.
  const touched = new Set<string>();
  const whenReady = blob.loadAll().then((entries) => {
    for (const [id, bytes] of entries) {
      if (touched.has(id)) {
        continue;
      }
      try {
        mirror.set(id, decode(bytes));
      } catch (error) {
        onError(error);
        blob.remove(id).catch(onError); // purge an unparseable leftover
      }
    }
  }, onError); // hydration failure → empty mirror (no recovery this run); launch still proceeds

  return {
    whenReady,
    put(marker) {
      const id = marker.request.id;
      touched.add(id);
      mirror.set(id, marker);
      blob.put(id, encode(marker)).catch(onError);
    },
    list() {
      return [...mirror.values()];
    },
    remove(id) {
      touched.add(id);
      mirror.delete(id);
      blob.remove(id).catch(onError);
    },
  };
}
