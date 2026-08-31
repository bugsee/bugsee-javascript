import { type Bundle, deserializeBundle, isUploadSettled, type UploadPipeline } from '@bugsee/core';
import type { AsyncBlobStore } from './idb';
import { createPrefixedBlobStore } from './instance-coexistence';

/**
 * Recover ONE dead instance's durable BUNDLE queue: re-upload each persisted bundle via `pipeline`, dropping
 * the durable copy once the attempt SETTLES — delivered, or permanently refused. A refused bundle kept here
 * would be re-uploaded at every launch for the life of the installation, and nothing in this tier would ever
 * bound it (unlike node, browser/worker recovery has no retention sweep at all).
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
      if (isUploadSettled(result)) {
        await view.remove(id); // delivered, or refused → drop the durable copy; retryable → keep it
      }
    } catch (error) {
      onError(error);
    }
  }
}
