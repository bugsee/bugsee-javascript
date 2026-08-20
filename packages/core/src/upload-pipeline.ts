import { computeBackoff, sha256Hex } from '@bugsee/util';
import { BugseeError } from './errors';
import type {
  BugseeApi,
  Bundle,
  BundleUploader,
  DropReason,
  IssueCreateResult,
  OutcomeCategory,
  PutResult,
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

/**
 * The code on the error returned when a bundle is refused for CAPACITY rather than rejected.
 *
 * The distinction matters to the durable layer: a bundle refused because the pipeline was momentarily
 * full is worth handing back the moment a slot frees, while one that failed against a 5xx or an
 * offline network is not — that is what the next launch is for. Without a way to tell them apart, the
 * choice is between losing a burst until restart and retrying a dead upload in a hot loop.
 */
export const QUEUE_OVERFLOW_CODE = 1001;

export function createUploadPipeline(options: UploadPipelineOptions): UploadPipeline {
  const { api, uploader, onOutcome } = options;
  const bufferSize = options.bufferSize ?? 4;
  const maxRetries = options.maxRetries ?? 3;
  const sha256 = options.sha256 ?? sha256Hex;
  const sleep = options.sleep ?? defaultSleep;
  const computeDelay = options.computeDelay ?? computeBackoff;

  const inFlight = new Set<Promise<UploadResult>>();

  const fail = (
    error: BugseeError,
    category: OutcomeCategory,
    reason: DropReason = 'upload_failed',
    permanent = false,
  ): UploadResult => {
    onOutcome?.({ kind: 'drop', category, reason });
    // `permanent` is what lets the DURABLE queue tell "the network was down" from "the collector refused
    // this payload" (Wave 6.4). Without it both arrive as {ok:false} and a refused bundle is retried at
    // every launch, forever.
    return permanent ? { ok: false, error, permanent } : { ok: false, error };
  };

  // Phase 1: ensure session + create the issue, retried as a unit (invalidate before each retry).
  // EXCEPTION: a 401/403 from ensureSession is the APP TOKEN itself being rejected (session create is
  // app-token-authenticated) — retrying can't recover it, so it fails FATALLY (no retry) and the
  // client enters its kill-state. A 401 from createIssue is a stale ACCESS token → recoverable retry.
  const createIssue = async (bundle: Bundle): Promise<IssueCreateResult> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        try {
          await api.ensureSession(bundle.request.environment);
        } catch (err) {
          if (err instanceof BugseeError && (err.code === 401 || err.code === 403)) {
            throw new BugseeError('invalid app token', err.code, { fatal: true, cause: err });
          }
          throw err; // any other session failure falls through to the recoverable retry below
        }
        return await api.createIssue(bundle.request);
      } catch (err) {
        if (err instanceof BugseeError && err.fatal) {
          throw err; // do not retry / re-acquire — the app token is invalid
        }
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

    let checksumSha256: string;
    try {
      checksumSha256 = await sha256(bundle.body);
    } catch (err) {
      return fail(
        err instanceof BugseeError ? err : new BugseeError('checksum failed', 0, { cause: err }),
        category,
      );
    }
    const putOptions = {
      contentLength: bundle.body.length,
      checksumSha256,
      fileName: bundle.fileName,
    };
    let endpoint = issue.endpoint;
    let lastStatus = 0;
    let lastCause: unknown;
    let renewed = false;
    let nonRetryable = false;

    // Phase 2: signed PUT, bounded by maxRetries; 403 → renew (once), retryable → backoff.
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(computeDelay(attempt));
      }
      let put: PutResult;
      try {
        put = await uploader.putBundle(endpoint, bundle.body, putOptions);
      } catch (err) {
        return fail(
          err instanceof BugseeError
            ? err
            : new BugseeError('bundle upload threw', 0, { cause: err }),
          category,
        );
      }
      if (put.ok) {
        onOutcome?.({ kind: 'success', category });
        return { ok: true, issueId: issue.issueId, recordingId: issue.recordingId };
      }
      lastStatus = put.status;
      lastCause = put.cause;
      if (put.status === 403) {
        // 403 (signed PUT): renew the signed url once; a second 403 gives up `renew_failed` (§14.8).
        if (renewed) {
          return fail(new BugseeError('signed url renew failed', 403), category, 'renew_failed');
        }
        try {
          endpoint = (await api.renewUpload(bundle.request, issue.issueId, issue.recordingId))
            .endpoint;
        } catch (err) {
          return fail(
            err instanceof BugseeError ? err : new BugseeError('renew failed', 403, { cause: err }),
            category,
            'renew_failed',
          );
        }
        renewed = true;
        continue;
      }
      if (!put.retryable) {
        nonRetryable = true;
        break;
      }
    }
    return fail(
      new BugseeError(
        `bundle upload failed (status ${lastStatus})`,
        lastStatus,
        // The transport's own error, when there was one — `status 0` on its own says only that the
        // request never completed, which is the same answer for every network-level failure.
        lastCause !== undefined ? { cause: lastCause } : undefined,
      ),
      category,
      'upload_failed',
      // Only a NON-RETRYABLE status is permanent. Exhausting the retry budget against 5xx/network errors
      // is not: those are exactly the bundles the durable queue exists to carry to the next launch.
      nonRetryable,
    );
  };

  return {
    enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult> {
      const category = hint?.category ?? 'issue';
      if (inFlight.size >= bufferSize) {
        onOutcome?.({ kind: 'drop', category, reason: 'queue_overflow' });
        return Promise.resolve({
          ok: false,
          error: new BugseeError('upload queue overflow', QUEUE_OVERFLOW_CODE),
        });
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
