import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { IssueId, RecordingId } from '@bugsee/types';
import { strToU8 } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import { createBugseeApi } from './bugsee-api';
import type { HttpRequestOptions, HttpResponse } from './transport';

const env: EnvironmentEnvelope = {
  platform: { type: 'node', version: '24' },
  runtime: { type: 'node', version: '' },
  sdk: { version: '1.0.0', type: 'javascript' },
};
const requestJson: RequestJson = {
  type: 'error',
  summary: 's',
  severity: 3,
  source: { type: 'crash', mechanism: 'uncaught' },
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

  it('sends the standard SDK request headers', async () => {
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

  it('omits the user-agent header when the platform cannot send one (browser CORS)', async () => {
    // A browser sends `user-agent` itself, and a script-set one makes the request non-simple: the preflight
    // then has to allow the header, and the collector's CORS allow-list does not name it (Firefox fails the
    // preflight). The browser tiers opt out; every server-side tier keeps the SDK identification.
    const { transport, calls } = recorder(() => sessionOk());
    await api(transport, { sdkVersion: '2.3.4', sendUserAgent: false }).ensureSession(env);
    const h = headersOf(calls[0]?.options);

    expect('user-agent' in h).toBe(false);
    expect(h['x-app-token']).toBe('app-1'); // everything else is still sent
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
    // …and a real HTTP failure still puts the STATUS on `code`, with no collector code at all.
    await expect(a.createIssue(requestJson)).rejects.toMatchObject({
      code: 401,
      serverCode: undefined,
    });
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
    // The code lands on `serverCode`, NOT on `code`. `code` is where an HTTP status lives, and this
    // rejection arrived with HTTP 200 — there is no status to put there. Carrying the collector's code
    // in the status field is how 11004 was retried forever while a collector code that happened to read
    // `403` was mistaken for an auth status and permanently disabled the SDK.
    await expect(api(transport).ensureSession(env)).rejects.toMatchObject({
      code: 0,
      serverCode: 11004,
      message: expect.stringContaining('ApplicationTypeMismatchError'),
    });
  });

  it.each([
    401, 403, 500,
  ])('keeps a collector code of %i OFF the HTTP-status field, so it can never be read as one', async (code) => {
    const { transport } = recorder(() => rejected('SomeCollectorError', 'no', code));
    const error: unknown = await api(transport)
      .ensureSession(env)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ serverCode: code, code: 0 });
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
    await expect(a.createIssue(requestJson)).rejects.toMatchObject({ code: 0, serverCode: 12003 });
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
      serverCode: 0,
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

describe('createBugseeApi — a NON-2xx that also carries a collector code', () => {
  // THE GAP THIS CLOSES. `unwrap` reads the collector's own `error.code` only out of a 2xx body,
  // because a v2 rejection normally arrives with HTTP 200. But the collector does NOT always answer
  // 200: a 4xx can carry the same `{ ok: false, error: { code } }` envelope, and the SDK threw on the
  // status BEFORE reading it. So `14019 InvalidAppToken` delivered with a 400 produced a BugseeError
  // with no `serverCode`, `finalControlPlaneFailure` returned null, and the bundle was retried at every
  // launch for the life of the installation — while the byte-identical body on a 200 was classified
  // permanent and freed.
  //
  // Android reads the body on BOTH endpoints' failure paths and lets the collector's code win over the
  // status (`ReportUploadExecutor.java:468-484` for /v2/issues, `CommunicationRequests.obtainSession`
  // for /v2/sessions, where a non-2xx with `errorCode != 0` becomes `createFailure(errorCode)`).
  //
  // What does NOT change: the STATUS never becomes a verdict. `code` still carries it, `serverCode`
  // carries the collector's code, and a status alone still means retry.

  /** A non-2xx that carries the collector's envelope anyway. */
  const failedWithCode = (status: number, code: number, type = 'InvalidAppTokenError') => ({
    status,
    headers: {},
    body: enc({ ok: false, error: { type, message: type, code } }),
  });

  it.each([
    400, 403, 404, 422, 500,
  ])('reads the collector code out of a %i on /v2/issues, with the status still on `code`', async (status) => {
    const { transport } = recorder((url) =>
      url.endsWith('/v2/sessions') ? sessionOk() : failedWithCode(status, 14019),
    );
    const a = api(transport);
    await a.ensureSession(env);
    await expect(a.createIssue(requestJson)).rejects.toMatchObject({
      code: status, // the STATUS namespace — unchanged
      serverCode: 14019, // …and the COLLECTOR namespace, which used to be thrown away
    });
  });

  it.each([
    400, 403, 404, 422, 500,
  ])('reads the collector code out of a %i on /v2/sessions too', async (status) => {
    const { transport } = recorder(() => failedWithCode(status, 99099, 'KillSdkError'));
    await expect(api(transport).ensureSession(env)).rejects.toMatchObject({
      code: status,
      serverCode: 99099,
    });
  });

  it('carries the code through renewUpload as well', async () => {
    const { transport } = recorder((url) =>
      url.endsWith('/v2/sessions') ? sessionOk() : failedWithCode(400, 11004),
    );
    const a = api(transport);
    await a.ensureSession(env);
    await expect(
      a.renewUpload(requestJson, 'i1' as IssueId, 'r1' as RecordingId),
    ).rejects.toMatchObject({ code: 400, serverCode: 11004 });
  });

  // ── Everything below is the SAFE direction: no code found ⇒ no `serverCode` ⇒ the status alone is
  //    not a verdict, and the failure stays retryable. Each of these is a body an intermediary can
  //    produce, and none of them is the collector speaking.

  it('reports NO collector code when a non-2xx body is not JSON at all (an nginx error page)', async () => {
    const { transport } = recorder(() => ({
      status: 502,
      headers: {},
      body: strToU8('<html><body>502 Bad Gateway</body></html>'),
    }));
    await expect(api(transport).ensureSession(env)).rejects.toMatchObject({
      code: 502,
      serverCode: undefined,
    });
  });

  it.each([
    ['an empty object', {}],
    ['an error with no code', { ok: false, error: { type: 'Whatever' } }],
    ['a JSON scalar', 'nope'],
    ['null', null],
    ['a JSON array', [1, 2]],
    ['a non-numeric code', { ok: false, error: { code: 'oops' } }],
    ['a nested error that is a scalar', { ok: false, error: 7 }],
  ])('reports NO collector code for %s', async (_label, body) => {
    const { transport } = recorder(() => ({ status: 400, headers: {}, body: enc(body) }));
    await expect(api(transport).ensureSession(env)).rejects.toMatchObject({
      code: 400,
      serverCode: undefined,
    });
  });

  it("treats the collector's `code: 0` as ABSENT, exactly as Android does", async () => {
    // `optInt("code", 0)` cannot tell "absent" from "zero", so Android's failure paths both guard on
    // `errorCode != 0`. Mirroring that keeps 0 out of the classifier, where it would land on the
    // `transient` default anyway — but only by luck, and luck is not the property to rely on when the
    // answer decides whether a crash report is deleted.
    const { transport } = recorder(() => failedWithCode(400, 0, 'CollectorError'));
    await expect(api(transport).ensureSession(env)).rejects.toMatchObject({
      code: 400,
      serverCode: undefined,
    });
  });

  it('still throws, and still names the status, when a code IS found', async () => {
    const { transport } = recorder(() => failedWithCode(400, 14019));
    await expect(api(transport).ensureSession(env)).rejects.toThrow(/session create failed.*400/);
  });

  it('never caches a session from a non-2xx, whatever the body says', async () => {
    const { transport, calls } = recorder(() => failedWithCode(400, 14019));
    const a = api(transport);
    await expect(a.ensureSession(env)).rejects.toThrow();
    await expect(a.ensureSession(env)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});

describe('createBugseeApi — notify', () => {
  const item = { id: 'n1', timestamp: 5, title: 'Deploy done' };
  const ok = (notifications?: Record<string, string>): HttpResponse =>
    enveloped(notifications === undefined ? {} : { notifications });

  it('POSTs the batch to /v2/notifications with the app token in the body, and no session', async () => {
    const { transport, calls } = recorder(() => ok({ n1: 'accepted' }));
    const second = { id: 'n2', timestamp: 6, title: 't' };
    const result = await api(transport).notify([item, second]);
    expect(result).toEqual({ outcome: 'sent' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/v2/notifications');
    expect(calls[0]?.options?.method).toBe('POST');
    expect(bodyJson(calls[0]?.options)).toEqual({
      app_token: 'app-1',
      notifications: [item, second],
    });
    const headers = headersOf(calls[0]?.options);
    expect(headers['x-app-token']).toBe('app-1');
    expect(headers['x-client-type']).toBe('javascript');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBeUndefined();
  });

  it('treats a missing status map as every item sent', async () => {
    const { transport } = recorder(() => ok());
    expect(await api(transport).notify([item])).toEqual({ outcome: 'sent' });
  });

  it('reads a status map that is not wrapped in the v2 envelope', async () => {
    const { transport } = recorder(() => ({
      status: 200,
      headers: {},
      body: enc({ notifications: { n1: 'failed' } }),
    }));
    expect(await api(transport).notify([item])).toEqual({ outcome: 'retry', retryIds: ['n1'] });
  });

  it('asks to retry only the items the collector marked failed', async () => {
    const { transport } = recorder(() =>
      ok({ a: 'accepted', b: 'failed', c: 'skipped', d: 'invalid' }),
    );
    const batch = ['a', 'b', 'c', 'd'].map((id) => ({ id, timestamp: 1, title: id }));
    expect(await api(transport).notify(batch)).toEqual({ outcome: 'retry', retryIds: ['b'] });
  });

  it('settles an item the map does not mention', async () => {
    const { transport } = recorder(() => ok({ other: 'failed' }));
    expect(await api(transport).notify([item])).toEqual({ outcome: 'sent' });
  });

  it('ignores a malformed status map and a non-object body', async () => {
    for (const body of [enc({ ok: true, result: { notifications: 'x' } }), enc(null), enc('s')]) {
      const { transport } = recorder(() => ({ status: 200, headers: {}, body }));
      expect(await api(transport).notify([item])).toEqual({ outcome: 'sent' });
    }
  });

  it('drops the batch when the collector rejects it inside a 200 envelope', async () => {
    const { transport } = recorder(() => rejected('InvalidAppToken', 'bad', 401));
    expect(await api(transport).notify([item])).toEqual({ outcome: 'rejected' });
  });

  it('retries on 408, 429 and every 5xx without a status map', async () => {
    for (const status of [408, 429, 500, 503]) {
      const { transport } = recorder(() => ({ status, headers: {}, body: enc({}) }));
      expect(await api(transport).notify([item])).toEqual(
        status === 429 ? { outcome: 'retry', rateLimited: true } : { outcome: 'retry' },
      );
    }
  });

  it('on a 5xx settles the items the collector named as not failed', async () => {
    const { transport } = recorder(() => ({
      status: 500,
      headers: {},
      body: enc({ ok: false, notifications: { n1: 'accepted', n2: 'failed' } }),
    }));
    const batch = ['n1', 'n2'].map((id) => ({ id, timestamp: 1, title: id }));
    expect(await api(transport).notify(batch)).toEqual({ outcome: 'retry', retryIds: ['n2'] });
  });

  it('honours the 429 QuotaExceeded retryAfter (seconds, in the body) as the wait', async () => {
    const { transport } = recorder(() => ({
      status: 429,
      headers: {},
      body: enc({ ok: false, error: 'QuotaExceeded', retryAfter: 45 }),
    }));
    expect(await api(transport).notify([item])).toEqual({
      outcome: 'retry',
      retryAfterMs: 45_000,
      rateLimited: true,
    });
  });

  it('falls back to a numeric Retry-After header, and ignores nonsense', async () => {
    const header = recorder(() => ({
      status: 429,
      headers: { 'retry-after': '7' },
      body: enc({}),
    }));
    expect(await api(header.transport).notify([item])).toEqual({
      outcome: 'retry',
      retryAfterMs: 7000,
      rateLimited: true,
    });
    for (const bad of [{ retryAfter: -1 }, { retryAfter: 'soon' }, { retryAfter: Number.NaN }]) {
      const { transport } = recorder(() => ({ status: 429, headers: {}, body: enc(bad) }));
      expect(await api(transport).notify([item])).toEqual({
        outcome: 'retry',
        rateLimited: true,
      });
    }
    for (const header of ['1e3', '1.5', '-5', '']) {
      const odd = recorder(() => ({
        status: 429,
        headers: { 'retry-after': header },
        body: enc({}),
      }));
      expect(await api(odd.transport).notify([item])).toEqual({
        outcome: 'retry',
        rateLimited: true,
      });
    }
    const date = recorder(() => ({
      status: 429,
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      body: enc({}),
    }));
    expect(await api(date.transport).notify([item])).toEqual({
      outcome: 'retry',
      rateLimited: true,
    });
  });

  it('a 429 whose body is not JSON still retries (no wait hint)', async () => {
    const { transport } = recorder(() => ({ status: 429, headers: {}, body: strToU8('<html>') }));
    expect(await api(transport).notify([item])).toEqual({ outcome: 'retry', rateLimited: true });
  });

  it('treats a 403 KillSdk from the relay as a kill, but not an anonymous 403', async () => {
    const { transport } = recorder(() => ({
      status: 403,
      headers: {},
      body: enc({ ok: false, error: 'KillSdk', message: 'SDK has been disabled by the server' }),
    }));
    expect(await api(transport).notify([item])).toEqual({ outcome: 'kill' });
    const proxy = recorder(() => ({ status: 403, headers: {}, body: strToU8('<html>forbidden') }));
    expect(await api(proxy.transport).notify([item])).toEqual({ outcome: 'rejected' });
  });

  it('drops the batch on any other 4xx', async () => {
    for (const status of [400, 401, 403, 404, 499]) {
      const { transport } = recorder(() => ({ status, headers: {}, body: enc({}) }));
      expect(await api(transport).notify([item])).toEqual({ outcome: 'rejected' });
    }
  });

  it('retries when the transport throws or a 200 body is not JSON', async () => {
    const throwing = async (): Promise<HttpResponse> => {
      throw new Error('offline');
    };
    expect(await api(throwing).notify([item])).toEqual({ outcome: 'retry' });
    const { transport } = recorder(() => ({ status: 200, headers: {}, body: strToU8('<html>') }));
    expect(await api(transport).notify([item])).toEqual({ outcome: 'retry' });
  });

  it('retries on a non-success status below 400', async () => {
    const { transport } = recorder(() => ({ status: 302, headers: {}, body: enc({}) }));
    expect(await api(transport).notify([item])).toEqual({ outcome: 'retry' });
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
