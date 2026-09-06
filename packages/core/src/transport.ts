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
  /**
   * The bundle's bytes are DURABLY STAGED by the queue that answered, and will be carried to the next
   * launch — so the caller's own copy of the incident is redundant and may be released (Round 6, R5-1).
   *
   * Set only by {@link DurableUploadPipeline}, and only on a result that has NOT settled: a delivered or
   * refused bundle has just had its durable copy freed, so claiming it were retained would be a lie.
   *
   * Why the SDK needs this at all: `client.ts` retires an incident's REPORT MARKER when its report
   * settles, and the marker is the only trace of an incident whose bundle never reached durable storage
   * — it is also what keeps that incident's capture generation alive against the recovery sweep. The
   * justification for retiring it was "the durable bundle queue owns delivery from here", but the queue
   * deliberately CATCHES a throwing `BundleStore.put` (ENOSPC / EROFS / EACCES / EDQUOT, a `RangeError`
   * out of `serializeBundle`, any integrator-supplied store) and continues, so the upload still goes out
   * with nothing staged behind it. A retryable failure then erased the blob, the marker AND the
   * recording of a crash that had already happened. This is how the caller tells the two apart.
   *
   * Absent ⇒ assume nothing is staged. A queue that does not stage anything never sets it.
   */
  retained?: boolean;
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
 * sweep, and on browser/worker not bounded at all. That second half is now closed separately, by the age
 * bound `recoverSiblingBundleQueue` applies from `DEFAULT_DURABLE_RETENTION`: a verdict settles a bundle,
 * and a bound gives up on one, and the two must stay different things. Widening what counts as a verdict
 * to make up for a missing bound is what produced a new loss path in three consecutive review rounds.
 *
 * Android parity: `CommunicationErrorClassifier.java:14-33` + `ReportUploadExecutor.java:258-268`.
 */
export const isUploadSettled = (result: UploadResult): boolean =>
  result.ok || result.permanent === true;

/**
 * Can a request that answered `status` still succeed if we send it again?
 *
 * The classifier for an HTTP STATUS, and therefore (through `permanent` and {@link isUploadSettled}) one
 * of the inputs that decides whether a crash report's blob, its report marker, its capture chunks and its
 * whole instance subtree are DELETED. It lives here, beside `isUploadSettled`, because the two are one
 * policy: this says whether the collector's answer is final, that says what to do when it is.
 *
 * It is NOT the only such input, and saying so here was wrong (R5-9): the DATA plane's verdict comes from
 * here via `bundle-uploader.ts`, while the CONTROL plane's comes from {@link classifyServerErrorCode} via
 * `upload-pipeline.ts` — a separate namespace carried in a `/v2/*` envelope on an HTTP 200, which no
 * status function can see.
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

/**
 * What the COLLECTOR's own error code means. A namespace disjoint from HTTP statuses.
 *
 * `transient`    — try again; the condition is on the collector's side, not in the payload.
 * `permanent`    — this payload will never be accepted. Keeping it means re-uploading it at every
 *                  launch for the life of the installation.
 * `auth_expired` — the SESSION is stale, not the payload: mint a new one and retry.
 * `kill_sdk`     — stop. The app token itself has been switched off.
 */
export type ServerErrorCategory = 'transient' | 'permanent' | 'auth_expired' | 'kill_sdk';

/**
 * Classify a `/v2/*` envelope's `error.code` — the collector's OWN code, NOT an HTTP status.
 *
 * The two are separate numeric namespaces that overlap by accident, and conflating them is a defect in
 * both directions. A v2 rejection arrives with **HTTP 200** and the code inside the body
 * (`bugsee-api.ts`), so the status says nothing; meanwhile a collector code that happens to read `401`
 * or `403` means nothing about authentication. Reading one as the other both retried Android's
 * permanent codes forever AND disabled the whole SDK on a transient rejection.
 *
 * Android parity, member for member, with `CommunicationErrorClassifier.classifyServerErrorCode`
 * (`:35-58`). The `default` arm is deliberately TRANSIENT: an unrecognised code must never be a reason
 * to delete a crash report, so a code this SDK has not learned about yet costs a retry, not an incident.
 *
 * `kill_sdk` is the ONLY verdict that may disable the SDK. Android blacklists an app token here and
 * nowhere else (`BugseeCommunicationManager.java:776-781`) — never on an HTTP status, which is exactly
 * what this SDK used to do.
 *
 * The table is a DATA structure rather than a switch so it can be enumerated, and
 * `collector-error-codes.drift.test.ts` parses Android's `CommunicationErrorClassifier.java` and fails
 * if the two disagree in either direction. That test exists because this transcription had a reader it
 * could not be checked against: the invariants harness hand-copied the SAME Java table as its expected
 * answers, so a mistake made in both places was invisible to 350 cases — and classifying `99013`
 * (ServerTooBusy) as permanent would delete crash reports exactly when the collector is shedding load.
 */
export const SERVER_ERROR_CATEGORIES: Readonly<Record<number, ServerErrorCategory>> = {
  11004: 'permanent', // ApplicationTypeMismatch
  12003: 'permanent', // SimilarCrashExists
  12004: 'permanent', // TooManySimilarCrashes
  14002: 'auth_expired', // SessionNotFound
  14019: 'permanent', // InvalidAppToken
  99002: 'permanent', // EmptyBody
  99003: 'permanent', // MissingParameter
  99013: 'transient', // ServerTooBusy
  99098: 'permanent', // UnsupportedSdk
  99099: 'kill_sdk', // KillSdk
};

export const classifyServerErrorCode = (code: number): ServerErrorCategory =>
  SERVER_ERROR_CATEGORIES[code] ?? 'transient';

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
