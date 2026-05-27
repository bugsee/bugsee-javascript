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

const sessionOk = (token = 'tok'): HttpResponse => ({
  status: 200,
  headers: {},
  body: enc({ access_token: token }),
});
const issueOk = (): HttpResponse => ({
  status: 200,
  headers: {},
  body: enc({ endpoint: 'https://put/1', issueId: 'i1', recordingId: 'r1' }),
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
  it('posts /v2/sessions with { app_token, environment } and returns the access token', async () => {
    const { transport, calls } = recorder(() => sessionOk('tok-1'));
    const token = await api(transport).ensureSession(env);
    expect(token).toBe('tok-1');
    expect(calls[0]?.url).toBe('https://api.test/v2/sessions');
    expect(calls[0]?.options?.method).toBe('POST');
    expect(bodyJson(calls[0]?.options)).toEqual({ app_token: 'app-1', environment: env });
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
    expect(h['x-client-type']).toBe('web');
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
