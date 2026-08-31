import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import { serviceToken } from '@bugsee/service';
import type { AccessToken, IssueId, RecordingId } from '@bugsee/types';
import type { BugseeError } from './errors';

// Transport split into three roles (design §7.5). The BugseeApi / BundleUploader / UploadPipeline
// LOGIC is platform-agnostic, so core owns the implementations (bugsee-api.ts, bundle-uploader.ts,
// upload-pipeline.ts); only the raw HTTP primitive (HttpTransport below) is platform-specific —
// node:http(s) in @bugsee/node, fetch/XHR in @bugsee/browser. Platforms supply the transport; they
// do NOT reimplement the api/uploader. Contracts are type-only; validated by transport.test-d.ts.

/**
 * The minimal, runtime-portable HTTP primitive each platform supplies (the only platform-specific
 * piece of the transport). node-utils `httpRequest` implements this over node:http(s); a browser
 * tier wraps fetch/XHR. Non-2xx resolves (callers map status); only network errors/timeouts reject.
 */
export type HttpTransport = (url: string, options?: HttpRequestOptions) => Promise<HttpResponse>;

export interface HttpRequestOptions {
  /** HTTP method. Default 'GET'. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body. */
  body?: Uint8Array | string;
  /** Abort + reject after this many ms. */
  timeoutMs?: number;
}

export interface HttpResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers (lowercased keys). */
  headers: Record<string, string | string[] | undefined>;
  /** Response body bytes. */
  body: Uint8Array;
}

/** Result of POST /v2/issues — the signed PUT url + identifiers (§7.5/§8.1). */
export interface IssueCreateResult {
  /** Signed S3 PUT url. */
  endpoint: string;
  issueId: IssueId;
  recordingId: RecordingId;
}

/** Result of the signed-URL PUT (§7.5). */
export type PutResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      retryable: boolean;
      /** The underlying transport error, when the failure was a throw rather than an HTTP status.
       *  Without it a DNS failure, a TLS failure and an aborted socket are indistinguishable. */
      cause?: unknown;
    };

/** CONTROL PLANE — authenticated; orchestrates session + issue lifecycle (§7.5). */
export interface BugseeApi {
  /**
   * The client-minted per-launch session-correlation id (Bugsee OTLP Profile v1 §12 `bugsee=s<id>` +
   * §10 `bugsee.session.id`). Sent at POST /v2/sessions so the collector can join the session to traces;
   * read by the trace-propagation decorator and the OTLP resource. Stable for the life of the api.
   */
  readonly sessionId: string;
  /** Memoized; refreshes on 401. Returns the Bearer access token. */
  ensureSession(environment: EnvironmentEnvelope): Promise<AccessToken>;
  /** POST /v2/issues with the request.json body; returns signed PUT url + ids. */
  createIssue(request: RequestJson): Promise<IssueCreateResult>;
  /** 403 recovery: re-request a signed url for an existing issue/recording. */
  renewUpload(
    request: RequestJson,
    issueId: IssueId,
    recordingId: RecordingId,
  ): Promise<IssueCreateResult>;
  /** Drop the cached access token; the next ensureSession re-acquires. */
  invalidateSession(): void;
}

/** PUT headers for the signed-URL upload (§8.3). */
export interface PutBundleOptions {
  contentLength: number;
  /** Hex SHA-256 of the body. Optional on the wire (§8.3) but always computed by the pipeline. */
  checksumSha256: string;
  /** `<random20>.bundle.zip`. */
  fileName: string;
}

/** DATA PLANE — unauthenticated signed PUT; mirrors iOS PUT headers (§7.5/§8.3). */
export interface BundleUploader {
  putBundle(url: string, body: Uint8Array, options: PutBundleOptions): Promise<PutResult>;
}

/** A fully-assembled, ready-to-upload bundle (output of the trigger path, §7.7). */
export interface Bundle {
  /** The /v2/issues body, also embedded verbatim in the zip. */
  request: RequestJson;
  /** The `*.bundle.zip` bytes. */
  body: Uint8Array;
  /** Bundle archive basename `<random20>.bundle.zip` (§8.3). */
  fileName: string;
}

/** Outcome accounting buckets (§7.5). */
export type OutcomeCategory = 'session' | 'issue' | 'upload' | 'performance';

/**
 * Why a capture/bundle was dropped. The design names `queue_overflow` (§7.8), `rate_limit` and
 * `duplicate` (§7.7); the pipeline records additional reasons, so this is left open.
 */
export type DropReason = string;

export interface UploadHint {
  /** Which outcome bucket this upload counts against. Defaults to 'issue'. */
  category?: OutcomeCategory;
}

/** Public upload result (§10). */
export interface UploadResult {
  ok: boolean;
  issueId?: IssueId;
  recordingId?: RecordingId;
  error?: BugseeError;
  /**
   * The failure will not succeed on a retry — the collector REFUSED this bundle (Wave 6.4).
   *
   * Distinguishes "the network was down" from "this payload is not acceptable", which the caller cannot
   * otherwise tell apart: both arrive as `{ok:false}` with a status. The durable queue uses it to delete
   * a bundle instead of retrying it at every launch forever (Android parity —
   * `CommunicationErrorClassifier.java:14-33` classifies non-401/408/425/429 4xx as PERMANENT, and
   * `ReportUploadExecutor.java:258-268` deletes the bundle file on any non-SHOULD_RETRY outcome).
   *
   * Absent on a `queue_overflow` drop: that bundle was never ATTEMPTED, so nothing is known about whether
   * the collector would take it.
   */
  permanent?: boolean;
}

/**
 * Is this upload attempt FINISHED — nothing left for any queue to carry forward?
 *
 * Delivered → nothing to keep. REFUSED (`permanent`) → keeping it means uploading it again at the next
 * launch, getting the same refusal, and repeating for the life of the installation: a self-DoS against our
 * own collector that no retention TTL fixes, because the bundle is re-staged every time. Anything else
 * (5xx, timeout, offline) is exactly what a durable queue exists to carry forward.
 *
 * ONE definition, because three separately-written copies of it drifted: the live durable pipeline treated
 * `permanent` as settled while both recovery legs gated on `ok` alone, so a 4xx-refused bundle recovered
 * from a dead instance was re-uploaded on every launch forever — bounded at 7 days on node by the instance
 * sweep, unbounded on browser/worker, which has no retention pass at all.
 *
 * Android parity: `CommunicationErrorClassifier.java:14-33` + `ReportUploadExecutor.java:258-268`.
 */
export const isUploadSettled = (result: UploadResult): boolean =>
  result.ok || result.permanent === true;

/**
 * Can a request that answered `status` still succeed if we send it again?
 *
 * THE classifier — the single place that decides `retryable`, and therefore (through `permanent` and
 * {@link isUploadSettled}) whether a crash report's blob, its report marker, its capture chunks and its
 * whole instance subtree are DELETED. It lives here, beside `isUploadSettled`, because the two are one
 * policy: this says whether the collector's answer is final, that says what to do when it is.
 *
 * Android parity, member for member, with `CommunicationErrorClassifier.classifyHttpStatus`
 * (`:14-33`) composed with `toJobResult` (`:63-74`):
 *
 * | status            | Android category | Android job result | here          |
 * |-------------------|------------------|--------------------|---------------|
 * | `401`             | `AUTH_EXPIRED`   | `SHOULD_RETRY`     | retryable     |
 * | `408`/`425`/`429` | `TRANSIENT`      | `SHOULD_RETRY`     | retryable     |
 * | any other `4xx`   | `PERMANENT`      | `FAILURE`          | NOT retryable |
 * | `5xx`, and anything else (incl. `< 400`) | `TRANSIENT` | `SHOULD_RETRY` | retryable |
 *
 * The exemptions are the whole point, and this SDK once shipped without them (`status >= 500`): a
 * single `429` from a rate-limiting edge — the one status a collector under load is MOST likely to
 * answer, and the one it answers to EVERY client at once — classified the report `permanent` and freed
 * every trace of it. Android's own comment names the same hazard for `408`: *"Without this, a
 * gateway/upstream timeout (408) on a report or bundle upload would be classified PERMANENT and the
 * report dropped."* `401` is the token expiring mid-upload, which the next launch simply re-mints.
 *
 * A sub-400 status is reached only for a non-2xx answer (a 3xx on a signed PUT): the request did not
 * complete, so like Android's fall-through it is retryable.
 */
export const isRetryableHttpStatus = (status: number): boolean =>
  status < 400 ||
  status >= 500 ||
  status === 401 ||
  status === 408 ||
  status === 425 ||
  status === 429;

/** ORCHESTRATOR — owns the promise buffer, retry/backoff, 403 renew, outcomes (§7.5/§7.8). */
export interface UploadPipeline {
  enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult>;
  flush(timeout?: number): Promise<boolean>;
  drop(reason: DropReason, category: OutcomeCategory): void;
}

// Per-platform SERVICE tokens in the internal container (design §198): core owns the `HttpTransport`
// contract; each platform registers its impl (Node's httpRequest, the browser's fetch wrapper) under
// this token and the container resolves it — without core importing any platform.
/** Service token for the platform HTTP transport primitive. */
export const TransportToken = serviceToken<HttpTransport>('transport');
/** Service token for the assembled upload orchestrator (built by the platform from transport). */
export const UploadPipelineToken = serviceToken<UploadPipeline>('uploadPipeline');
