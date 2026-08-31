import { describe, expect, it } from 'vitest';
import { createBundleUploader } from './bundle-uploader';
import type { HttpRequestOptions, HttpResponse, PutBundleOptions } from './transport';

const body = new Uint8Array([1, 2, 3]);
const opts: PutBundleOptions = {
  contentLength: 3,
  checksumSha256: 'deadbeef',
  fileName: 'a.bundle.zip',
};
const res = (status: number): HttpResponse => ({ status, headers: {}, body: new Uint8Array() });

function fakeTransport(responder: (url: string, options?: HttpRequestOptions) => HttpResponse) {
  const calls: Array<{ url: string; options?: HttpRequestOptions }> = [];
  const transport = async (url: string, options?: HttpRequestOptions): Promise<HttpResponse> => {
    calls.push({ url, options });
    return responder(url, options);
  };
  return { transport, calls };
}

describe('createBundleUploader', () => {
  it('PUTs the body to the signed url and returns ok on a 2xx', async () => {
    const { transport, calls } = fakeTransport(() => res(200));
    const result = await createBundleUploader(transport).putBundle('https://s3/put', body, opts);
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://s3/put');
    expect(calls[0]?.options?.method).toBe('PUT');
    expect(calls[0]?.options?.body).toBe(body);
  });

  it('sends the §8.3 PUT headers (Content-Length, fileName) and no auth/content-type', async () => {
    const { transport, calls } = fakeTransport(() => res(200));
    await createBundleUploader(transport).putBundle('https://s3/put', body, opts);
    const h = (calls[0]?.options?.headers ?? {}) as Record<string, string>;
    expect(h['Content-Length']).toBe('3');
    expect(h.fileName).toBe('a.bundle.zip');
    expect(h.authorization).toBeUndefined();
    expect(h.Authorization).toBeUndefined();
    expect(h['content-type']).toBeUndefined();
    expect(h['Content-Type']).toBeUndefined();
  });

  it('sends NO x-amz-checksum-sha256 header, which the presigned url does not authorize', async () => {
    // S3 folds every `x-amz-*` header into the string it signs. The collector mints the url without a
    // checksum (the SDK never sends `bundle_sha256` at issue-create, so there is nothing for it to
    // sign), so adding the header here made S3 compute a different string and reject EVERY bundle
    // upload with 403 SignatureDoesNotMatch — the last hop of the pipeline, after the report was
    // already accepted. Reproduced against the live collector and isolated to this single header.
    const { transport, calls } = fakeTransport(() => res(200));
    await createBundleUploader(transport).putBundle('https://s3/put', body, opts);
    const h = (calls[0]?.options?.headers ?? {}) as Record<string, string>;
    expect(h['x-amz-checksum-sha256']).toBeUndefined();
    expect(Object.keys(h).some((k) => k.toLowerCase().startsWith('x-amz-'))).toBe(false);
  });

  it('maps a 4xx to a non-retryable failure', async () => {
    const { transport } = fakeTransport(() => res(400));
    expect(await createBundleUploader(transport).putBundle('u', body, opts)).toEqual({
      ok: false,
      status: 400,
      retryable: false,
    });
  });

  it('maps a 5xx to a retryable failure', async () => {
    const { transport } = fakeTransport(() => res(503));
    expect(await createBundleUploader(transport).putBundle('u', body, opts)).toEqual({
      ok: false,
      status: 503,
      retryable: true,
    });
  });

  it('surfaces a 403 as a non-retryable failure (the pipeline handles renew)', async () => {
    const { transport } = fakeTransport(() => res(403));
    expect(await createBundleUploader(transport).putBundle('u', body, opts)).toEqual({
      ok: false,
      status: 403,
      retryable: false,
    });
  });

  it('treats the 2xx boundary correctly (299 ok, 300 not — and 300 is retryable)', async () => {
    const ok = await createBundleUploader(fakeTransport(() => res(299)).transport).putBundle(
      'u',
      body,
      opts,
    );
    const notOk = await createBundleUploader(fakeTransport(() => res(300)).transport).putBundle(
      'u',
      body,
      opts,
    );
    expect(ok).toEqual({ ok: true });
    // A 3xx means the PUT did not complete — Android classifies everything under 400 as TRANSIENT.
    expect(notOk).toEqual({ ok: false, status: 300, retryable: true });
  });

  // ── The retryable-4xx exemptions (Android CommunicationErrorClassifier.java:14-33) ──────────────
  //
  // These four statuses used to come back `retryable: false`, which the UploadPipeline turns into
  // `permanent: true`, which `isUploadSettled` turns into "free the blob, the marker, the capture
  // chunks and the whole instance subtree". One 429 from a rate-limiting edge — the single status a
  // collector under load is most likely to answer, to every client at once — DELETED the crash report.
  it.each([
    [401, 'the session/edge token expired mid-upload; the next launch mints a fresh one'],
    [408, 'a gateway or upstream timeout — the request never reached the collector'],
    [425, 'Too Early: the peer asked us to replay this later'],
    [429, 'rate limited — the definition of "try again"'],
  ])('maps %i to a RETRYABLE failure (%s)', async (status) => {
    const { transport } = fakeTransport(() => res(status));
    expect(await createBundleUploader(transport).putBundle('u', body, opts)).toEqual({
      ok: false,
      status,
      retryable: true,
    });
  });

  it.each([
    400, 402, 404, 409, 413, 422, 426, 428, 431, 451, 499,
  ])('maps %i to a non-retryable failure — the collector refused this payload', async (status) => {
    const { transport } = fakeTransport(() => res(status));
    expect(await createBundleUploader(transport).putBundle('u', body, opts)).toEqual({
      ok: false,
      status,
      retryable: false,
    });
  });

  it('maps a network error (transport rejects) to a retryable failure without throwing', async () => {
    const transport = async (): Promise<HttpResponse> => {
      throw new Error('ECONNRESET');
    };
    expect(await createBundleUploader(transport).putBundle('u', body, opts)).toMatchObject({
      ok: false,
      status: 0,
      retryable: true,
    });
  });

  it('carries the transport error through, so the failure is diagnosable', async () => {
    // Every transport failure used to arrive as the same `{ status: 0, retryable: true }`: a DNS
    // failure, a TLS failure and an aborted socket were indistinguishable to everything downstream,
    // including the user's own onError.
    const boom = new Error('ECONNRESET');
    const transport = async (): Promise<HttpResponse> => {
      throw boom;
    };
    const result = await createBundleUploader(transport).putBundle('u', body, opts);
    expect(result.ok).toBe(false);
    expect((result as { cause?: unknown }).cause).toBe(boom);
  });
});
