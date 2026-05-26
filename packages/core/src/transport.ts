import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { AccessToken, IssueId, RecordingId } from '@bugsee/types';
import type { BugseeError } from './errors';

// Transport split into three roles (design §7.5). The control/data-plane implementations are
// platform-tier (fetch / node http); core owns only these contracts and the UploadPipeline
// orchestrator (upload-pipeline.ts). Type-only; validated by transport.test-d.ts.

/** Result of POST /v2/issues — the signed PUT url + identifiers (§7.5/§8.1). */
export interface IssueCreateResult {
  /** Signed S3 PUT url. */
  endpoint: string;
  issueId: IssueId;
  recordingId: RecordingId;
}

/** Result of the signed-URL PUT (§7.5). */
export type PutResult = { ok: true } | { ok: false; status: number; retryable: boolean };

/** CONTROL PLANE — authenticated; orchestrates session + issue lifecycle (§7.5). */
export interface BugseeApi {
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
}

/** ORCHESTRATOR — owns the promise buffer, retry/backoff, 403 renew, outcomes (§7.5/§7.8). */
export interface UploadPipeline {
  enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult>;
  flush(timeout?: number): Promise<boolean>;
  drop(reason: DropReason, category: OutcomeCategory): void;
}
