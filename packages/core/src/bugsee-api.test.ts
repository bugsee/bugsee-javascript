import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { IssueId, RecordingId } from '@bugsee/types';
import { strToU8 } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import { createBugseeApi } from './bugsee-api';
import type { HttpRequestOptions, HttpResponse } from './transport';

const env: EnvironmentEnvelope = {
  platform: { type: 'node', version: '24' },
  sdk: { version: '1.0.0', type: 'javascript' },
};
const requestJson: RequestJson = {
  type: 'error',
  summary: 's',
  severity: 3,
  source: { mechanism: 'uncaught' },
  created_on: 'x',
  environment: env,
};

const enc = (json: unknown): Uint8Array => strToU8(JSON.stringify(json));
const headersOf = (opts?: HttpRequestOptions): Record<string, string> =>
  (opts?.headers ?? {}) as Record<string, string>;
const bodyJson = (opts?: HttpRequestOptions): unknown => JSON.parse(opts?.body as string);

// A transport recorder: routes /v2/sessions vs /v2/issues to canned responses, capturing every call.
function recorder(responder: (url: string, opts?: HttpRequestOptions) => HttpResponse) {
  const calls: Array<{ url: string; options?: HttpRequestOptions }> = [];
  const transport = async (url: string, options?: HttpRequestOptions): Promise<HttpResponse> => {
    calls.push({ url, options });
    return responder(url, options);
  };
  return { transport, calls };
}

// The collector's REAL v2 wire shape, verified against apidev.bugsee.com and against the appserver
// source (`app.utils.js` success()/error(): every apiVersion>=2 response is enveloped, and the result
// fields are snake_case). The SDK previously assumed a flat body with camelCase ids, and the e2e mock
// collector was written from that same assumption, so nothing could catch the mismatch.
const enveloped = (result: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: enc({ ok: true, result }),
});
/** A REJECTION: the collector answers HTTP 200 and puts the failure in the envelope. */
const rejected = (type: string, message: string, code: number): HttpResponse => ({
  status: 200,
  headers: {},
  body: enc({ ok: false, error: { type, message, code } }),
});
const sessionOk = (token = 'tok'): HttpResponse => enveloped({ access_token: token });
const issueOk = (): HttpResponse =>
  enveloped({
    _id: 'i1',
    issue_id: 'i1',
    recording_id: 'r1',
    endpoint: 'https://put/1',
  });
const route =
  (token = 'tok') =>
  (url: string): HttpResponse =>
    url.endsWith('/v2/sessions') ? sessionOk(token) : issueOk();

const api = (
  transport: ReturnType<typeof recorder>['transport'],
  over: Record<string, unknown> = {},
) =>
  createBugseeApi(transport, {
    baseUrl: 'https://api.test',
    appToken: 'app-1',
    sdkVersion: '1.0.0',
    ...over,
  });

describe('createBugseeApi — ensureSession', () => {
  it('posts /v2/sessions with { app_token, environment, session_id } and returns the access token', async () => {
    const { transport, calls } = recorder(() => sessionOk('tok-1'));
    const token = await api(transport, { sessionId: 'sess-abc' }).ensureSession(env);
    expect(token).toBe('tok-1');
    expect(calls[0]?.url).toBe('https://api.test/v2/sessions');
    expect(calls[0]?.options?.method).toBe('POST');
    expect(bodyJson(calls[0]?.options)).toEqual({
      app_token: 'app-1',
      environment: env,
      session_id: 'sess-abc', // the client-minted correlation id, sent for collector-side trace join
    });
  });

  it('exposes the injected session-correlation id and sends THAT exact id', async () => {
    const { transport, calls } = recorder(() => sessionOk());
    const a = api(transport, { sessionId: 'sess-xyz' });
    expect(a.sessionId).toBe('sess-xyz'); // dual-purpose: also read by the decorator + the OTLP resource
    await a.ensureSession(env);
    expect((bodyJson(calls[0]?.options) as { session_id: string }).session_id).toBe('sess-xyz');
  });

  it('mints a fresh 32-hex session id by default (per launch), stable for the api lifetime', async () => {
    const a = api(recorder(() => sessionOk()).transport);
    const b = api(recorder(() => sessionOk()).transport);
    expect(a.sessionId).toMatch(/^[0-9a-f]{32}$/); // randomId()
    expect(a.sessionId).not.toBe(b.sessionId); // distinct per api/launch
    expect(a.sessionId).toBe(a.sessionId); // stable
  });

  it('memoizes the session (a second call issues no new request)', async () => {
    const { transport, calls } = recorder(() => sessionOk());
    const a = api(transport);
    await a.ensureSession(env);
    await a.ensureSession(env);
    expect(calls).toHaveLength(1);
  });

  it('sends the standard SDK request headers (§8.2)', async () => {
    const { transport, calls } = recorder(() => sessionOk());
    await api(transport, { sdkVersion: '2.3.4' }).ensureSession(env);
    const h = headersOf(calls[0]?.options);
    expect(h['content-type']).toBe('application/json');
    expect(h.accept).toBe('*/*');
    // `javascript`, not `web`: the collector matches x-client-type against the APPLICATION type
    // (appserver `utils.isValidForClient`), and a JS SDK app is type `javascript`. Sending `web`
    // made the collector reject every session with ApplicationTypeMismatchError. `javascript` also
    // stays off the dashboard cookie-auth path, which only `web`/`unknown`/absent take
    // (`populate.middleware.js`) — the concern that produced the original `web` decision.
    expect(h['x-client-type']).toBe('javascript');
    expect(h['user-agent']).toBe('BugseeJS/2.3.4');
    expect(h['x-app-token']).toBe('app-1');
    expect(h['x-bugsee-internal']).toBe('1');
  });

  it('throws when session creation returns a non-2xx status', async () => {
    const { transport } = recorder(() => ({ status: 500, headers: {}, body: enc({}) }));
    await expect(api(transport).ensureSession(env)).rejects.toThrow(/session/);
  });
});

describe('createBugseeApi — createIssue', () => {
  it('posts /v2/issues with bearer auth + request.json and returns the signed url + ids', async () => {
    const { transport, calls } = recorder(route('tok-9'));
    const a = api(transport);
    await a.ensureSession(env);
    const result = await a.createIssue(requestJson);
    expect(result).toEqual({ endpoint: 'https://put/1', issueId: 'i1', recordingId: 'r1' });
    const issue = calls.find((c) => c.url.endsWith('/v2/issues'));
    expect(issue?.url).toBe('https://api.test/v2/issues');
    expect(issue?.options?.method).toBe('POST');
    expect(headersOf(issue?.options).authorization).toBe('Bearer tok-9');
    expect(bodyJson(issue?.options)).toEqual(requestJson);
  });

  it('throws with the HTTP status as the error code on failure', async () => {
    const { transport } = recorder((url) =>
      url.endsWith('/v2/sessions') ? sessionOk() : { status: 401, headers: {}, body: enc({}) },
    );
    const a = api(transport);
    await a.ensureSession(env);
    await expect(a.createIssue(requestJson)).rejects.toMatchObject({ code: 401 });
  });

  it('throws when there is no active session', async () => {
    const { transport } = recorder(() => issueOk());
    await expect(api(transport).createIssue(requestJson)).rejects.toThrow(/no active session/);
  });
});

describe('createBugseeApi — renewUpload', () => {
  it('posts request.json with an uploadDataRenew overlay', async () => {
    const { transport, calls } = recorder(route());
    const a = api(transport);
    await a.ensureSession(env);
    await a.renewUpload(requestJson, 'i1' as IssueId, 'r1' as RecordingId);
    const issue = calls.find((c) => c.url.endsWith('/v2/issues'));
    expect(bodyJson(issue?.options)).toEqual({
      ...requestJson,
      uploadDataRenew: { issueId: 'i1', recordingId: 'r1' },
    });
  });
});

describe('createBugseeApi — the v2 response envelope', () => {
  it('reads the access token out of the { ok, result } envelope', async () => {
    const { transport } = recorder(() => enveloped({ access_token: 'tok-enveloped' }));
    await expect(api(transport).ensureSession(env)).resolves.toBe('tok-enveloped');
  });

  it('throws on a rejection that arrives with HTTP 200, carrying the collector code', async () => {
    // The failure mode this guards: the collector answers 200 with { ok: false }, so a status-only
    // check treats a REJECTED session as successful, caches `undefined` as the access token, and
    // every later upload goes out as `Bearer undefined` — silent, permanent data loss.
    const { transport } = recorder(() =>
      rejected('ApplicationTypeMismatchError', 'Application type does not match', 11004),
    );
    await expect(api(transport).ensureSession(env)).rejects.toMatchObject({
      code: 11004,
      message: expect.stringContaining('ApplicationTypeMismatchError'),
    });
  });

  it('does not cache a session when the envelope carries no access token', async () => {
    const { transport, calls } = recorder(() => enveloped({}));
    const a = api(transport);
    await expect(a.ensureSession(env)).rejects.toThrow(/access token/);
    await expect(a.ensureSession(env)).rejects.toThrow(/access token/);
    expect(calls).toHaveLength(2); // re-requested, rather than serving a cached `undefined`
  });

  it("maps the collector's snake_case issue ids onto the SDK shape", async () => {
    const { transport } = recorder((url) =>
      url.endsWith('/v2/sessions')
        ? sessionOk()
        : enveloped({
            _id: 'abc',
            issue_id: 'abc',
            recording_id: 'def',
            endpoint: 'https://s3/put',
          }),
    );
    const a = api(transport);
    await a.ensureSession(env);
    await expect(a.createIssue(requestJson)).resolves.toEqual({
      endpoint: 'https://s3/put',
      issueId: 'abc',
      recordingId: 'def',
    });
  });

  it('throws when issue creation is rejected inside a 200 envelope', async () => {
    const { transport } = recorder((url) =>
      url.endsWith('/v2/sessions')
        ? sessionOk()
        : rejected('TooManySimilarCrashesError', 'no', 12003),
    );
    const a = api(transport);
    await a.ensureSession(env);
    await expect(a.createIssue(requestJson)).rejects.toMatchObject({ code: 12003 });
  });

  it('passes a non-object body straight through rather than reading `ok` off it', async () => {
    // A proxy or an error page can answer 200 with a JSON scalar. Reading `.ok` off it must not turn
    // that into a "successful" session with an undefined token.
    const { transport } = recorder(() => ({ status: 200, headers: {}, body: enc(null) }));
    await expect(api(transport).ensureSession(env)).rejects.toThrow(/access token/);
  });

  it('reports a rejection that carries no error detail', async () => {
    const { transport } = recorder(() => ({ status: 200, headers: {}, body: enc({ ok: false }) }));
    await expect(api(transport).ensureSession(env)).rejects.toMatchObject({
      code: 0,
      message: expect.stringContaining('CollectorError'),
    });
  });

  it('accepts an un-enveloped body, so a v1-shaped or proxied response still works', async () => {
    const { transport } = recorder(() => ({
      status: 200,
      headers: {},
      body: enc({ access_token: 'flat' }),
    }));
    await expect(api(transport).ensureSession(env)).resolves.toBe('flat');
  });
});

describe('createBugseeApi — invalidateSession', () => {
  it('forces the next ensureSession to re-authenticate', async () => {
    const { transport, calls } = recorder(() => sessionOk());
    const a = api(transport);
    await a.ensureSession(env);
    a.invalidateSession();
    await a.ensureSession(env);
    expect(calls.filter((c) => c.url.endsWith('/v2/sessions'))).toHaveLength(2);
  });
});
