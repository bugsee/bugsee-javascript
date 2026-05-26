import type { TriggerHint } from './contracts';
import { BugseeError } from './errors';
import type { Bundle, UploadPipeline, UploadResult } from './transport';

// Trigger orchestration (design §7.7 trigger path / atomicity). Report assembly is serialized: while
// one bundle is being assembled+enqueued, further triggers queue (bounded by maxQueueDepth, default
// 2); triggers beyond the bound are dropped. This is the `alreadyAssembling` guard — concurrent
// captures during assembly land in the NEXT bundle because each assembly snapshots fresh.
//
// The assembly step (snapshot aggregator → build request.json + manifest → serialize → zip → Bundle)
// is injected, since it depends on environment/options/scope owned by the Client.

export interface TriggerPipelineOptions {
  /** Assemble a bundle for a trigger (snapshots the aggregator, builds request/manifest/files/zip). */
  assemble: (hint: TriggerHint) => Bundle | Promise<Bundle>;
  uploadPipeline: UploadPipeline;
  /** Max triggers queued behind the in-flight assembly before further ones drop. Default 2. */
  maxQueueDepth?: number;
}

export interface TriggerPipeline {
  /** Assemble and upload a report for `hint`; serialized behind any in-flight assembly. */
  trigger(hint: TriggerHint): Promise<UploadResult>;
}

export function createTriggerPipeline(options: TriggerPipelineOptions): TriggerPipeline {
  const { assemble, uploadPipeline } = options;
  const maxQueueDepth = options.maxQueueDepth ?? 2;

  let assembling = false;
  const queue: Array<{ hint: TriggerHint; resolve: (result: UploadResult) => void }> = [];

  const assembleAndEnqueue = async (hint: TriggerHint): Promise<UploadResult> => {
    try {
      const bundle = await assemble(hint);
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
    hint: TriggerHint,
    resolve: (result: UploadResult) => void,
  ): Promise<void> => {
    resolve(await assembleAndEnqueue(hint));
    const next = queue.shift();
    if (next === undefined) {
      assembling = false;
    } else {
      void drain(next.hint, next.resolve);
    }
  };

  return {
    trigger(hint: TriggerHint): Promise<UploadResult> {
      return new Promise<UploadResult>((resolve) => {
        if (assembling) {
          if (queue.length >= maxQueueDepth) {
            resolve({ ok: false, error: new BugseeError('trigger queue overflow', 0) });
            return;
          }
          queue.push({ hint, resolve });
          return;
        }
        assembling = true;
        void drain(hint, resolve);
      });
    },
  };
}
