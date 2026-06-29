import type { BundleStore, UploadPipeline } from '@bugsee/core';
import { createIdbBlobStore } from './idb';
import { createPersistentBundleStore } from './idb-bundle-store';
import {
  coexistenceDatabaseName,
  createPrefixedBlobStore,
  instanceLockName,
  makeInstanceId,
} from './instance-coexistence';
import { recoverDeadInstances, recoverSiblingBundleQueue } from './recover-dead-instances';
import { createWebLockLiveness, type LockManagerLike } from './web-lock-liveness';

// The browser/worker durable BUNDLE queue, multi-instance-safe (docs/design/browser-multi-instance-
// coexistence.md). IndexedDB is origin-scoped, so N tabs + the page's workers all share it; without
// namespacing they cross-recover each other's bundles (and even mix apps). This wraps the durable bundle
// store so each launch writes under its OWN `"<instanceId>/"` prefix inside a per-APP-TOKEN database
// (`bugsee-<tokenHash>`), holds a Web Lock for liveness, and (after launch) re-uploads only a DEAD
// sibling's leftover bundles — under that sibling's lock so concurrent peers don't double-recover.
//
// Scope (BD7): the durable bundle queue only. The rolling capture chunk store + report markers get the
// same treatment in a follow-up; this is the highest-value, simplest piece (an assembled incident bundle
// must never be delivered under the wrong project, nor recovered out from under a live sibling).

export interface CoexistentBundleQueueOptions {
  /** The app token — namespaces the database + the per-instance lock names (keeps apps apart). */
  appToken: string;
  /** Whether to build the durable IndexedDB bundle queue at all (the platform's `persist` decision). */
  persist: boolean;
  /** An explicit bundle-store override — bypasses coexistence entirely (the caller owns durability). */
  override?: BundleStore;
  /** Best-effort error sink; durability/recovery must never throw into launch. */
  onError?: (error: unknown) => void;
  /** Web Locks manager. Default `navigator.locks` (degrades to no cross-instance recovery when absent). */
  locks?: LockManagerLike;
  /** IDBFactory; injectable for tests. Default `globalThis.indexedDB` (via the blob store). */
  indexedDB?: IDBFactory;
}

export interface CoexistentBundleQueue {
  /** The durable bundle store to register (the override, the per-instance IDB store, or `undefined`). */
  readonly bundleStore: BundleStore | undefined;
  /** After launch, re-upload every DEAD sibling's leftover bundles via `pipeline`. A no-op when not
   *  persisting (or overridden). Resolves when the recovery pass completes; safe to fire-and-forget. */
  recoverDeadSiblings(pipeline: UploadPipeline): Promise<void>;
}

const NO_RECOVERY: CoexistentBundleQueue['recoverDeadSiblings'] = () => Promise.resolve();

/** Build the multi-instance-safe durable bundle queue (or pass through an override / no-persist). */
export function createCoexistentBundleQueue(
  options: CoexistentBundleQueueOptions,
): CoexistentBundleQueue {
  const { appToken, persist, override, onError } = options;

  // An explicit store, or no persistence at all → no coexistence layer (and nothing to recover).
  if (override !== undefined) {
    return { bundleStore: override, recoverDeadSiblings: NO_RECOVERY };
  }
  if (!persist) {
    return { bundleStore: undefined, recoverDeadSiblings: NO_RECOVERY };
  }

  const locks =
    options.locks ?? (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  const instanceId = makeInstanceId();
  const shared = createIdbBlobStore({
    databaseName: coexistenceDatabaseName(appToken),
    ...(options.indexedDB !== undefined ? { indexedDB: options.indexedDB } : {}),
  });
  const liveness = createWebLockLiveness(
    locks,
    onError !== undefined ? (message) => onError(new Error(message)) : undefined,
  );
  liveness.holdSelf(instanceLockName(appToken, instanceId)); // hold for this realm's lifetime

  const bundleStore = createPersistentBundleStore(
    createPrefixedBlobStore(shared, instanceId),
    onError,
  );

  return {
    bundleStore,
    recoverDeadSiblings: (pipeline) =>
      recoverDeadInstances({
        shared,
        selfInstanceId: instanceId,
        appToken,
        liveness,
        // Re-upload a dead sibling's already-assembled bundles directly (no re-persist into our queue),
        // removing each from the sibling's prefix on confirmed delivery. `recoverSiblingBundleQueue`
        // defaults its own onError, so passing `undefined` is fine.
        recoverInstance: (deadId) => recoverSiblingBundleQueue(shared, deadId, pipeline, onError),
        ...(onError !== undefined ? { onError } : {}),
      }),
  };
}
