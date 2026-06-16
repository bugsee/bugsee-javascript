import { join } from 'node:path';
import {
  type BundleAssemblyContext,
  type BundleStore,
  createFileChunkBackend,
  deserializeBundle,
  recoverReports,
  type UploadPipeline,
} from '@bugsee/core';
import {
  createFsChunkStorage,
  createNodeBundleStore,
  createNodeReportMarkerStore,
  listFiles,
  remove,
} from '@bugsee/node-utils';

// Multi-instance recovery coordinator (design: docs/design/multi-instance-disk-coexistence.md, D4). On
// launch, a live aggregator scans the SIBLING instance subtrees under the shared `dataDir` and recovers each
// one's pending bundles (its durable queue) + detected-incident markers (rebuilt from its capture chunks),
// enqueuing them through THIS instance's upload pipeline, then removes the subtree — but ONLY once it is
// fully delivered (a failed upload leaves the subtree for a later launch to retry; the backend dedups a
// duplicate). It reuses the existing per-incident recovery pipeline — only the per-sibling scan is new.
// (Liveness skip + atomic-rename claim land in slice 4; slice 1 recovers every non-own subtree, correct
// while no live siblings exist.) Fully defensive: a failure on one subtree goes to onError and never blocks
// the others or the launch.

/** Subtree names shaped like an instance id (`<pid>-<threadId>-<nonce>`) — avoids touching foreign files. */
const INSTANCE_DIR = /^\d+-\d+-/;
/** A sentinel matching no real (wall-clock) generation, so the WHOLE dead subtree is recovered + swept. */
const NO_GENERATION = -1;

export interface RecoverInstancesOptions {
  /** The shared root holding every instance's subtree. */
  dataDir: string;
  /** This launch's own instance id — its subtree is never touched. */
  ownInstanceId: string;
  /** The live upload pipeline recovered bundles are enqueued through. */
  uploadPipeline: UploadPipeline;
  /** Base assembly context (appToken + environment + clock); the marker supplies per-incident state. */
  context: () => Omit<BundleAssemblyContext, 'attributes' | 'userIdentifier'>;
  /** Failure sink. Default no-op. */
  onError?: (error: unknown) => void;
}

/** Re-upload a dead instance's durable bundle queue, awaiting each delivery; drop a blob only once confirmed. */
async function drainBundles(
  store: BundleStore,
  uploadPipeline: UploadPipeline,
  onError: (error: unknown) => void,
): Promise<void> {
  for (const id of store.list()) {
    const bytes = store.read(id);
    /* v8 ignore next 2 -- list/read race: blob removed between list() and read() (mirrors durable pipeline) */
    if (bytes === undefined) {
      continue;
    }
    let bundle: ReturnType<typeof deserializeBundle>;
    try {
      bundle = deserializeBundle(bytes);
    } catch (error) {
      onError(error);
      store.remove(id); // unparseable leftover — purge so it can't wedge recovery forever
      continue;
    }
    try {
      const result = await uploadPipeline.enqueue(bundle);
      if (result.ok) {
        store.remove(id); // confirmed delivered — drop; a failure leaves it for a later launch
      }
    } catch (error) {
      onError(error); // keep the blob for retry
    }
  }
}

async function recoverSubtree(
  sub: string,
  options: RecoverInstancesOptions,
  onError: (error: unknown) => void,
): Promise<void> {
  const bundleStore = createNodeBundleStore(join(sub, 'pending'));
  await drainBundles(bundleStore, options.uploadPipeline, onError);

  const markers = createNodeReportMarkerStore(join(sub, 'incidents'), onError);
  await recoverReports({
    backend: createFileChunkBackend(createFsChunkStorage(join(sub, 'capture')), {
      generation: NO_GENERATION,
      cleanOtherGenerations: false,
    }),
    currentGeneration: NO_GENERATION, // excludes nothing → the whole dead subtree is recovered
    markers,
    context: options.context,
    uploadPipeline: options.uploadPipeline,
    onError,
  });

  // Remove the subtree ONLY when fully drained; otherwise keep it for a later launch to retry.
  if (bundleStore.list().length === 0 && markers.list().length === 0) {
    remove(sub);
  }
}

/** Recover every DEAD sibling instance subtree under `dataDir`, then remove each fully-delivered one. */
export async function recoverInstances(options: RecoverInstancesOptions): Promise<void> {
  const onError = options.onError ?? ((): void => {});
  let entries: string[];
  try {
    entries = listFiles(options.dataDir);
  } catch (error) {
    onError(error);
    return;
  }
  for (const id of entries) {
    if (id === options.ownInstanceId || !INSTANCE_DIR.test(id)) {
      continue;
    }
    try {
      await recoverSubtree(join(options.dataDir, id), options, onError);
    } catch (error) {
      onError(error); // a failed subtree is left in place to retry on a later launch
    }
  }
}
