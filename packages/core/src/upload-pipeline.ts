import { computeBackoff, sha256Hex } from '@bugsee/util';
import { BugseeError } from './errors';
import type {
  BugseeApi,
  Bundle,
  BundleUploader,
  DropReason,
  IssueCreateResult,
  OutcomeCategory,
  UploadHint,
  UploadPipeline,
  UploadResult,
} from './transport';

// UploadPipeline orchestrator (design §7.5/§7.8). Per bundle it runs the 3-call operation
// (ensureSession → createIssue → signed PUT), recovers a 403 via renewUpload, retries retryable
// failures with exponential backoff, invalidates the session before retrying an api rejection (so a
// stale 401 token is re-acquired — we can't see the status through an opaque rejection), bounds
// concurrency with a promise buffer (backpressure drops the latest with outcome `queue_overflow`),
// and reports success/drop outcomes per category.

export type PipelineOutcome =
  | { kind: 'success'; category: OutcomeCategory }
  | { kind: 'drop'; category: OutcomeCategory; reason: DropReason };

export interface UploadPipelineOptions {
  api: BugseeApi;
  uploader: BundleUploader;
  /** Max concurrent in-flight operations (§7.8). Default 4. */
  bufferSize?: number;
  /** Retry attempts for retryable failures (§7.5: max 3). Default 3. */
  maxRetries?: number;
  /** Hex SHA-256 of the body for the PUT checksum. Default util.sha256Hex. */
  sha256?: (body: Uint8Array) => Promise<string>;
  /** Delay primitive (injected for tests). Default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff delay for retry `attempt` (1-based). Default util.computeBackoff. */
  computeDelay?: (attempt: number) => number;
  /** Outcome accounting sink (§7.5). */
  onOutcome?: (outcome: PipelineOutcome) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    );
  });

export function createUploadPipeline(options: UploadPipelineOptions): UploadPipeline {
  const { api, uploader, onOutcome } = options;
  const bufferSize = options.bufferSize ?? 4;
  const maxRetries = options.maxRetries ?? 3;
  const sha256 = options.sha256 ?? sha256Hex;
  const sleep = options.sleep ?? defaultSleep;
  const computeDelay = options.computeDelay ?? computeBackoff;

  const inFlight = new Set<Promise<UploadResult>>();

  const fail = (error: BugseeError, category: OutcomeCategory): UploadResult => {
    onOutcome?.({ kind: 'drop', category, reason: 'upload_failed' });
    return { ok: false, error };
  };

  // Phase 1: ensure session + create the issue, retried as a unit (invalidate before each retry).
  const createIssue = async (bundle: Bundle): Promise<IssueCreateResult> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await api.ensureSession(bundle.request.environment);
        return await api.createIssue(bundle.request);
      } catch (err) {
        api.invalidateSession();
        if (attempt >= maxRetries) {
          throw err instanceof BugseeError
            ? err
            : new BugseeError('session/issue failed', 0, { cause: err });
        }
        await sleep(computeDelay(attempt + 1));
      }
    }
  };

  const runOperation = async (bundle: Bundle, category: OutcomeCategory): Promise<UploadResult> => {
    let issue: IssueCreateResult;
    try {
      issue = await createIssue(bundle);
    } catch (err) {
      return fail(err as BugseeError, category);
    }

    const putOptions = {
      contentLength: bundle.body.length,
      checksumSha256: await sha256(bundle.body),
      fileName: bundle.fileName,
    };
    let endpoint = issue.endpoint;
    let lastStatus = 0;

    // Phase 2: signed PUT, bounded by maxRetries; 403 → renew, retryable → backoff.
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(computeDelay(attempt));
      }
      const put = await uploader.putBundle(endpoint, bundle.body, putOptions);
      if (put.ok) {
        onOutcome?.({ kind: 'success', category });
        return { ok: true, issueId: issue.issueId, recordingId: issue.recordingId };
      }
      lastStatus = put.status;
      if (put.status === 403) {
        try {
          endpoint = (await api.renewUpload(bundle.request, issue.issueId, issue.recordingId))
            .endpoint;
        } catch (err) {
          return fail(
            err instanceof BugseeError ? err : new BugseeError('renew failed', 403, { cause: err }),
            category,
          );
        }
        continue;
      }
      if (!put.retryable) {
        break;
      }
    }
    return fail(
      new BugseeError(`bundle upload failed (status ${lastStatus})`, lastStatus),
      category,
    );
  };

  return {
    enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult> {
      const category = hint?.category ?? 'issue';
      if (inFlight.size >= bufferSize) {
        onOutcome?.({ kind: 'drop', category, reason: 'queue_overflow' });
        return Promise.resolve({ ok: false, error: new BugseeError('upload queue overflow', 0) });
      }
      const operation = runOperation(bundle, category);
      inFlight.add(operation);
      void operation.finally(() => {
        inFlight.delete(operation);
      });
      return operation;
    },

    async flush(timeout?: number): Promise<boolean> {
      if (inFlight.size === 0) {
        return true;
      }
      const drained = Promise.allSettled([...inFlight]).then(() => true);
      if (timeout === undefined) {
        return drained;
      }
      return Promise.race([drained, sleep(timeout).then(() => false)]);
    },

    drop(reason: DropReason, category: OutcomeCategory): void {
      onOutcome?.({ kind: 'drop', category, reason });
    },
  };
}
