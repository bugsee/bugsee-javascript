import { computeBackoff, sha256Hex } from '@bugsee/util';
import { BugseeError } from './errors';
import {
  type BugseeApi,
  type Bundle,
  type BundleUploader,
  classifyServerErrorCode,
  type DropReason,
  type IssueCreateResult,
  type OutcomeCategory,
  type PutResult,
  type UploadHint,
  type UploadPipeline,
  type UploadResult,
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
  /** Max CONCURRENT in-flight operations (§7.8). Default 4. Bundles beyond it WAIT for a slot rather
   *  than being refused — it is a concurrency limit, not an admission limit. */
  bufferSize?: number;
  /** Hard cap on bundles waiting for a slot before one is refused. Default 200. */
  maxWaiting?: number;
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
  // A hard backstop on memory, well above the rate limiter's 100-per-60s admission budget, so it is
  // reached only if something upstream stops honouring that.
  const maxWaiting = options.maxWaiting ?? 200;
  const waiting: Array<{
    bundle: Bundle;
    category: OutcomeCategory;
    resolve: (result: UploadResult | Promise<UploadResult>) => void;
  }> = [];
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

  /**
   * Is this control-plane failure FINAL, and if so how?
   *
   * The control plane has two numeric namespaces that look alike and mean nothing to each other: the
   * HTTP status, and the collector's own `error.code` from a `{ ok: false, error }` envelope — which
   * arrives with HTTP **200**, so the status never reveals it. Only the collector's code is a verdict
   * about the PAYLOAD; a status is a verdict about the request that carried it.
   *
   * So classification here reads the collector code and nothing else (Android's own rule for the session
   * obtain: `BugseeCommunicationManager.sessionObtainFailureResponse:770-792` switches on the server
   * error code, and throws — i.e. retries — for "no internet, server-too-busy, unknown"):
   *
   *   permanent  → the payload can never be accepted. Fail without retrying, and mark the result
   *                `permanent` so the durable queue frees the bundle instead of re-uploading it at every
   *                launch for the life of the installation.
   *   kill_sdk   → the same, PLUS `fatal`, which trips the client's kill state. This is the ONLY thing
   *                that may disable the SDK — Android blacklists an app token here and nowhere else.
   *   otherwise  → `null`: invalidate the session and retry. Transient, auth-expired, an unrecognised
   *                code, and every HTTP status alike. This is the fail-safe direction, and it is what
   *                replaces the old rule that read a 401 or 403 as "the app token is invalid" and
   *                disabled the SDK for the rest of the process.
   */
  const finalControlPlaneFailure = (err: unknown): BugseeError | null => {
    if (!(err instanceof BugseeError) || err.serverCode === undefined) {
      return null;
    }
    const category = classifyServerErrorCode(err.serverCode);
    if (category !== 'permanent' && category !== 'kill_sdk') {
      return null;
    }
    return new BugseeError(err.message, err.code, {
      permanent: true,
      cause: err,
      serverCode: err.serverCode,
      ...(category === 'kill_sdk' ? { fatal: true } : {}),
    });
  };

  // Phase 1: ensure session + create the issue, retried as a unit (invalidate before each retry).
  // EXCEPTION: a collector code the classifier calls final (see above) is not retried at all.
  const createIssue = async (bundle: Bundle): Promise<IssueCreateResult> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await api.ensureSession(bundle.request.environment);
        return await api.createIssue(bundle.request);
      } catch (err) {
        const final = finalControlPlaneFailure(err);
        if (final !== null) {
          throw final; // retrying cannot change the collector's mind about this payload
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
      const error = err as BugseeError;
      // A control-plane verdict the collector will repeat forever is `permanent` for exactly the same
      // reason a refused PUT is: keeping the bundle means re-sending it at every launch for good.
      return fail(error, category, 'upload_failed', error.permanent === true);
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

  /** Begin an upload, holding a concurrency slot until it settles, then release the slot to whoever
   *  is waiting. */
  const start = (bundle: Bundle, category: OutcomeCategory): Promise<UploadResult> => {
    const operation = runOperation(bundle, category);
    inFlight.add(operation);
    void operation.finally(() => {
      inFlight.delete(operation);
      const next = waiting.shift();
      if (next !== undefined) {
        next.resolve(start(next.bundle, next.category));
      }
    });
    return operation;
  };

  return {
    enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult> {
      const category = hint?.category ?? 'issue';
      if (inFlight.size >= bufferSize) {
        if (waiting.length >= maxWaiting) {
          onOutcome?.({ kind: 'drop', category, reason: 'queue_overflow' });
          return Promise.resolve({
            ok: false,
            error: new BugseeError('upload queue overflow', QUEUE_OVERFLOW_CODE),
          });
        }
        // WAIT for a slot rather than refusing. Refusing meant a burst of incidents past `bufferSize`
        // was answered "queue overflow" and, in-process, never retried — a server failing fifty
        // requests at once uploaded a handful and left the rest for the next restart. `bufferSize` is
        // a CONCURRENCY limit, not an admission limit; the storm guards are the Client's rate limiter
        // and the trigger pipeline's queue, both of which run before anything reaches here.
        return new Promise<UploadResult>((resolve) => {
          waiting.push({ bundle, category, resolve });
        });
      }
      return start(bundle, category);
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
