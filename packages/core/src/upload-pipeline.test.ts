import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { AccessToken, IssueId, RecordingId } from '@bugsee/types';
import { createDeferred, strToU8 } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBugseeApi } from './bugsee-api';
import { BugseeError } from './errors';
import type { BugseeApi, Bundle, BundleUploader, IssueCreateResult, PutResult } from './transport';
import {
  createUploadPipeline,
  type PipelineOutcome,
  QUEUE_OVERFLOW_CODE,
  type UploadPipelineOptions,
} from './upload-pipeline';

const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '0.0.0', type: 'javascript' },
};
const request: RequestJson = {
  type: 'error',
  summary: 's',
  severity: 3,
  source: { type: 'crash', mechanism: 'uncaught' },
  created_on: 'x',
  environment: env,
};
const bundle: Bundle = { request, body: new Uint8Array([1, 2, 3]), fileName: 'a.bundle.zip' };
const issue: IssueCreateResult = {
  endpoint: 'https://put/1',
  issueId: 'i1' as IssueId,
  recordingId: 'r1' as RecordingId,
};

function fakeApi(over: Partial<BugseeApi> = {}): BugseeApi {
  return {
    sessionId: 'sess',
    ensureSession: vi.fn(async () => 'tok' as AccessToken),
    createIssue: vi.fn(async () => issue),
    renewUpload: vi.fn(async () => ({ ...issue, endpoint: 'https://put/2' })),
    invalidateSession: vi.fn(),
    ...over,
  };
}
function fakeUploader(put: BundleUploader['putBundle']): BundleUploader {
  return { putBundle: put };
}

// Fast, deterministic deps; individual tests omit one to exercise the corresponding default.
function deps(over: Partial<UploadPipelineOptions>): UploadPipelineOptions {
  return {
    api: fakeApi(),
    uploader: fakeUploader(vi.fn(async () => ({ ok: true }) as PutResult)),
    sha256: async () => 'deadbeef',
    sleep: async () => {},
    computeDelay: () => 0,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createUploadPipeline — happy path', () => {
  it('runs ensureSession → createIssue → putBundle and returns the ids', async () => {
    const api = fakeApi();
    const result = await createUploadPipeline(deps({ api })).enqueue(bundle);
    expect(result).toEqual({ ok: true, issueId: issue.issueId, recordingId: issue.recordingId });
    expect(api.ensureSession).toHaveBeenCalledWith(env);
    expect(api.createIssue).toHaveBeenCalledWith(request);
  });

  it('puts to the signed endpoint with content length, checksum and file name', async () => {
    const put = vi.fn(async () => ({ ok: true }) as PutResult);
    await createUploadPipeline(deps({ uploader: fakeUploader(put) })).enqueue(bundle);
    expect(put).toHaveBeenCalledWith('https://put/1', bundle.body, {
      contentLength: 3,
      checksumSha256: 'deadbeef',
      fileName: 'a.bundle.zip',
    });
  });

  it('reports a success outcome under the hinted category', async () => {
    const outcomes: PipelineOutcome[] = [];
    await createUploadPipeline(deps({ onOutcome: (o) => outcomes.push(o) })).enqueue(bundle, {
      category: 'performance',
    });
    expect(outcomes).toEqual([{ kind: 'success', category: 'performance' }]);
  });

  it('defaults the outcome category to "issue"', async () => {
    const outcomes: PipelineOutcome[] = [];
    await createUploadPipeline(deps({ onOutcome: (o) => outcomes.push(o) })).enqueue(bundle);
    expect(outcomes).toEqual([{ kind: 'success', category: 'issue' }]);
  });

  it('uses the real SHA-256 of the body when no sha256 is injected', async () => {
    const put = vi.fn<BundleUploader['putBundle']>(async () => ({ ok: true }));
    const { sha256: _omit, ...rest } = deps({ uploader: fakeUploader(put) });
    await createUploadPipeline(rest).enqueue(bundle);
    const checksum = (put.mock.calls[0]?.[2] as { checksumSha256: string }).checksumSha256;
    // sha256([1,2,3]) — pinned by value: the default digest must be a correct SHA-256, not just 64 hex chars.
    expect(checksum).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  });
});

// The default digest is WebCrypto-only (@bugsee/util has no node:crypto fallback any more). On a runtime
// without `crypto.subtle` — an insecure browser context, or Node 18 whose platform did not inject a digest —
// the checksum REJECTS. That must surface as a RETRYABLE failure: `permanent` would tell the durable queue
// to free the bundle, losing the incident, when the cause is the runtime rather than the payload.
describe('createUploadPipeline — default digest on a runtime without WebCrypto', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails the upload as retryable, before any PUT, carrying the NotSupportedError as cause', async () => {
    vi.stubGlobal('crypto', undefined);
    const put = vi.fn<BundleUploader['putBundle']>(async () => ({ ok: true }));
    const outcomes: PipelineOutcome[] = [];
    const { sha256: _omit, ...rest } = deps({
      uploader: fakeUploader(put),
      onOutcome: (o) => outcomes.push(o),
    });
    const result = await createUploadPipeline(rest).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(result.permanent).toBeUndefined();
    expect(result.error).toBeInstanceOf(BugseeError);
    expect(result.error?.message).toBe('checksum failed');
    expect((result.error?.cause as Error).name).toBe('NotSupportedError');
    expect(put).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ kind: 'drop', category: 'issue', reason: 'upload_failed' }]);
  });

  it('uploads normally when the platform injects a digest in its place', async () => {
    vi.stubGlobal('crypto', undefined);
    const put = vi.fn<BundleUploader['putBundle']>(async () => ({ ok: true }));
    const result = await createUploadPipeline(
      deps({ uploader: fakeUploader(put), sha256: async () => 'injected' }),
    ).enqueue(bundle);
    expect(result.ok).toBe(true);
    expect((put.mock.calls[0]?.[2] as { checksumSha256: string }).checksumSha256).toBe('injected');
  });
});

describe('createUploadPipeline — 403 renew', () => {
  it('renews the signed url on 403 and retries the PUT against the new endpoint', async () => {
    const api = fakeApi();
    const put = vi
      .fn<BundleUploader['putBundle']>()
      .mockResolvedValueOnce({ ok: false, status: 403, retryable: false })
      .mockResolvedValueOnce({ ok: true });
    const result = await createUploadPipeline(deps({ api, uploader: fakeUploader(put) })).enqueue(
      bundle,
    );
    expect(result.ok).toBe(true);
    expect(api.renewUpload).toHaveBeenCalledWith(request, issue.issueId, issue.recordingId);
    expect(put.mock.calls[1]?.[0]).toBe('https://put/2');
  });

  it('fails if renewUpload rejects', async () => {
    const api = fakeApi({ renewUpload: vi.fn(async () => Promise.reject(new Error('nope'))) });
    const put = vi.fn(async () => ({ ok: false, status: 403, retryable: false }) as PutResult);
    const result = await createUploadPipeline(deps({ api, uploader: fakeUploader(put) })).enqueue(
      bundle,
    );
    expect(result.ok).toBe(false);
  });

  it('preserves a BugseeError thrown by renewUpload', async () => {
    const boom = new BugseeError('renew bad', 403);
    const api = fakeApi({ renewUpload: vi.fn(async () => Promise.reject(boom)) });
    const put = vi.fn(async () => ({ ok: false, status: 403, retryable: false }) as PutResult);
    const result = await createUploadPipeline(deps({ api, uploader: fakeUploader(put) })).enqueue(
      bundle,
    );
    expect(result.error).toBe(boom);
  });

  it('renews only once: a second 403 after renewing gives up with renew_failed (§14.8)', async () => {
    const api = fakeApi();
    const outcomes: PipelineOutcome[] = [];
    const put = vi.fn(async () => ({ ok: false, status: 403, retryable: false }) as PutResult);
    const result = await createUploadPipeline(
      deps({ api, uploader: fakeUploader(put), onOutcome: (o) => outcomes.push(o) }),
    ).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(403);
    expect(api.renewUpload).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2); // initial + one post-renew retry
    expect(outcomes).toContainEqual({ kind: 'drop', category: 'issue', reason: 'renew_failed' });
  });

  it('reports the renew_failed reason when renewUpload itself rejects', async () => {
    const outcomes: PipelineOutcome[] = [];
    const api = fakeApi({ renewUpload: vi.fn(async () => Promise.reject(new Error('nope'))) });
    const put = vi.fn(async () => ({ ok: false, status: 403, retryable: false }) as PutResult);
    await createUploadPipeline(
      deps({ api, uploader: fakeUploader(put), onOutcome: (o) => outcomes.push(o) }),
    ).enqueue(bundle);
    expect(outcomes).toContainEqual({ kind: 'drop', category: 'issue', reason: 'renew_failed' });
  });
});

describe('createUploadPipeline — retries', () => {
  it('retries a retryable PUT failure with backoff, then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const put = vi
      .fn<BundleUploader['putBundle']>()
      .mockResolvedValueOnce({ ok: false, status: 503, retryable: true })
      .mockResolvedValueOnce({ ok: true });
    const result = await createUploadPipeline(
      deps({ uploader: fakeUploader(put), sleep, computeDelay: (n) => n * 100 }),
    ).enqueue(bundle);
    expect(result.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('gives up after maxRetries retryable PUT failures', async () => {
    const put = vi.fn(async () => ({ ok: false, status: 503, retryable: true }) as PutResult);
    const result = await createUploadPipeline(
      deps({ uploader: fakeUploader(put), maxRetries: 2 }),
    ).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(503);
    expect(put).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  // WAVE 6.4 — `permanent` is what lets the DURABLE queue tell a refusal from an outage. Getting it wrong
  // in either direction is a data-loss bug: too eager and the SDK deletes the reports collected while the
  // network was down (the case the durable queue exists for); too lax and a refused bundle is re-uploaded
  // at every launch forever. Android draws the same line — CommunicationErrorClassifier.java:14-33 treats
  // every non-401/408/425/429 4xx as PERMANENT and 5xx as TRANSIENT.
  it('marks a NON-RETRYABLE status permanent', async () => {
    const put = vi.fn(async () => ({ ok: false, status: 400, retryable: false }) as PutResult);
    const result = await createUploadPipeline(deps({ uploader: fakeUploader(put) })).enqueue(
      bundle,
    );
    expect(result.permanent).toBe(true);
  });

  it('does NOT mark an exhausted retry budget permanent — those bundles must survive to the next launch', async () => {
    const put = vi.fn(async () => ({ ok: false, status: 503, retryable: true }) as PutResult);
    const result = await createUploadPipeline(
      deps({ uploader: fakeUploader(put), maxRetries: 2 }),
    ).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(result.permanent).toBeFalsy();
  });

  it('does NOT mark a queue_overflow refusal permanent — that bundle was never attempted', async () => {
    const put = vi.fn(async () => new Promise<PutResult>(() => {})); // hangs, filling the buffer
    const pipeline = createUploadPipeline(
      deps({ uploader: fakeUploader(put), bufferSize: 1, maxWaiting: 0 }),
    );
    void pipeline.enqueue(bundle);
    const overflow = await pipeline.enqueue(bundle);
    expect(overflow.ok).toBe(false);
    expect(overflow.permanent).toBeFalsy(); // the durable copy must survive for the next launch
  });

  it('does not retry a non-retryable PUT failure', async () => {
    const put = vi.fn(async () => ({ ok: false, status: 400, retryable: false }) as PutResult);
    const result = await createUploadPipeline(deps({ uploader: fakeUploader(put) })).enqueue(
      bundle,
    );
    expect(result.ok).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('invalidates the session and retries when an api call rejects, then succeeds', async () => {
    const ensureSession = vi
      .fn<BugseeApi['ensureSession']>()
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValue('tok' as AccessToken);
    const api = fakeApi({ ensureSession });
    const result = await createUploadPipeline(deps({ api })).enqueue(bundle);
    expect(result.ok).toBe(true);
    expect(api.invalidateSession).toHaveBeenCalledTimes(1);
    expect(ensureSession).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries api rejections, invalidating each time', async () => {
    const api = fakeApi({ createIssue: vi.fn(async () => Promise.reject(new Error('5xx'))) });
    const result = await createUploadPipeline(deps({ api, maxRetries: 2 })).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(api.invalidateSession).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('preserves a BugseeError thrown by an api call', async () => {
    const boom = new BugseeError('bad', 418);
    const api = fakeApi({ createIssue: vi.fn(async () => Promise.reject(boom)) });
    const result = await createUploadPipeline(deps({ api, maxRetries: 0 })).enqueue(bundle);
    expect(result.error).toBe(boom);
    expect(result.error?.code).toBe(418);
  });

  // ── The control plane's TWO numeric namespaces ─────────────────────────────────────────────────
  //
  // An HTTP STATUS and the collector's OWN error code are different things that happen to be numbers.
  // This pipeline used to treat a 401 or a 403 out of `ensureSession` as "the app token is invalid",
  // which entered the client's kill state: capture and detection stopped, `launch()` a permanent no-op.
  // Two things were wrong with that.
  //
  //   1. `transport.ts` asserts, as the Android parity target, that 401 is RETRYABLE — and Android
  //      agrees: `BugseeCommunicationManager.java:614-635` treats it as session expiry and retries once.
  //      The app-token blacklist fires ONLY on the server error code KILL_SDK (`:776-781`), never on an
  //      HTTP status. So one bad minute at an edge proxy disabled the SDK until the process restarted.
  //   2. A `/v2/*` rejection arrives with HTTP **200** and its code in the BODY, and that code was being
  //      carried in the same field as a status — so a collector code that happened to read 403 was
  //      mistaken for an auth failure, and Android's real permanent codes (14019 InvalidAppToken, 11004
  //      ApplicationTypeMismatch, 99098 UnsupportedSdk, 99099 KILL_SDK) matched nothing and were retried
  //      at every launch for the life of the installation.
  //
  // The control plane is now classified by the COLLECTOR CODE alone (`classifyServerErrorCode`), and an
  // HTTP status on it is retried — which is the fail-safe direction and Android's own behaviour for the
  // session obtain (`sessionObtainFailureResponse`, `:770-792`).

  const sessionRejecting = (error: unknown) =>
    fakeApi({ ensureSession: vi.fn<BugseeApi['ensureSession']>().mockRejectedValue(error) });
  const collectorError = (serverCode: number) => new BugseeError('rejected', 0, { serverCode });

  it.each([
    401, 403,
  ])('RETRIES an HTTP %i from ensureSession instead of disabling the SDK', async (status) => {
    const api = sessionRejecting(new BugseeError('nope', status));
    const result = await createUploadPipeline(deps({ api, maxRetries: 3 })).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(result.error?.fatal).toBe(false); // NOT the kill state
    expect(result.permanent).toBeUndefined(); // …and the bundle is kept for the next launch
    expect(api.ensureSession).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(api.invalidateSession).toHaveBeenCalled();
  });

  it.each([
    401, 403, 500,
  ])('RETRIES collector code %i — a collector code is not an HTTP status', async (serverCode) => {
    const api = sessionRejecting(collectorError(serverCode));
    const result = await createUploadPipeline(deps({ api, maxRetries: 2 })).enqueue(bundle);
    expect(result.error?.fatal).toBe(false);
    expect(result.permanent).toBeUndefined();
    expect(api.ensureSession).toHaveBeenCalledTimes(3);
  });

  it.each([
    [14019, 'InvalidAppToken'],
    [11004, 'ApplicationTypeMismatch'],
    [99098, 'UnsupportedSdk'],
    [12003, 'SimilarCrashExists'],
  ])('drops the bundle PERMANENTLY on collector code %i (%s), without disabling the SDK', async (serverCode) => {
    const api = sessionRejecting(collectorError(serverCode));
    const result = await createUploadPipeline(deps({ api, maxRetries: 3 })).enqueue(bundle);
    expect(result.permanent).toBe(true); // the durable queue frees it instead of retrying forever
    expect(result.error?.fatal).toBe(false); // …but the SDK keeps running
    expect(api.ensureSession).toHaveBeenCalledTimes(1); // no retry — it can never be accepted
  });

  it('enters the kill state ONLY on KILL_SDK (99099), and drops the bundle with it', async () => {
    const api = sessionRejecting(collectorError(99099));
    const result = await createUploadPipeline(deps({ api, maxRetries: 3 })).enqueue(bundle);
    expect(result.error?.fatal).toBe(true);
    expect(result.permanent).toBe(true);
    expect(api.ensureSession).toHaveBeenCalledTimes(1);
  });

  it('re-mints the session on SessionNotFound (14002) and succeeds on the retry', async () => {
    const ensureSession = vi
      .fn<BugseeApi['ensureSession']>()
      .mockRejectedValueOnce(collectorError(14002))
      .mockResolvedValue('tok' as AccessToken);
    const api = fakeApi({ ensureSession });
    const result = await createUploadPipeline(deps({ api })).enqueue(bundle);
    expect(result.ok).toBe(true);
    expect(api.invalidateSession).toHaveBeenCalledTimes(1);
  });

  it('retries ServerTooBusy (99013) rather than dropping the bundle', async () => {
    const api = sessionRejecting(collectorError(99013));
    const result = await createUploadPipeline(deps({ api, maxRetries: 2 })).enqueue(bundle);
    expect(result.permanent).toBeUndefined();
    expect(api.ensureSession).toHaveBeenCalledTimes(3);
  });

  it('reads ONLY `serverCode` as a collector verdict — a number in `code` is a STATUS', async () => {
    // `code` is where the HTTP status lives. Pointing the collector classifier at it would conflate the
    // two namespaces again, just in the opposite direction from the original defect: a transport status
    // would start deleting reports because it happened to match a collector code. Nothing but
    // `serverCode` is a verdict about the payload.
    const api = sessionRejecting(new BugseeError('nope', 14019)); // 14019 in the STATUS field
    const result = await createUploadPipeline(deps({ api, maxRetries: 2 })).enqueue(bundle);
    expect(result.permanent).toBeUndefined();
    expect(result.error?.fatal).toBe(false);
    expect(api.ensureSession).toHaveBeenCalledTimes(3); // retried, not dropped
  });

  it('retries an UNKNOWN collector code — a code we do not recognise must not delete a report', async () => {
    const api = sessionRejecting(collectorError(123_456));
    const result = await createUploadPipeline(deps({ api, maxRetries: 1 })).enqueue(bundle);
    expect(result.permanent).toBeUndefined();
    expect(api.ensureSession).toHaveBeenCalledTimes(2);
  });

  it('classifies a permanent collector code from createIssue too, not just from ensureSession', async () => {
    const createIssue = vi.fn<BugseeApi['createIssue']>().mockRejectedValue(collectorError(11004));
    const api = fakeApi({ createIssue });
    const result = await createUploadPipeline(deps({ api, maxRetries: 3 })).enqueue(bundle);
    expect(result.permanent).toBe(true);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('treats a 401 from createIssue (stale access token) as recoverable, not fatal', async () => {
    const createIssue = vi
      .fn<BugseeApi['createIssue']>()
      .mockRejectedValueOnce(new BugseeError('stale', 401))
      .mockResolvedValue(issue);
    const api = fakeApi({ createIssue });
    const result = await createUploadPipeline(deps({ api })).enqueue(bundle);
    expect(result.ok).toBe(true); // retried + recovered
    expect(api.invalidateSession).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it('does not treat a non-auth session failure (e.g. 500) as fatal', async () => {
    const ensureSession = vi
      .fn<BugseeApi['ensureSession']>()
      .mockRejectedValue(new BugseeError('server', 500));
    const api = fakeApi({ ensureSession });
    const result = await createUploadPipeline(deps({ api, maxRetries: 1 })).enqueue(bundle);
    expect(result.error?.fatal).toBe(false);
    expect(ensureSession).toHaveBeenCalledTimes(2); // retried (initial + 1)
  });

  it('uses computeBackoff by default when no computeDelay is injected', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const put = vi
      .fn<BundleUploader['putBundle']>()
      .mockResolvedValueOnce({ ok: false, status: 503, retryable: true })
      .mockResolvedValueOnce({ ok: true });
    const { computeDelay: _omit, ...rest } = deps({ uploader: fakeUploader(put), sleep });
    await createUploadPipeline(rest).enqueue(bundle);
    expect(sleep).toHaveBeenCalledTimes(1);
    const delay = sleep.mock.calls[0]?.[0] as number;
    expect(typeof delay).toBe('number');
    expect(delay).toBeGreaterThan(0);
  });

  it('uses a real setTimeout delay when no sleep is injected', async () => {
    vi.useFakeTimers();
    const put = vi
      .fn<BundleUploader['putBundle']>()
      .mockResolvedValueOnce({ ok: false, status: 503, retryable: true })
      .mockResolvedValueOnce({ ok: true });
    const { sleep: _omit, ...rest } = deps({ uploader: fakeUploader(put), computeDelay: () => 50 });
    const promise = createUploadPipeline(rest).enqueue(bundle);
    await vi.advanceTimersByTimeAsync(50);
    expect((await promise).ok).toBe(true);
  });
});

describe('createUploadPipeline — failure outcomes', () => {
  it('reports a drop outcome with reason "upload_failed" on failure', async () => {
    const outcomes: PipelineOutcome[] = [];
    const put = vi.fn(async () => ({ ok: false, status: 400, retryable: false }) as PutResult);
    await createUploadPipeline(
      deps({ uploader: fakeUploader(put), onOutcome: (o) => outcomes.push(o) }),
    ).enqueue(bundle);
    expect(outcomes).toEqual([{ kind: 'drop', category: 'issue', reason: 'upload_failed' }]);
  });
});

describe('createUploadPipeline — operation rejections (enqueue never rejects)', () => {
  it('resolves to a failed result and records a drop when putBundle rejects', async () => {
    const outcomes: PipelineOutcome[] = [];
    const put = vi.fn<BundleUploader['putBundle']>(async () => {
      throw new Error('socket hang up');
    });
    const result = await createUploadPipeline(
      deps({ uploader: fakeUploader(put), onOutcome: (o) => outcomes.push(o) }),
    ).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(outcomes).toContainEqual({ kind: 'drop', category: 'issue', reason: 'upload_failed' });
  });

  it('preserves a BugseeError thrown by putBundle', async () => {
    const boom = new BugseeError('put threw', 0);
    const put = vi.fn<BundleUploader['putBundle']>(async () => {
      throw boom;
    });
    const result = await createUploadPipeline(deps({ uploader: fakeUploader(put) })).enqueue(
      bundle,
    );
    expect(result.error).toBe(boom);
  });

  it('resolves to a failed result and records a drop when sha256 rejects', async () => {
    const outcomes: PipelineOutcome[] = [];
    const result = await createUploadPipeline(
      deps({
        sha256: async () => {
          throw new Error('no crypto');
        },
        onOutcome: (o) => outcomes.push(o),
      }),
    ).enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(outcomes).toContainEqual({ kind: 'drop', category: 'issue', reason: 'upload_failed' });
  });

  it('preserves a BugseeError thrown by sha256', async () => {
    const boom = new BugseeError('checksum boom', 0);
    const result = await createUploadPipeline(
      deps({
        sha256: async () => {
          throw boom;
        },
      }),
    ).enqueue(bundle);
    expect(result.error).toBe(boom);
  });
});

describe('createUploadPipeline — backpressure & buffer', () => {
  it('makes a bundle WAIT for a slot rather than refusing it', async () => {
    // `bufferSize` is a CONCURRENCY limit, not an admission limit. Refusing the overflow meant a burst
    // of incidents past it was answered "queue overflow" and never retried in-process — a server
    // failing fifty requests at once uploaded a handful and left the rest for the next restart.
    const gate = createDeferred<PutResult>();
    const outcomes: PipelineOutcome[] = [];
    const pipeline = createUploadPipeline(
      deps({
        uploader: fakeUploader(() => gate.promise),
        bufferSize: 1,
        onOutcome: (o) => outcomes.push(o),
      }),
    );
    const first = pipeline.enqueue(bundle); // occupies the single slot (pending)
    const second = pipeline.enqueue(bundle); // waits for it, rather than being dropped
    await Promise.resolve();
    expect(outcomes).not.toContainEqual({
      kind: 'drop',
      category: 'issue',
      reason: 'queue_overflow',
    });
    gate.resolve({ ok: true });
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true); // uploaded once the slot freed
  });

  it('refuses only past the hard waiting cap, so memory stays bounded', async () => {
    const gate = createDeferred<PutResult>();
    const outcomes: PipelineOutcome[] = [];
    const pipeline = createUploadPipeline(
      deps({
        uploader: fakeUploader(() => gate.promise),
        bufferSize: 1,
        maxWaiting: 2,
        onOutcome: (o) => outcomes.push(o),
      }),
    );
    void pipeline.enqueue(bundle); // the slot
    void pipeline.enqueue(bundle); // waiting 1
    void pipeline.enqueue(bundle); // waiting 2
    const refused = await pipeline.enqueue(bundle); // past the cap
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe(QUEUE_OVERFLOW_CODE);
    expect(outcomes).toContainEqual({ kind: 'drop', category: 'issue', reason: 'queue_overflow' });
    gate.resolve({ ok: true });
  });

  it('uploads an entire burst as slots free, in order', async () => {
    const uploaded: string[] = [];
    const pipeline = createUploadPipeline(
      deps({
        uploader: {
          putBundle: async (_url, _body, o) => {
            uploaded.push(o.fileName);
            return { ok: true };
          },
        },
        bufferSize: 2,
      }),
    );
    const names = Array.from({ length: 25 }, (_, i) => `b${i}.bundle.zip`);
    const results = await Promise.all(
      names.map((n) => pipeline.enqueue({ ...bundle, fileName: n })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(uploaded.sort()).toEqual(names.sort());
  });

  it('frees a slot once an operation settles', async () => {
    const put = vi.fn(async () => ({ ok: true }) as PutResult);
    const pipeline = createUploadPipeline(deps({ uploader: fakeUploader(put), bufferSize: 1 }));
    await pipeline.enqueue(bundle);
    const second = await pipeline.enqueue(bundle); // slot freed after the first settled
    expect(second.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('createUploadPipeline — drop & flush', () => {
  it('drop() reports a drop outcome with the given reason and category', () => {
    const outcomes: PipelineOutcome[] = [];
    createUploadPipeline(deps({ onOutcome: (o) => outcomes.push(o) })).drop('rate_limit', 'issue');
    expect(outcomes).toEqual([{ kind: 'drop', category: 'issue', reason: 'rate_limit' }]);
  });

  it('flush resolves true immediately when nothing is in flight', async () => {
    expect(await createUploadPipeline(deps({})).flush(1000)).toBe(true);
  });

  it('flush waits for in-flight operations to drain', async () => {
    const gate = createDeferred<PutResult>();
    const pipeline = createUploadPipeline(deps({ uploader: fakeUploader(() => gate.promise) }));
    const op = pipeline.enqueue(bundle);
    let flushed = false;
    const flushing = pipeline.flush().then((r) => {
      flushed = r;
    });
    expect(flushed).toBe(false);
    gate.resolve({ ok: true });
    await op;
    await flushing;
    expect(flushed).toBe(true);
  });

  it('flush returns false when in-flight work does not drain before the timeout', async () => {
    const gate = createDeferred<PutResult>();
    // flush's timeout uses the injected sleep (immediate here), so the timeout wins the race.
    const pipeline = createUploadPipeline(deps({ uploader: fakeUploader(() => gate.promise) }));
    pipeline.enqueue(bundle);
    expect(await pipeline.flush(10)).toBe(false);
    gate.resolve({ ok: true });
  });
});

describe('createUploadPipeline — diagnosability', () => {
  it("surfaces the transport's error as the failure's cause", async () => {
    // Without it, `onError` and `UploadResult.error` say only "bundle upload failed (status 0)" for
    // every network-level failure there is.
    const boom = new Error('ECONNRESET');
    const pipeline = createUploadPipeline(
      deps({
        uploader: fakeUploader(
          vi.fn(async () => ({ ok: false, status: 0, retryable: true, cause: boom }) as PutResult),
        ),
        maxRetries: 0,
      }),
    );
    const result = await pipeline.enqueue(bundle);
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toBe(boom);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// INTEGRATION — the REAL BugseeApi over a fake transport, so the whole control-plane verdict path runs
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Every test above injects a `BugseeApi` double that throws a ready-made `BugseeError`, so the step that
// actually DECIDES the verdict — reading the collector's `error.code` off the wire — was never covered
// end to end. That is precisely where the gap lived: `bugsee-api.ts` threw on a non-2xx status before
// looking at the body, so a `14019 InvalidAppToken` delivered with an HTTP 400 reached this pipeline with
// no `serverCode`, was classified transient, and was re-uploaded at every launch for the life of the
// installation — while the byte-identical body on an HTTP 200 was classified permanent and freed.
describe('createUploadPipeline + createBugseeApi — the control plane end to end', () => {
  const enc = (json: unknown): Uint8Array => strToU8(JSON.stringify(json));
  const sessionOk = {
    status: 200,
    headers: {},
    body: enc({ ok: true, result: { access_token: 't' } }),
  };

  /**
   * Wire the REAL api to a transport that answers `on` with `status` + `body`, and count the calls.
   * The signed PUT always succeeds, so anything that fails here failed on the control plane.
   */
  const wired = (on: '/v2/sessions' | '/v2/issues', status: number, body: unknown) => {
    const calls = { session: 0, issue: 0 };
    const transport = async (url: string) => {
      const which = url.endsWith('/v2/sessions') ? 'session' : 'issue';
      calls[which] += 1;
      if (url.endsWith(on)) {
        return { status, headers: {}, body: enc(body) };
      }
      return which === 'session'
        ? sessionOk
        : {
            status: 200,
            headers: {},
            body: enc({
              ok: true,
              result: { endpoint: 'https://put/1', issue_id: 'i1', recording_id: 'r1' },
            }),
          };
    };
    const api = createBugseeApi(transport, {
      baseUrl: 'https://api.test',
      appToken: 'tok',
      sdkVersion: '0',
    });
    return { api, calls };
  };
  const envelope = (code: number, type: string) => ({
    ok: false,
    error: { type, message: type, code },
  });
  const run = (api: BugseeApi) =>
    createUploadPipeline(deps({ api, maxRetries: 2 })).enqueue(bundle);

  it.each([
    ['/v2/issues' as const, 400],
    ['/v2/issues' as const, 404],
    ['/v2/sessions' as const, 400],
    ['/v2/sessions' as const, 403],
  ])('drops the bundle on a permanent collector code carried by a %s HTTP %i', async (on, status) => {
    const { api, calls } = wired(on, status, envelope(14019, 'InvalidAppTokenError'));
    const result = await run(api);
    expect(result.permanent).toBe(true); // the durable queue frees it — no more launch-forever loop
    expect(result.error?.serverCode).toBe(14019);
    expect(result.error?.code).toBe(status); // the status is still reported, just not as the verdict
    expect(result.error?.fatal).toBe(false); // a bad token drops a payload; it does not stop the SDK
    expect(calls[on === '/v2/sessions' ? 'session' : 'issue']).toBe(1); // not retried
  });

  it('switches the SDK off when KILL_SDK (99099) arrives WITH a status, not only inside a 200', async () => {
    const { api } = wired('/v2/sessions', 400, envelope(99099, 'KillSdkError'));
    const result = await run(api);
    expect(result.error?.fatal).toBe(true);
    expect(result.permanent).toBe(true);
  });

  it.each([
    [503, 99013, 'ServerTooBusy — the collector is shedding load, not refusing the payload'],
    [400, 14002, 'SessionNotFound — the session is stale, the payload is fine'],
    [400, 123_456, 'a code this SDK has never heard of'],
  ])('KEEPS the bundle for a %i carrying %i (%s)', async (status, code) => {
    const { api, calls } = wired('/v2/sessions', status, envelope(code, 'X'));
    const result = await run(api);
    expect(result.permanent).toBeUndefined();
    expect(calls.session).toBe(3); // initial + 2 retries, then kept for the next launch
  });

  // ── THE DECISION, pinned. ────────────────────────────────────────────────────────────────────────
  //
  // Android's issue-create path DOES fall back to the HTTP status when the body carries no code, and
  // `classifyHttpStatus` calls any non-401/408/425/429 4xx PERMANENT — which would delete the report.
  // This SDK deliberately does NOT follow it there, and this test is the fence:
  //
  //   • Android's OWN session path disagrees with its issue path about the identical status: an
  //     `/v2/sessions` non-2xx with no body code becomes `UNKNOWN_ERROR` → `classifyServerErrorCode(0)`
  //     → TRANSIENT → retry (`CommunicationRequests.obtainSession`). Two adjacent calls to the same
  //     collector cannot both be right, which is the tell that the STATUS is not the verdict — the
  //     collector's code is.
  //   • A bare 4xx on the control plane is the answer an intermediary gives: a captive portal, a
  //     corporate MITM proxy, a WAF, a stale CDN route, a service worker. None of them read the payload.
  //   • Widening a deletion path on a status is what produced a NEW data-loss path in each of three
  //     consecutive review rounds here (R3-1: `status >= 500` deleted every 401/408/425/429).
  //
  // The cost of NOT classifying was "retried forever". That cost is now paid for separately, by BOUNDS
  // rather than by verdicts: node sweeps dead subtrees at 7 days, the durable queue's own retention caps
  // at 32 bundles / 64 MiB / 7 days, and `recoverSiblingBundleQueue` now applies that same age bound on
  // browser and worker, which is where "forever" was literally true.
  it.each([
    ['/v2/issues' as const, 400],
    ['/v2/issues' as const, 403],
    ['/v2/issues' as const, 404],
    ['/v2/issues' as const, 422],
    ['/v2/sessions' as const, 400],
    ['/v2/sessions' as const, 404],
  ])('KEEPS the bundle for a NAKED %s HTTP %i — a status is never a verdict here', async (on, status) => {
    const { api } = wired(on, status, { message: 'Bad Request' });
    const result = await run(api);
    expect(result.permanent).toBeUndefined();
    expect(result.error?.fatal).toBe(false);
    expect(result.error?.serverCode).toBeUndefined();
  });
});
