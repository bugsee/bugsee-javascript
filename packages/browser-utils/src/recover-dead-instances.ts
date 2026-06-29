import { type Bundle, deserializeBundle, type UploadPipeline } from '@bugsee/core';
import type { AsyncBlobStore } from './idb';
import {
  createPrefixedBlobStore,
  instanceLockName,
  splitInstanceKey,
} from './instance-coexistence';
import type { WebLockLiveness } from './web-lock-liveness';

/** Recover one dead instance's durable BUNDLE queue: re-upload each persisted bundle via `pipeline`, removing it
 *  on confirmed delivery. AWAITABLE — the coordinator holds the dead instance's Web Lock for the whole duration
 *  (so a concurrent peer skips). Reads straight from the dead instance's prefix of the shared store; unparseable
 *  leftovers are purged so they can't wedge recovery forever. Idempotent + server-side signature-deduped. */
export async function recoverSiblingBundleQueue(
  shared: AsyncBlobStore,
  deadInstanceId: string,
  pipeline: UploadPipeline,
  onError: (error: unknown) => void = () => {},
): Promise<void> {
  const view = createPrefixedBlobStore(shared, deadInstanceId);
  let entries: Array<[string, Uint8Array]>;
  try {
    entries = await view.loadAll(); // the dead instance's own bundles (prefix stripped)
  } catch (error) {
    onError(error); // a read failure must not break launch — skip this sibling's queue
    return;
  }
  for (const [id, bytes] of entries) {
    let bundle: Bundle;
    try {
      bundle = deserializeBundle(bytes);
    } catch (error) {
      onError(error);
      view.remove(id).catch(onError); // unparseable leftover — purge it (best-effort)
      continue;
    }
    try {
      const result = await pipeline.enqueue(bundle);
      if (result.ok) {
        await view.remove(id); // delivered → drop the durable copy
      }
    } catch (error) {
      onError(error);
    }
  }
}

// The browser/worker multi-instance recovery coordinator (docs/design/browser-multi-instance-coexistence.md
// BD4) — the IndexedDB analog of node's `recoverInstances`. On launch, scan the shared store for sibling
// instances (their `"<instanceId>/"` key prefixes ARE the registry), and recover each DEAD one (reusing the
// existing durable pipeline) under that sibling's Web Lock so concurrent peers don't double-recover. Never
// touches a live sibling or self. Idempotent + server-side `request.signatures`-deduped — safe every launch.

export interface RecoverDeadInstancesOptions {
  /** The shared (all-instances) blob store — IndexedDB db `bugsee-<tokenHash>`. */
  shared: AsyncBlobStore;
  /** This live instance's id — its own bundles are delivered by its own live pipeline, never recovered here. */
  selfInstanceId: string;
  /** The app token (for the per-instance Web Lock names). */
  appToken: string;
  /** Web Locks liveness: a sibling is recovered ONLY when dead (its lock acquirable), held during recovery. */
  liveness: WebLockLiveness;
  /** Recover ALL of a dead instance's data (re-upload its bundles + remove its keys) — the launch wires this to
   *  a durable pipeline over the dead instance's prefixed store view. */
  recoverInstance: (instanceId: string) => Promise<void>;
  /** Best-effort error sink; recovery never throws into launch. Default no-op. */
  onError?: (error: unknown) => void;
}

/** Scan for dead sibling instances and recover each (under its lock). Resolves when the pass completes. */
export async function recoverDeadInstances(options: RecoverDeadInstancesOptions): Promise<void> {
  const {
    shared,
    selfInstanceId,
    appToken,
    liveness,
    recoverInstance,
    onError = () => {},
  } = options;

  let entries: Array<[string, Uint8Array]>;
  try {
    entries = await shared.loadAll();
  } catch (error) {
    onError(error); // a read failure must not break launch — just skip recovery this run
    return;
  }

  // The distinct sibling instance ids with pending data (skip self + keys with no instance segment).
  const siblingIds = new Set<string>();
  for (const [key] of entries) {
    const split = splitInstanceKey(key);
    if (split !== undefined && split.instanceId !== selfInstanceId) {
      siblingIds.add(split.instanceId);
    }
  }

  // Recover each — but only if DEAD, holding its lock so a concurrent peer skips it. Per-sibling failures are
  // isolated to onError so one bad sibling doesn't abort the others.
  await Promise.all(
    [...siblingIds].map((instanceId) =>
      liveness
        .recoverIfDead(instanceLockName(appToken, instanceId), () => recoverInstance(instanceId))
        .catch(onError),
    ),
  );
}
