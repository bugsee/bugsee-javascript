import type { BugseeApi, IssueCreateResult } from '@bugsee/core';
import { BugseeError } from '@bugsee/core';
import { type HttpResponse, httpRequest } from '@bugsee/node-utils';
import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { AccessToken, IssueId, RecordingId } from '@bugsee/types';

// The control-plane BugseeApi for Node (design §7.5/§8.1/§8.2), implemented over node-utils
// httpRequest. Lazily creates a session (POST /v2/sessions), memoizes the access token, and
// authenticates issue creation / renewal with it. Non-2xx responses throw a BugseeError carrying the
// status as `code` — the core UploadPipeline catches the throw, calls invalidateSession() and retries
// (so a stale-token 401 is re-acquired). `app_token` travels in the X-App-Token header (§8.1 v3).

export interface BugseeApiOptions {
  /** API origin, e.g. 'https://api.bugsee.com' (no trailing slash). */
  baseUrl: string;
  /** Plain-text app token. */
  appToken: string;
  /** SDK version for the user-agent header. */
  sdkVersion: string;
  /** HTTP transport; injectable for tests. Default node-utils httpRequest. */
  request?: typeof httpRequest;
}

const decode = (response: HttpResponse): unknown =>
  JSON.parse(Buffer.from(response.body).toString('utf8'));
const isOk = (status: number): boolean => status >= 200 && status < 300;

export function createBugseeApi(options: BugseeApiOptions): BugseeApi {
  const { baseUrl, appToken, sdkVersion } = options;
  const request = options.request ?? httpRequest;
  let accessToken: AccessToken | null = null;

  // Standard SDK headers on every control-plane call (§8.2). X-Bugsee-Internal lets the network
  // capture integration skip the SDK's own traffic.
  const baseHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: '*/*',
    'x-client-type': 'web',
    'user-agent': `BugseeJS/${sdkVersion}`,
    'x-bugsee-internal': '1',
    'x-app-token': appToken,
  });

  const postIssue = async (body: unknown): Promise<IssueCreateResult> => {
    if (accessToken === null) {
      throw new BugseeError('no active session', 0);
    }
    const response = await request(`${baseUrl}/v2/issues`, {
      method: 'POST',
      headers: { ...baseHeaders(), authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    if (!isOk(response.status)) {
      throw new BugseeError(`issue create failed (status ${response.status})`, response.status);
    }
    return decode(response) as IssueCreateResult;
  };

  return {
    async ensureSession(environment: EnvironmentEnvelope): Promise<AccessToken> {
      if (accessToken !== null) {
        return accessToken;
      }
      const response = await request(`${baseUrl}/v2/sessions`, {
        method: 'POST',
        headers: baseHeaders(),
        body: JSON.stringify({ app_token: appToken, environment }),
      });
      if (!isOk(response.status)) {
        throw new BugseeError(`session create failed (status ${response.status})`, response.status);
      }
      accessToken = (decode(response) as { access_token: string }).access_token as AccessToken;
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
