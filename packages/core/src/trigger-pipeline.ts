import { BugseeError } from './errors';
import type { ReportingRequest } from './reporting';
import type { Bundle, UploadPipeline, UploadResult } from './transport';

// Trigger orchestration (design §7.7 trigger path / atomicity). Report assembly is serialized: while
// one bundle is being assembled+enqueued, further requests queue (bounded by maxQueueDepth, default
// 2); requests beyond the bound are dropped. This is the `alreadyAssembling` guard — concurrent
// captures during assembly land in the NEXT bundle because each assembly snapshots fresh.
//
// The assembly step (snapshot aggregator → build request.json + manifest → serialize → zip → Bundle)
// is injected, since it depends on environment/options owned by the Client.

export interface TriggerPipelineOptions {
  /** Assemble a bundle for a reporting request (snapshots the aggregator, builds request/files/zip). */
  assemble: (request: ReportingRequest) => Bundle | Promise<Bundle>;
  uploadPipeline: UploadPipeline;
  /** Max requests queued behind the in-flight assembly before further ones drop. Default 2. */
  maxQueueDepth?: number;
}

export interface TriggerPipeline {
  /** Assemble and upload a bundle for `request`; serialized behind any in-flight assembly. */
  report(request: ReportingRequest): Promise<UploadResult>;
}

export function createTriggerPipeline(options: TriggerPipelineOptions): TriggerPipeline {
  const { assemble, uploadPipeline } = options;
  const maxQueueDepth = options.maxQueueDepth ?? 2;

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
