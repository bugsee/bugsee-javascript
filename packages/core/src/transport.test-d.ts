// Type-level tests for the transport contracts, checked by `tsc --noEmit`. Example implementations
// must type-check; @ts-expect-error negatives pin required members and the PutResult discriminator.

import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { AccessToken, IssueId, RecordingId } from '@bugsee/types';
import type {
  BugseeApi,
  Bundle,
  BundleUploader,
  IssueCreateResult,
  PutResult,
  UploadResult,
} from './transport';

const issueId = 'i1' as IssueId;
const recordingId = 'r1' as RecordingId;
const token = 'tok' as AccessToken;

const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '1' },
  sdk: { version: '0.0.0', type: 'javascript' },
};
const request: RequestJson = {
  type: 'error',
  summary: 's',
  severity: 3,
  source: { type: 'uncaught' },
  created_on: 'x',
  environment: env,
};

const issueResult: IssueCreateResult = { endpoint: 'https://s3/put', issueId, recordingId };
const okPut: PutResult = { ok: true };
const failPut: PutResult = { ok: false, status: 503, retryable: true };

const api: BugseeApi = {
  ensureSession: async () => token,
  createIssue: async () => issueResult,
  renewUpload: async () => issueResult,
  invalidateSession: () => {},
};

const uploader: BundleUploader = {
  putBundle: async (_url, _body, _opts) => okPut,
};

const bundle: Bundle = { request, body: new Uint8Array([1]), fileName: 'a.bundle.zip' };
const uploadOk: UploadResult = { ok: true, issueId, recordingId };

// --- Negatives ---
// @ts-expect-error `issueId` is required on IssueCreateResult
export const badIssue: IssueCreateResult = { endpoint: 'x', recordingId };
// @ts-expect-error a failed PutResult requires `status` (retryable present, so only status is missing)
export const badPutNoStatus: PutResult = { ok: false, retryable: true };
// @ts-expect-error a failed PutResult requires `retryable` (status present, so only retryable is missing)
export const badPutNoRetryable: PutResult = { ok: false, status: 500 };
// @ts-expect-error `invalidateSession` is required on BugseeApi
export const badApi: BugseeApi = {
  ensureSession: async () => token,
  createIssue: async () => issueResult,
  renewUpload: async () => issueResult,
};

export type TransportAssertions = [
  typeof api,
  typeof uploader,
  typeof bundle,
  typeof issueResult,
  typeof okPut,
  typeof failPut,
  typeof uploadOk,
];
