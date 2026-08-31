import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
import { defaultEntryFactory } from './capture-data-entry';
import { drainReified } from './capture-drain';
import type { ChunkBackend, FrozenPart } from './chunk-backend';
import type { CaptureEntryFactory } from './contracts';
import type { IdentifiedBundle } from './durable-upload-pipeline';
import type { ReportMarker, ReportMarkerStore } from './report-marker-store';
import {
  type Bundle,
  isUploadSettled,
  type OutcomeCategory,
  type UploadHint,
  type UploadPipeline,
  type UploadResult,
} from './transport';

// Capture recovery: on the next launch, rebuild + upload a detected-incident report from a PRIOR
// generation's preserved capture chunks — the gap the durable bundle queue does NOT cover (incident
// detected, but the process died before its bundle reached the queue). For each pending marker
// (persisted at incident time — R1), read its generation's chunks via the backend, reassemble the
// bundle with the marker's incident-time metadata, and enqueue it through the (durable) upload
// pipeline. A marker + its generation are removed only after delivery succeeds; preserved generations
// that carry no incident are swept. Pure over injected ports (no fs/runtime), best-effort — every
// failure routes to onError and the function never throws into launch.

/**
 * Reconcile a dead instance's DURABLE BUNDLE QUEUE with its PENDING REPORT MARKERS, so one incident is
 * delivered exactly once. The single definition of that policy — node (`recoverInstances`) and the
 * browser/worker tiers (`browser-utils`'s `Coexistence`) both drive their own queue replay through it.
 *
 * ## Why the two legs collide (the SEV1: `events_count +2` per incident, confirmed on 4 samples)
 *
 * `client.ts`'s `submitReport` writes an incident's report marker BEFORE assembly and clears it only when
 * the upload SETTLES, while `durable-upload-pipeline.ts` stages the assembled bundle BEFORE that upload.
 * A process that dies inside that window leaves BOTH traces of the SAME incident, and recovery's two legs
 * — replay the queue, and rebuild from markers + chunks — then report it twice.
 *
 * ## The rule
 *
 * The staged bundle WINS. It is the incident's primary artifact (assembled at incident time, complete),
 * so it is uploaded and its now-redundant marker retired; the marker leg is told to skip that id via
 * {@link skipReportIds}. Nothing is ever dropped un-uploaded: a blob is removed only by the replay that
 * SETTLED it (the caller's own check — delivered, or permanently refused, the same rule the live durable
 * pipeline applies), and a marker only after ITS OWN incident's bundle settled. A RETRYABLE failure leaves
 * both traces in place, and skips the marker leg for this pass only, so the next launch retries from the
 * blob — no loss, no duplicate.
 *
 * A blob with no `reportId` (a frame from an older SDK, or a synthesized native-crash bundle that never
 * had a marker) matches nothing, so it is simply replayed — never reconciled, never freed.
 */
export interface MarkerAwareBundleReplay {
  /** Drop-in {@link UploadPipeline} to run the dead instance's durable-queue replay through. */
  readonly pipeline: UploadPipeline;
  /**
   * Report ids this replay has settled with (delivered, or attempted and failed) and `recoverReports`
   * must therefore not rebuild in the same pass. Populated as the replay runs — read it after it ends.
   */
  readonly skipReportIds: ReadonlySet<string>;
  /**
   * The dead instance's still-pending incident ids, snapshotted when the replay was built — i.e. exactly
   * the blobs this replay can reconcile. Published for a caller that replays a SECOND, non-per-instance
   * store (an injected `bundleStore`, which bypasses coexistence): it must hand this replay only the blobs
   * belonging to THIS dead instance, and leave the rest for the store's own recovery pass.
   */
  readonly pendingReportIds: ReadonlySet<string>;
}

export interface MarkerAwareBundleReplayOptions {
  /** The SAME dead instance's report-marker store — shared with the marker leg, so the two agree. */
  markers: Pick<ReportMarkerStore, 'list' | 'remove'>;
  /** The real pipeline each staged bundle is delivered through. */
  pipeline: UploadPipeline;
  /** Failure sink for a marker-store write. Default no-op. */
  onError?: (error: unknown) => void;
}

export function createMarkerAwareBundleReplay(
  options: MarkerAwareBundleReplayOptions,
): MarkerAwareBundleReplay {
  const { markers, pipeline } = options;
  const onError = options.onError ?? ((): void => {});
  // Snapshotted BEFORE any replay: the ids whose incident the marker leg would otherwise ALSO rebuild.
  const pending = new Set(markers.list().map((marker) => marker.request.id));
  const skipReportIds = new Set<string>();

  return {
    skipReportIds,
    pendingReportIds: pending,
    pipeline: {
      async enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult> {
        const reportId = (bundle as IdentifiedBundle).reportId;
        const shadowsMarker = reportId !== undefined && pending.has(reportId);
        if (shadowsMarker) {
          // Recorded BEFORE the attempt, never after. This incident is now owned by the blob whatever
          // happens next — delivered, refused, or a THROW out of the pipeline (both callers catch one and
          // keep the blob). An id recorded only on the way back is lost to that throw, and the marker leg
          // then rebuilds and delivers the incident the blob still holds: the duplicate, one launch early.
          skipReportIds.add(reportId);
        }
        const result = await pipeline.enqueue(bundle, hint);
        if (shadowsMarker && isUploadSettled(result)) {
          // SETTLED — delivered, or permanently refused. Either way there is nothing left to retry, the
          // durable copy is freed by the caller, and the marker is redundant: keeping it would rebuild the
          // same incident on every later launch and pin its capture generation for good. A RETRYABLE
          // failure leaves both traces in place, so the next launch retries from the blob.
          try {
            markers.remove(reportId);
          } catch (error) {
            onError(error);
          }
        }
        return result;
      },
      flush: (timeout?: number) => pipeline.flush(timeout),
      drop: (reason: string, category: OutcomeCategory) => pipeline.drop(reason, category),
    },
  };
}

export interface RecoverReportsOptions {
  /** The chunk backend (over the SAME medium as the live store) used to read prior generations. */
  backend: Pick<ChunkBackend, 'listGenerations' | 'listParts' | 'snapshot' | 'removeGeneration'>;
  /** The current launch's generation — never recovered (the live store owns it). */
  currentGeneration: number;
  /** The pending-incident marker store. */
  markers: Pick<ReportMarkerStore, 'list' | 'remove'>;
  /** Base assembly context; the marker supplies `attributes` + `userIdentifier` per incident. */
  context: () => Omit<BundleAssemblyContext, 'attributes' | 'userIdentifier'>;
  /** The (durable) upload pipeline recovered bundles are enqueued through. */
  uploadPipeline: Pick<UploadPipeline, 'enqueue'>;
  /** Entry factory for reifying stored records. Default defaultEntryFactory. */
  entryFactory?: CaptureEntryFactory;
  /**
   * Generations the sweep must NOT free even without a pending report marker — e.g. a still-pending
   * native crash (which leaves a crashpad-session marker, not a report marker) whose capture a later
   * launch will retry. Default: none.
   */
  keepGenerations?: ReadonlySet<number>;
  /** Failure sink. Default no-op. */
  onError?: (error: unknown) => void;
  /**
   * Incidents this pass must NOT rebuild — the dead instance's durable bundle queue already settled with
   * them (see {@link createMarkerAwareBundleReplay}). Rebuilding one here is the confirmed recovery
   * double-upload. A skipped marker is LEFT in place, so its generation survives the sweep and the next
   * launch retries it. Default: none.
   */
  skipReportIds?: ReadonlySet<string>;
}

export async function recoverReports(options: RecoverReportsOptions): Promise<void> {
  const { backend, currentGeneration, markers, uploadPipeline } = options;
  const onError = options.onError ?? ((): void => {});
  const entryFactory = options.entryFactory ?? defaultEntryFactory;
  const base = options.context();

  try {
    // Group pending markers by generation, excluding the current launch's — and excluding any incident
    // the bundle-queue leg has already settled with, which would otherwise be reported twice.
    const skipReportIds = options.skipReportIds;
    const byGeneration = new Map<number, ReportMarker[]>();
    for (const marker of markers.list()) {
      if (
        marker.generation === currentGeneration ||
        skipReportIds?.has(marker.request.id) === true
      ) {
        continue;
      }
      const group = byGeneration.get(marker.generation) ?? [];
      group.push(marker);
      byGeneration.set(marker.generation, group);
    }

    for (const [generation, group] of byGeneration) {
      try {
        const parts = await backend.listParts(generation);
        const frozen: FrozenPart[] = parts.map((part) => ({
          ref: { generation, number: part.number },
          count: Number.MAX_SAFE_INTEGER, // recover the whole part
        }));
        // Drain ONCE per generation — its markers share the same captured context.
        const captured = await drainReified(backend.snapshot(frozen), entryFactory, onError);

        for (const marker of group) {
          try {
            const bundle: IdentifiedBundle = {
              ...assembleBundle(marker.request, captured, {
                ...base,
                attributes: marker.attributes,
                userIdentifier: marker.userIdentifier,
              }),
              // Keep the incident id on the rebuilt bundle: a durable pipeline re-stages it, and only the
              // id lets a later pass tell that blob apart from one nothing has uploaded (see client.ts).
              reportId: marker.request.id,
            };
            const result = await uploadPipeline.enqueue(bundle);
            if (isUploadSettled(result)) {
              // Delivered, or PERMANENTLY refused — settled either way, exactly as the live durable
              // pipeline treats it. Rebuilding a refused bundle on every launch is a self-DoS against our
              // own collector, and its marker would pin the generation's capture forever.
              markers.remove(marker.request.id);
            }
            // On a retryable failure (or a throw below) the marker is LEFT — the sweep then keeps its
            // generation's chunks, so the incident is retried on the next launch.
          } catch (error) {
            onError(error);
          }
        }
      } catch (error) {
        onError(error);
      }
    }

    // Sweep: free every non-current generation with no remaining marker — both the incident gens whose
    // markers all delivered (now markerless) AND preserved no-incident gens. A gen with a still-pending
    // marker (undelivered) is KEPT for a retry. The current generation is the live store's — never swept.
    const stillPending = new Set(markers.list().map((marker) => marker.generation));
    const keep = options.keepGenerations;
    for (const generation of await backend.listGenerations()) {
      if (
        generation !== currentGeneration &&
        !stillPending.has(generation) &&
        keep?.has(generation) !== true
      ) {
        backend.removeGeneration(generation);
      }
    }
  } catch (error) {
    onError(error);
  }
}
