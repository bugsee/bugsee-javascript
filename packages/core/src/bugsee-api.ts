import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { AccessToken, IssueId, RecordingId } from '@bugsee/types';
import { randomId, strFromU8 } from '@bugsee/util';
import { BugseeError } from './errors';
import type { BugseeApi, HttpTransport, IssueCreateResult } from './transport';

// The control-plane BugseeApi (design §7.5/§8.1/§8.2) — platform-agnostic logic over an injected
// HttpTransport. Lazily creates a session (POST /v2/sessions), memoizes the access token, and
// authenticates issue creation / renewal with it. Non-2xx responses throw a BugseeError carrying the
// status as `code` — the UploadPipeline catches the throw, calls invalidateSession() and retries (so
// a stale-token 401 is re-acquired). `app_token` travels in the X-App-Token header (§8.1 v3). The
// only platform-specific piece is the transport, supplied by the platform.

export interface BugseeApiOptions {
  /** API origin, e.g. 'https://api.bugsee.com' (no trailing slash). */
  baseUrl: string;
  /** Plain-text app token. */
  appToken: string;
  /** SDK version for the user-agent header. */
  sdkVersion: string;
  /** The per-launch session-correlation id. Default a fresh `randomId()`; injectable for deterministic tests. */
  sessionId?: string;
}

const decode = (body: Uint8Array): unknown => JSON.parse(strFromU8(body));
const isOk = (status: number): boolean => status >= 200 && status < 300;

/** The collector's v2 response envelope (appserver `app.utils.js` `success()`/`error()`). */
interface V2Envelope {
  ok?: boolean;
  result?: unknown;
  error?: { type?: string; message?: string; code?: number };
}

/**
 * Unwrap a `/v2/*` response body.
 *
 * Every apiVersion>=2 response is `{ ok: true, result }` or `{ ok: false, error }` — and a REJECTION
 * arrives with **HTTP 200**, so the status code alone never reveals it. Reading the result fields off
 * the top level (as this client used to) silently produced `undefined` for a successful call and
 * silently produced "success" for a rejected one. A body without `ok` is passed through unchanged, so
 * a v1-shaped or proxied response still works.
 */
function unwrap(body: Uint8Array, what: string): unknown {
  const decoded = decode(body);
  if (typeof decoded !== 'object' || decoded === null) return decoded;
  const envelope = decoded as V2Envelope;
  if (envelope.ok === undefined) return decoded;
  if (envelope.ok === false) {
    const { type = 'CollectorError', message = 'rejected', code = 0 } = envelope.error ?? {};
    // The code goes on `serverCode`, and `code` stays 0. This rejection arrived with HTTP 200, so there
    // IS no status — and the collector's namespace overlaps HTTP statuses by accident, so putting it in
    // the status field made `upload-pipeline` read a collector code of 403 as an auth failure and kill
    // the SDK, while leaving Android's real permanent codes (14019, 11004, 99098, 99099) unclassified
    // and retried at every launch forever. See classifyServerErrorCode.
    throw new BugseeError(`${what} rejected: ${type}: ${message}`, 0, { serverCode: code });
  }
  return envelope.result;
}

export function createBugseeApi(transport: HttpTransport, options: BugseeApiOptions): BugseeApi {
  const { baseUrl, appToken, sdkVersion } = options;
  const sessionId = options.sessionId ?? randomId();
  let accessToken: AccessToken | null = null;

  // Standard SDK headers on every control-plane call (§8.2). X-Bugsee-Internal lets the network
  // capture integration skip the SDK's own traffic.
  const baseHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: '*/*',
    // The collector matches this against the APPLICATION type (appserver `utils.isValidForClient`),
    // and a JS SDK application is type `javascript` — sending `web` had every session rejected with
    // ApplicationTypeMismatchError. `javascript` also stays off the dashboard cookie-auth path, which
    // only `web`/`unknown`/absent take (`populate.middleware.js`); that risk was the reason `web` was
    // chosen, and it does not apply. Resolves design open question #1 (sdk-design.md §wire C3).
    'x-client-type': 'javascript',
    'user-agent': `BugseeJS/${sdkVersion}`,
    'x-bugsee-internal': '1',
    'x-app-token': appToken,
  });

  const postIssue = async (body: unknown): Promise<IssueCreateResult> => {
    if (accessToken === null) {
      throw new BugseeError('no active session', 0);
    }
    const response = await transport(`${baseUrl}/v2/issues`, {
      method: 'POST',
      headers: { ...baseHeaders(), authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    if (!isOk(response.status)) {
      throw new BugseeError(`issue create failed (status ${response.status})`, response.status);
    }
    // The collector answers snake_case (`issue_id`/`recording_id`); the SDK's own shape is camelCase.
    const result = unwrap(response.body, 'issue create') as {
      endpoint: string;
      issue_id: IssueId;
      recording_id: RecordingId;
    };
    return {
      endpoint: result.endpoint,
      issueId: result.issue_id,
      recordingId: result.recording_id,
    };
  };

  return {
    sessionId,
    async ensureSession(environment: EnvironmentEnvelope): Promise<AccessToken> {
      if (accessToken !== null) {
        return accessToken;
      }
      const response = await transport(`${baseUrl}/v2/sessions`, {
        method: 'POST',
        headers: baseHeaders(),
        // `session_id`: the client-minted correlation id the collector joins to traces (Profile v1 §17).
        body: JSON.stringify({ app_token: appToken, environment, session_id: sessionId }),
      });
      if (!isOk(response.status)) {
        throw new BugseeError(`session create failed (status ${response.status})`, response.status);
      }
      const token = (unwrap(response.body, 'session create') as { access_token?: string } | null)
        ?.access_token;
      if (typeof token !== 'string') {
        // Never cache a non-token: a cached `undefined` is not `null`, so every later upload would go
        // out as `Bearer undefined` and the session would never be re-requested.
        throw new BugseeError('session create returned no access token', 0);
      }
      accessToken = token as AccessToken;
      return accessToken;
    },

    createIssue(req: RequestJson): Promise<IssueCreateResult> {
      return postIssue(req);
    },

    renewUpload(
      req: RequestJson,
      issueId: IssueId,
      recordingId: RecordingId,
    ): Promise<IssueCreateResult> {
      return postIssue({ ...req, uploadDataRenew: { issueId, recordingId } });
    },

    invalidateSession(): void {
      accessToken = null;
    },
  };
}
