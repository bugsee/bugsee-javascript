import { join } from 'node:path';
import {
  type BundleAssemblyContext,
  type BundleStore,
  createFileChunkBackend,
  createMarkerAwareBundleReplay,
  deserializeBundle,
  isUploadSettled,
  type NativeCrashSource,
  type ReportMarkerStore,
  recoverNativeCrashes,
  recoverReports,
  type UploadPipeline,
} from '@bugsee/core';
import {
  createFsChunkStorage,
  createNodeBundleStore,
  createNodeCrashpadSessionMarkerStore,
  createNodeReportMarkerStore,
  listFiles,
  remove,
} from '@bugsee/node-utils';
import {
  DEFAULT_PATIENT_MS,
  isSiblingDead,
  pidAlive,
  readLiveMtimeMs,
  readOwner,
} from './liveness';

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
  /**
   * The Crashpad-dir seam (Electron). When set, each dead sibling's crashpad-session marker is read and
   * its pending native `.dmp`s are harvested + synthesized into session-stitched crash bundles
   * (docs/design/electron-native-crashes.md §6.1). Absent → native recovery is skipped.
   */
  nativeCrashSource?: NativeCrashSource;
  /** Now (ms) for the heartbeat-staleness check. Default Date.now. */
  now?: () => number;
  /** How long an alive-pid subtree may be heartbeat-stale before reclaim. Default DEFAULT_PATIENT_MS. */
  patientMs?: number;
  /** Failure sink. Default no-op. */
  onError?: (error: unknown) => void;
  /**
   * Reconcile a bundle queue that lives OUTSIDE the per-instance layout — an injected `bundleStore`,
   * which is a store the integrator keeps stable across launches — against ONE dead sibling's pending
   * markers. Called with that sibling's marker store after its own `pending/` has been drained and
   * BEFORE its marker leg runs; the ids it returns are withheld from that leg exactly like the
   * subtree's own queue leg's. Absent (the default per-instance store) ⇒ there is nothing to reconcile.
   */
  reconcileOwnQueue?: (
    markers: Pick<ReportMarkerStore, 'list' | 'remove'>,
  ) => Promise<ReadonlySet<string>>;
}

/** Re-upload a dead instance's durable bundle queue, awaiting each attempt; drop a blob only once settled. */
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
      if (isUploadSettled(result)) {
        // Delivered, or REFUSED — the same rule the live durable pipeline applies. Keeping a refused
        // bundle means re-uploading it at every launch forever; a retryable failure leaves it in place.
        store.remove(id);
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
  const markers = createNodeReportMarkerStore(join(sub, 'incidents'), onError);

  // SEV1 (recovery double-upload, confirmed on 4 samples — events_count +2 per incident, never +1): a
  // bundle can reach `pending/` and STILL leave its incident's report marker behind — the process can die
  // after the durable put but before the upload settles, and client.ts's submitReport clears the marker
  // only once that upload settles. Replaying `pending/` AND rebuilding the same incident from its marker +
  // chunks reports it twice. The shared core policy (`createMarkerAwareBundleReplay`) reconciles the two
  // PER INCIDENT, keyed on the report id the durable frame carries: the staged bundle is delivered, its
  // now-redundant marker retired, and only that id is withheld from the marker leg below. A blob whose
  // incident has no pending marker — its marker was cleared on a non-ok upload, or it was re-staged here
  // by an earlier recovery, or it predates the id — is replayed exactly as before, never dropped.
  const replay = createMarkerAwareBundleReplay({
    markers,
    pipeline: options.uploadPipeline,
    onError,
  });
  await drainBundles(bundleStore, replay.pipeline, onError);

  // …and the same reconciliation for a bundle store the caller owns outside this layout (an injected
  // `bundleStore`): it is shared by every launch, so it can hold THIS dead sibling's staged bundles while
  // its markers are still here, and the two legs would otherwise report each of those incidents twice with
  // differing payloads. The callback takes only the blobs this sibling's markers cover.
  const ownQueueSkip = await options.reconcileOwnQueue?.(markers);

  const backend = createFileChunkBackend(createFsChunkStorage(join(sub, 'capture')), {
    generation: NO_GENERATION,
    cleanOtherGenerations: false,
  });

  // Native-crash recovery (Electron/Crashpad — docs/design/electron-native-crashes.md §6.1): a native
  // crash kills the process instantly, leaving a crashpad-session marker (NOT a report marker). It must
  // run BEFORE recoverReports, whose sweep would otherwise free the crashed generation's capture. Only
  // when a source is configured (Electron supplies it); a still-pending native crash protects its
  // generation from the sweep (keepGenerations) and holds the subtree for a later retry.
  let nativePending = false;
  const keepGenerations = new Set<number>();
  if (options.nativeCrashSource !== undefined) {
    const crashpad = createNodeCrashpadSessionMarkerStore(join(sub, 'incidents'), onError);
    const marker = crashpad.read();
    if (marker !== undefined) {
      const result = await recoverNativeCrashes({
        backend,
        marker,
        source: options.nativeCrashSource,
        context: options.context,
        uploadPipeline: options.uploadPipeline,
        onError,
      });
      if (result.complete) {
        crashpad.remove();
      } else {
        nativePending = true;
        keepGenerations.add(marker.generation);
      }
    }
  }

  await recoverReports({
    backend,
    currentGeneration: NO_GENERATION, // excludes nothing → the whole dead subtree is recovered
    markers,
    context: options.context,
    uploadPipeline: options.uploadPipeline,
    keepGenerations,
    onError,
    skipReportIds:
      ownQueueSkip === undefined
        ? replay.skipReportIds
        : new Set([...replay.skipReportIds, ...ownQueueSkip]),
  });

  // Remove the subtree ONLY when fully drained (no bundles, no report markers, no pending native crash);
  // otherwise keep it for a later launch to retry.
  if (bundleStore.list().length === 0 && markers.list().length === 0 && !nativePending) {
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
  const now = options.now ?? Date.now;
  const patientMs = options.patientMs ?? DEFAULT_PATIENT_MS;
  for (const id of entries) {
    if (id === options.ownInstanceId || !INSTANCE_DIR.test(id)) {
      continue;
    }
    const sub = join(options.dataDir, id);
    try {
      // Liveness gate (D2): only recover a DEAD sibling. A subtree with no owner.json can't be
      // liveness-checked — leave it (an early-crash dir has no incident, since owner.json is written
      // before any capture); a LIVE owner (pid alive + fresh heartbeat) is never touched.
      //
      // The probe is INSIDE the try because it reads the filesystem and can throw: `readOwner` →
      // `readFileBytes` re-throws every non-ENOENT errno (EACCES on a root-written subtree, EISDIR on a
      // corrupt one), and `pidAlive`'s injectable `kill` is a seam a host can make throw. Outside the
      // try, one such subtree rejected the WHOLE scan — and with the launch's release pass hanging off
      // a `.then()`, a held-back bundle was then delivered on no launch at all.
      const owner = readOwner(join(sub, 'owner.json'));
      if (owner === undefined) {
        continue;
      }
      if (
        !isSiblingDead(
          pidAlive(owner.pid),
          readLiveMtimeMs(join(sub, '.live')),
          now(),
          patientMs,
          owner.threadId,
        )
      ) {
        continue;
      }
      await recoverSubtree(sub, options, onError);
    } catch (error) {
      onError(error); // a failed subtree is left in place to retry on a later launch
    }
  }
}
