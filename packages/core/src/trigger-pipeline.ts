import { BugseeError } from './errors';
import type { ReportingRequest } from './reporting';
import type { Bundle, UploadPipeline, UploadResult } from './transport';

// Trigger orchestration (design §7.7 trigger path / atomicity). Report assembly is serialized: while
// one bundle is being assembled+enqueued, further requests queue. This is the `alreadyAssembling`
// guard — concurrent captures during assembly land in the NEXT bundle because each assembly snapshots
// fresh.
//
// The QUEUE BOUND used to default to 2, which meant a server failing twenty requests at once
// assembled one report, queued two, and silently dropped the other seventeen — they never became
// bundles, so they never reached the durable store and were not recoverable at the next launch
// either. Those incidents simply never existed. The storm guard is the Client's rate limiter (100 per
// 60s, applied BEFORE anything reaches here); this was a second, far tighter bound nobody chose, and
// it is now aligned with that budget so the rate limiter is the single place a storm is capped.
//
// The assembly step (drain the CaptureExporter → build request.json + manifest → serialize → zip →
// Bundle) is injected, since it depends on environment/options owned by the Client.

/** Matches the Client's default capture rate limit (rate-limiter.ts), which is the real storm guard. */
const DEFAULT_MAX_QUEUE_DEPTH = 100;

export interface TriggerPipelineOptions {
  /** Assemble a bundle for a reporting request (drains the CaptureExporter, builds request/files/zip). */
  assemble: (request: ReportingRequest) => Bundle | Promise<Bundle>;
  uploadPipeline: UploadPipeline;
  /**
   * Max requests queued behind the in-flight assembly before further ones are refused. Default 100 —
   * the Client's capture rate-limit budget, so this bound never discards a report the rate limiter
   * already admitted.
   */
  maxQueueDepth?: number;
}

export interface TriggerPipeline {
  /** Assemble and upload a bundle for `request`; serialized behind any in-flight assembly. */
  report(request: ReportingRequest): Promise<UploadResult>;
}

export function createTriggerPipeline(options: TriggerPipelineOptions): TriggerPipeline {
  const { assemble, uploadPipeline } = options;
  const maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;

  let assembling = false;
  const queue: Array<{ request: ReportingRequest; resolve: (result: UploadResult) => void }> = [];

  const assembleAndEnqueue = async (request: ReportingRequest): Promise<UploadResult> => {
    try {
      const bundle = await assemble(request);
      return await uploadPipeline.enqueue(bundle);
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof BugseeError
            ? err
            : new BugseeError('bundle assembly failed', 0, { cause: err }),
      };
    }
  };

  const drain = async (
    request: ReportingRequest,
    resolve: (result: UploadResult) => void,
  ): Promise<void> => {
    resolve(await assembleAndEnqueue(request));
    const next = queue.shift();
    if (next === undefined) {
      assembling = false;
    } else {
      void drain(next.request, next.resolve);
    }
  };

  return {
    report(request: ReportingRequest): Promise<UploadResult> {
      return new Promise<UploadResult>((resolve) => {
        if (assembling) {
          if (queue.length >= maxQueueDepth) {
            resolve({ ok: false, error: new BugseeError('report queue overflow', 0) });
            return;
          }
          queue.push({ request, resolve });
          return;
        }
        assembling = true;
        void drain(request, resolve);
      });
    },
  };
}
