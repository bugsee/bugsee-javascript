import type { BundleStore, UploadPipeline } from '@bugsee/core';
import {
  type AsyncBlobStore,
  type AsyncKeyedStore,
  createIdbBlobStore,
  createIdbKeyedStore,
} from './idb';
import { createPersistentBundleStore } from './idb-bundle-store';
import {
  captureDatabaseName,
  coexistenceDatabaseName,
  createPrefixedBlobStore,
  createPrefixedKeyedStore,
  instanceLockName,
  makeInstanceId,
  markerDatabaseName,
  splitInstanceKey,
} from './instance-coexistence';
import { recoverSiblingBundleQueue } from './recover-dead-instances';
import { createWebLockLiveness, type LockManagerLike } from './web-lock-liveness';

// The browser/worker multi-instance IndexedDB coexistence root (docs/design/browser-multi-instance-
// coexistence.md). IndexedDB is origin-scoped, so N tabs + the page's workers all share it; this gives each
// launch its OWN per-instance namespace (a `"<instanceId>/"` key prefix) inside per-APP-TOKEN databases, has
// it hold ONE Web Lock for its lifetime (liveness), and — after launch — recovers ONLY DEAD siblings'
// leftover data (under each sibling's lock so concurrent peers don't double-recover). It covers, per
// instance, up to three durable stores, all keyed by the SAME instanceId + gated by the SAME lock:
//   • the durable BUNDLE queue        (db `bugsee-<hash>`,         slice 4)
//   • the capture-CHUNK store         (db `bugsee-capture-<hash>`, slice 5 — opt-in via `captureRecovery`)
//   • the report-MARKER store         (db `bugsee-markers-<hash>`, slice 5)
// All recovery is DEAD-SIBLING recovery (BD9): a fresh instanceId per launch ⇒ self's namespaces are empty,
// so the prior crashed session is just a dead sibling. A LIVE sibling holds its lock ⇒ it is skipped ⇒ its
// data is never read, recovered, or swept (this is what closes the multi-tab capture-sweep hazard).

export interface CoexistenceOptions {
  /** The app token — namespaces every database + the per-instance lock names (the wrong-project guard). */
  appToken: string;
  /** Build the durable IndexedDB bundle queue (the platform's `persist` decision). */
  persist: boolean;
  /** Build per-instance capture-chunk + report-marker store VIEWS (browser capture recovery). Default false. */
  captureRecovery?: boolean;
  /** An explicit bundle-store override — bypasses bundle-queue coexistence (the caller owns bundle durability). */
  bundleOverride?: BundleStore;
  /** Best-effort error sink; durability/recovery must never throw into launch. */
  onError?: (error: unknown) => void;
  /** Web Locks manager. Default `navigator.locks` (degrades to no cross-instance recovery when absent). */
  locks?: LockManagerLike;
  /** IDBFactory; injectable for tests. Default `globalThis.indexedDB` (via the stores). */
  indexedDB?: IDBFactory;
}

export interface RecoverDeadSiblingsOptions {
  /** The base (direct) upload pipeline a dead sibling's already-assembled bundles are re-uploaded through. */
  uploadPipeline: UploadPipeline;
  /** Launch-provided capture/marker recovery for ONE dead sibling, given its prefixed store views. The launch
   *  builds the chunk backend + marker store over these and calls core `recoverReports` with its own context.
   *  Omitted ⇒ only the bundle queue is recovered (e.g. the webworker, which has no capture-recovery path). */
  recoverReportsForViews?: (
    captureView: AsyncKeyedStore,
    markerView: AsyncBlobStore,
  ) => Promise<void>;
}

export interface Coexistence {
  /** This launch's instance id (the key prefix + the lock id). */
  readonly instanceId: string;
  /** The durable bundle store to register (the override, the per-instance IDB store, or `undefined`). */
  readonly bundleStore: BundleStore | undefined;
  /** The per-instance capture-chunk store view (or `undefined`). Wrap in `createIdbChunkCaptureStore`. */
  readonly captureView: AsyncKeyedStore | undefined;
  /** The per-instance report-marker blob view (or `undefined`). Wrap in `createPersistentReportMarkerStore`. */
  readonly markerView: AsyncBlobStore | undefined;
  /** After launch: recover every DEAD sibling (re-upload its bundles + run its capture/marker recovery), each
   *  under its own lock. A no-op when this instance has no coexisting durable data. Safe to fire-and-forget. */
  recoverDeadSiblings(options: RecoverDeadSiblingsOptions): Promise<void>;
}

/** Build the multi-instance-safe coexistence root for a launch (bundle queue + optional capture/markers). */
export function createCoexistence(options: CoexistenceOptions): Coexistence {
  const { appToken, persist, captureRecovery, bundleOverride, onError } = options;
  const idbOption = options.indexedDB !== undefined ? { indexedDB: options.indexedDB } : {};
  const instanceId = makeInstanceId();

  // The durable bundle queue: an explicit override bypasses coexistence; else `persist` builds the
  // per-instance IndexedDB store under db `bugsee-<hash>`.
  let bundleStore: BundleStore | undefined;
  let bundleShared: AsyncBlobStore | undefined;
  if (bundleOverride !== undefined) {
    bundleStore = bundleOverride;
  } else if (persist) {
    bundleShared = createIdbBlobStore({
      databaseName: coexistenceDatabaseName(appToken),
      ...idbOption,
    });
    bundleStore = createPersistentBundleStore(
      createPrefixedBlobStore(bundleShared, instanceId),
      onError,
    );
  }

  // The capture-chunk + report-marker stores: per-token databases, per-instance prefixed VIEWS the launch
  // wraps. Only built when capture recovery is enabled.
  let captureView: AsyncKeyedStore | undefined;
  let markerView: AsyncBlobStore | undefined;
  let captureShared: AsyncKeyedStore | undefined;
  let markerShared: AsyncBlobStore | undefined;
  if (captureRecovery === true) {
    captureShared = createIdbKeyedStore({
      databaseName: captureDatabaseName(appToken),
      storeName: 'capture',
      ...idbOption,
    });
    markerShared = createIdbBlobStore({
      databaseName: markerDatabaseName(appToken),
      storeName: 'markers',
      ...idbOption,
    });
    captureView = createPrefixedKeyedStore(captureShared, instanceId);
    markerView = createPrefixedBlobStore(markerShared, instanceId);
  }

  // Hold the instance lock for this realm's lifetime iff there is per-instance durable data a sibling could
  // recover. The same lock covers bundles + chunks + markers (all keyed by this instanceId).
  const liveness = createWebLockLiveness(
    options.locks ?? (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks,
    onError !== undefined ? (message) => onError(new Error(message)) : undefined,
  );
  const coexisting = bundleShared !== undefined || captureShared !== undefined;
  if (coexisting) {
    liveness.holdSelf(instanceLockName(appToken, instanceId));
  }

  return {
    instanceId,
    bundleStore,
    captureView,
    markerView,
    recoverDeadSiblings: async ({ uploadPipeline, recoverReportsForViews }) => {
      if (!coexisting) {
        return;
      }
      // Discover dead-sibling instanceIds from the union of every shared store we have (BD10): the bundle +
      // marker blobs (cheap full loads) and the capture store (a keys-only scan — no values). A read failure
      // on any source is isolated to onError and just contributes no ids.
      const ids = new Set<string>();
      const collect = async (loader: () => Promise<string[]>): Promise<void> => {
        try {
          for (const key of await loader()) {
            const split = splitInstanceKey(key);
            if (split !== undefined && split.instanceId !== instanceId) {
              ids.add(split.instanceId);
            }
          }
        } catch (error) {
          onError?.(error);
        }
      };
      const sources: Array<Promise<void>> = [];
      if (bundleShared !== undefined) {
        const blob = bundleShared;
        sources.push(collect(() => blob.loadAll().then((es) => es.map(([k]) => k))));
      }
      if (markerShared !== undefined) {
        const blob = markerShared;
        sources.push(collect(() => blob.loadAll().then((es) => es.map(([k]) => k))));
      }
      if (captureShared !== undefined) {
        const keyed = captureShared;
        sources.push(collect(() => keyed.keys('')));
      }
      await Promise.all(sources);

      // Recover each dead sibling under its lock (a live sibling holds it ⇒ skipped). Re-upload its bundles
      // directly (no re-persist into our queue) + run its capture/marker recovery. Per-sibling failures are
      // isolated so one bad sibling doesn't abort the others.
      await Promise.all(
        [...ids].map((deadId) =>
          liveness
            .recoverIfDead(instanceLockName(appToken, deadId), async () => {
              if (bundleShared !== undefined) {
                await recoverSiblingBundleQueue(bundleShared, deadId, uploadPipeline, onError);
              }
              if (
                recoverReportsForViews !== undefined &&
                captureShared !== undefined &&
                markerShared !== undefined
              ) {
                await recoverReportsForViews(
                  createPrefixedKeyedStore(captureShared, deadId),
                  createPrefixedBlobStore(markerShared, deadId),
                );
              }
            })
            .catch(onError),
        ),
      );
    },
  };
}
