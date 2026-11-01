import type { BundleAssemblyContext } from './bundle-assembler';
import { isBundleBody } from './bundle-body';
import { assembleBundleStream } from './bundle-stream-assembler';
import { streamReified } from './capture-drain';
import type { CaptureEntryFactory, CaptureSnapshot } from './contracts';
import type { ReportingRequest } from './reporting';
import type { Bundle, UploadPipeline, UploadResult } from './transport';

// The two recovery paths (capture-recovery, native-crash-recovery) rebuild a bundle from a PRIOR generation's preserved
// chunks. They used to drain the whole generation into parsed entries and assemble from that; this reads the generation's
// snapshot one entry at a time into the streaming assembler instead (docs/design/streaming-export.md), so a recovered
// window costs what a live export costs.

/**
 * Build a bundle from `snapshot`, streaming. The snapshot is released when the read ends, on success and failure alike;
 * a torn record is skipped and reported to `onTornRecord` (default `context.onError`), never allowed to fail the generation's
 * recovery. The recovery paths pass their own sink: it is where the drain they replaced reported them.
 *
 * The default (memory) sink hands out plain bytes, as every assembler did; any other sink's body is passed on for the
 * upload pipeline to own.
 */
export async function assembleFromSnapshot(
  request: ReportingRequest,
  snapshot: CaptureSnapshot,
  factory: CaptureEntryFactory,
  context: BundleAssemblyContext,
  onTornRecord: (error: unknown) => void = context.onError ?? ((): void => {}),
): Promise<Bundle> {
  const assembled = await assembleBundleStream(
    request,
    streamReified(snapshot, factory, onTornRecord),
    context,
  );
  return {
    request: assembled.request,
    fileName: assembled.fileName,
    body: assembled.body.peek() ?? assembled.body,
  };
}

/**
 * Hand `bundle` to the pipeline, which owns (and disposes) its body from `enqueue` on. A pipeline that THROWS never took
 * it, so nothing else will release a file/Blob-backed body: do it here.
 */
export async function enqueueOwningBody(
  pipeline: Pick<UploadPipeline, 'enqueue'>,
  bundle: Bundle,
): Promise<UploadResult> {
  try {
    return await pipeline.enqueue(bundle);
  } catch (error) {
    if (isBundleBody(bundle.body)) {
      try {
        void Promise.resolve(bundle.body.dispose()).catch(() => {});
      } catch {
        // releasing must never change the outcome
      }
    }
    throw error;
  }
}
