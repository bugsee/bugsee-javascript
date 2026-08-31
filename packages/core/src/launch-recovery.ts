import { createMarkerAwareBundleReplay } from './capture-recovery';
import type { DurableUploadPipeline } from './durable-upload-pipeline';
import type { ReportMarkerStore } from './report-marker-store';
import type { UploadPipeline } from './transport';

// A launch's recovery ORCHESTRATION — one definition, for every platform.
//
// This used to live three times over, copied verbatim into `@bugsee/node`, `@bugsee/browser` and
// `@bugsee/webworker` (the browser and worker copies differed only in a comment's line-wrap), while a
// KNOB for it — `DurableRecoverOptions.select`, plus the hidden `deferred` state it drags along — sat
// in core serving nobody else. The seam pointed the wrong way, and the three copies grew three
// separate defects: a release pass in a bare `.then()` that never ran if the scan threw, an untested
// "never route a recovered blob back through the durable queue" rule, and a blob wedged out of the
// pump. Hoisting the orchestration (not the knob) is what makes those one fix each and one test each.

/**
 * Reconcile a bundle queue that lives OUTSIDE a dead instance's own layout against ONE dead instance's
 * pending report markers, returning the incident ids that instance's marker leg must therefore skip.
 *
 * The platform passes this straight to its dead-sibling scan; it never builds one.
 */
export type ReconcileOwnQueue = (
  markers: Pick<ReportMarkerStore, 'list' | 'remove'>,
) => Promise<ReadonlySet<string>>;

export interface LaunchRecoveryOptions {
  /** This launch's durable bundle queue, when it has one. Absent ⇒ only the scan runs. */
  queue?: DurableUploadPipeline;
  /**
   * True when `queue` writes to a store the INTEGRATOR owns (the public `bundleStore` option) rather
   * than to this launch's own per-instance namespace.
   *
   * It changes everything about the ordering. A per-instance store is fresh every launch, so replaying it
   * is a formality and can happen at once. An integrator's store is STABLE ACROSS LAUNCHES, so it
   * holds the previous launch's staged bundles while those incidents' report markers are still in that
   * launch's (now dead) namespace — replaying it blind reports every one of them TWICE, with differing
   * payloads (`staged:X` vs a rebuilt `inc:X`) that nothing downstream can collapse. So the dead-
   * sibling scan gets first refusal, and only what no sibling claimed is released afterwards.
   */
  shared: boolean;
  /**
   * The base, NON-durable pipeline every recovered blob is delivered through.
   *
   * NEVER the durable queue itself: a blob read out of that very store and routed back through it is
   * `put` again under a fresh id BEFORE the attempt, so one retryable failure leaves two copies of one
   * incident staged and the next launch uploads it twice.
   */
  pipeline: UploadPipeline;
  /**
   * Resolves when `queue`'s backing store can actually be listed. An IndexedDB-backed store serves
   * `list()` from a RAM mirror, so recovering before it hydrates simply sees nothing. A synchronous
   * store has none and is ready at once.
   */
  whenReady?: Promise<void>;
  /**
   * The platform's dead-sibling scan (node `recoverInstances`, browser/worker `recoverDeadSiblings`).
   * It is handed the per-sibling reconciler when — and only when — there is a shared queue to reconcile.
   */
  scan: (reconcileOwnQueue?: ReconcileOwnQueue) => Promise<void>;
  /** Best-effort failure sink. Recovery must never throw into `launch()`. Default no-op. */
  onError?: (error: unknown) => void;
}

/**
 * Run a launch's whole recovery sequence. Resolves when it is finished; NEVER rejects.
 *
 * Order, and why:
 *   1. a PER-INSTANCE queue is recovered immediately (synchronously when the store is synchronous, so
 *      `launch()` still drains it before returning, as node always has);
 *   2. the dead-sibling scan runs, holding a SHARED queue back so each dead sibling takes only the
 *      blobs its own markers cover, through its own marker-aware replay;
 *   3. the release pass hands over whatever the scan left — UNCONDITIONALLY, including when the scan
 *      threw. Anything else turns a transient scan failure into permanent non-delivery, and the scan's
 *      failures are on-disk state that repeats on every launch.
 */
export async function runLaunchRecovery(options: LaunchRecoveryOptions): Promise<void> {
  const { queue, pipeline, whenReady, scan } = options;
  const onError = options.onError ?? ((): void => {});
  /** The queue when — and only when — it is the integrator's, held back for the scan. */
  const sharedQueue = options.shared ? queue : undefined;

  /** Await the store's hydration, reporting rather than propagating a rejected `whenReady`. */
  const ready = async (): Promise<void> => {
    try {
      await whenReady;
    } catch (error) {
      onError(error);
    }
  };
  /** `recover()` guards itself, but a queue is an object a platform supplies: never trust it to. */
  const recover = (
    target: DurableUploadPipeline,
    recoverOptions?: Parameters<DurableUploadPipeline['recover']>[0],
  ): void => {
    try {
      target.recover(recoverOptions);
    } catch (error) {
      onError(error);
    }
  };

  // (1) The own queue. Kept BEFORE the first `await` so a synchronous store is drained during the
  // synchronous part of `launch()`, exactly as it was before this moved into core.
  if (queue !== undefined && sharedQueue === undefined) {
    if (whenReady === undefined) {
      recover(queue);
    } else {
      void ready().then(() => recover(queue));
    }
  }

  // (2) The scan. A shared queue gets a per-sibling reconciler; a per-instance one has nothing to
  // reconcile, so the scan is told so explicitly.
  const reconcileOwnQueue: ReconcileOwnQueue | undefined =
    sharedQueue === undefined
      ? undefined
      : async (markers) => {
          const replay = createMarkerAwareBundleReplay({ markers, pipeline, onError });
          await ready();
          recover(sharedQueue, {
            via: replay.pipeline,
            select: (bundle) =>
              bundle.reportId !== undefined && replay.pendingReportIds.has(bundle.reportId),
          });
          // Complete on return: the replay records an id BEFORE awaiting its upload, and recover()
          // hands every selected blob over synchronously.
          return replay.skipReportIds;
        };
  try {
    await scan(reconcileOwnQueue);
  } catch (error) {
    onError(error);
  }

  // (3) The release pass — whatever no dead sibling's markers claimed. Unconditional.
  if (sharedQueue !== undefined) {
    await ready();
    recover(sharedQueue);
  }
}
