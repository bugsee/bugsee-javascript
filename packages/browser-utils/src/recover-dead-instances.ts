import {
  DEFAULT_DURABLE_RETENTION,
  deserializeBundleFrame,
  type IdentifiedBundle,
  isUploadSettled,
  type UploadPipeline,
} from '@bugsee/core';
import type { AsyncBlobStore } from './idb';
import { createPrefixedBlobStore } from './instance-coexistence';

/**
 * How long a dead sibling's staged bundle may keep being replayed before it is given up on.
 *
 * This is the ONE bound this tier has, and it exists because "keep retrying" here used to mean literally
 * forever. On node a blob that never settles is bounded twice: `sweep-instances` reaps a dead instance's
 * whole subtree at 7 days, and any blob replayed through `recover()` meets the durable queue's own
 * retention. This leg reads a dead instance's prefix DIRECTLY, so it met neither — and on the web an
 * instance is dead the moment its tab closes, so an undeliverable blob was re-offered at every launch for
 * the lifetime of the installation.
 *
 * NOT bounded here, deliberately: the count and byte caps `recover()` also applies. Those evict the
 * OLDEST SURVIVORS to make room, which on this leg would delete a crash report the collector has never
 * been asked about merely because a burst arrived after it. Age is the one bound where "give up" and
 * "this is worthless now" say the same thing.
 */
export interface SiblingQueueRetention {
  /**
   * Max age of a staged bundle. Default {@link DEFAULT_DURABLE_RETENTION}`.maxAgeMs` (7 days) — taken
   * from there rather than restated, because a second copy of a number that decides whether a crash
   * report is deleted is a copy that drifts.
   */
  maxAgeMs?: number;
  /** Wall clock, for the age comparison. Default `Date.now`. */
  now?: () => number;
}

/**
 * Recover ONE dead instance's durable BUNDLE queue: re-upload each persisted bundle via `pipeline`, dropping
 * the durable copy once the attempt SETTLES — delivered, or permanently refused. A refused bundle kept here
 * would be re-uploaded at every launch for the life of the installation. A bundle the collector never
 * settles at all is bounded instead — see {@link SiblingQueueRetention}; before that this tier had no
 * bound of any kind, where node has both a dead-subtree sweep and the durable queue's own retention.
 *
 * AWAITABLE — the coordinator holds the dead instance's Web Lock for the whole duration (so a concurrent peer
 * skips). Reads straight from the dead instance's prefix of the shared store; unparseable leftovers are purged
 * so they can't wedge recovery forever. Idempotent + server-side signature-deduped.
 */
export async function recoverSiblingBundleQueue(
  shared: AsyncBlobStore,
  deadInstanceId: string,
  pipeline: UploadPipeline,
  onError: (error: unknown) => void = () => {},
  retention: SiblingQueueRetention = {},
): Promise<void> {
  const maxAgeMs = retention.maxAgeMs ?? DEFAULT_DURABLE_RETENTION.maxAgeMs;
  const now = retention.now ?? Date.now;
  const at = now();
  const view = createPrefixedBlobStore(shared, deadInstanceId);
  let entries: Array<[string, Uint8Array]>;
  try {
    entries = await view.loadAll(); // the dead instance's own bundles (prefix stripped)
  } catch (error) {
    onError(error); // a read failure must not break launch — skip this sibling's queue
    return;
  }
  for (const [id, bytes] of entries) {
    let bundle: IdentifiedBundle;
    let firstSeenMs: number | undefined;
    try {
      ({ bundle, firstSeenMs } = deserializeBundleFrame(bytes));
    } catch (error) {
      onError(error);
      view.remove(id).catch(onError); // unparseable leftover — purge it (best-effort)
      continue;
    }
    // An UNKNOWN staging time is never expired. A frame written before the header carried one reads as
    // "we do not know", not as "staged at the epoch" — treating it as the epoch would delete every
    // pending bundle on the first launch after an upgrade, losing exactly the crash reports the upgrade
    // was installed to deliver. Same rule as `durable-upload-pipeline.recoverPass`.
    if (firstSeenMs !== undefined && at - firstSeenMs > maxAgeMs) {
      // Announced, not silent: a bundle that vanishes without an outcome is indistinguishable from one
      // that was delivered.
      pipeline.drop('retention_expired', 'issue');
      try {
        await view.remove(id);
      } catch (error) {
        onError(error); // the bound holds either way — it is withheld from the pipeline regardless
      }
      continue;
    }
    try {
      const result = await pipeline.enqueue(bundle);
      if (isUploadSettled(result)) {
        await view.remove(id); // delivered, or refused → drop the durable copy; retryable → keep it
      }
    } catch (error) {
      onError(error);
    }
  }
}
