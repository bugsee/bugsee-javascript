import type { EnvironmentEnvelope, RequestJson } from '@bugsee/protocol';
import type { AccessToken, IssueId, RecordingId } from '@bugsee/types';
import { createDeferred } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BugseeError } from './errors';
import type { BugseeApi, Bundle, BundleUploader, IssueCreateResult, PutResult } from './transport';
import {
  createUploadPipeline,
  type PipelineOutcome,
  type UploadPipelineOptions,
} from './upload-pipeline';

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
const bundle: Bundle = { request, body: new Uint8Array([1, 2, 3]), fileName: 'a.bundle.zip' };
const issue: IssueCreateResult = {
  endpoint: 'https://put/1',
  issueId: 'i1' as IssueId,
  recordingId: 'r1' as RecordingId,
};

function fakeApi(over: Partial<BugseeApi> = {}): BugseeApi {
  return {
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
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
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

describe('createUploadPipeline — backpressure & buffer', () => {
  it('drops the latest bundle when the buffer is full (queue_overflow)', async () => {
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
    const second = await pipeline.enqueue(bundle); // buffer full -> dropped
    expect(second.ok).toBe(false);
    expect(outcomes).toContainEqual({ kind: 'drop', category: 'issue', reason: 'queue_overflow' });
    gate.resolve({ ok: true });
    expect((await first).ok).toBe(true);
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
