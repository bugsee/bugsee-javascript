import type { FileType } from '@bugsee/protocol';
import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
import { defaultEntryFactory } from './capture-data-entry';
import type { ChunkBackend, FrozenPart } from './chunk-backend';
import type { CaptureDataEntry, CaptureEntryFactory, CaptureSnapshot } from './contracts';
import type { ReportMarker, ReportMarkerStore } from './report-marker-store';
import type { UploadPipeline } from './transport';

// Capture recovery: on the next launch, rebuild + upload a detected-incident report from a PRIOR
// generation's preserved capture chunks — the gap the durable bundle queue does NOT cover (incident
// detected, but the process died before its bundle reached the queue). For each pending marker
// (persisted at incident time — R1), read its generation's chunks via the backend, reassemble the
// bundle with the marker's incident-time metadata, and enqueue it through the (durable) upload
// pipeline. A marker + its generation are removed only after delivery succeeds; preserved generations
// that carry no incident are swept. Pure over injected ports (no fs/runtime), best-effort — every
// failure routes to onError and the function never throws into launch.

// Drain a snapshot into reified entries grouped by file type (the read half of CaptureExporter, but
// over a snapshot we already hold rather than a live store), releasing the snapshot when done.
async function drainReified(
  snapshot: CaptureSnapshot,
  factory: CaptureEntryFactory,
): Promise<Map<FileType, CaptureDataEntry[]>> {
  try {
    const grouped = await snapshot.drainAll();
    const out = new Map<FileType, CaptureDataEntry[]>();
    for (const [type, records] of grouped) {
      out.set(
        type,
        records.map((record) => {
          const entry = factory(type);
          entry.deserialize(record.serialized);
          return entry;
        }),
      );
    }
    return out;
  } finally {
    snapshot.release();
  }
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
  /** Failure sink. Default no-op. */
  onError?: (error: unknown) => void;
}

export async function recoverReports(options: RecoverReportsOptions): Promise<void> {
  const { backend, currentGeneration, markers, uploadPipeline } = options;
  const onError = options.onError ?? ((): void => {});
  const entryFactory = options.entryFactory ?? defaultEntryFactory;
  const base = options.context();

  try {
    // Group pending markers by generation, excluding the current launch's.
    const byGeneration = new Map<number, ReportMarker[]>();
    for (const marker of markers.list()) {
      if (marker.generation === currentGeneration) {
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
        const captured = await drainReified(backend.snapshot(frozen), entryFactory);

        for (const marker of group) {
          try {
            const bundle = assembleBundle(marker.request, captured, {
              ...base,
              attributes: marker.attributes,
              userIdentifier: marker.userIdentifier,
            });
            const result = await uploadPipeline.enqueue(bundle);
            if (result.ok) {
              markers.remove(marker.request.id);
            }
            // On !ok (or a throw below) the marker is LEFT — the sweep then keeps its generation's
            // chunks, so the incident is retried on the next launch.
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
    for (const generation of await backend.listGenerations()) {
      if (generation !== currentGeneration && !stillPending.has(generation)) {
        backend.removeGeneration(generation);
      }
    }
  } catch (error) {
    onError(error);
  }
}
