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

  it('sends the §8.3 PUT headers (Content-Length, checksum, fileName) and no auth/content-type', async () => {
    const { transport, calls } = fakeTransport(() => res(200));
    await createBundleUploader(transport).putBundle('https://s3/put', body, opts);
    const h = (calls[0]?.options?.headers ?? {}) as Record<string, string>;
    expect(h['Content-Length']).toBe('3');
    expect(h['x-amz-checksum-sha256']).toBe('deadbeef');
    expect(h.fileName).toBe('a.bundle.zip');
    expect(h.authorization).toBeUndefined();
    expect(h.Authorization).toBeUndefined();
    expect(h['content-type']).toBeUndefined();
    expect(h['Content-Type']).toBeUndefined();
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

  it('treats the 2xx boundary correctly (299 ok, 300 not)', async () => {
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
    expect(notOk).toEqual({ ok: false, status: 300, retryable: false });
  });

  it('maps a network error (transport rejects) to a retryable failure without throwing', async () => {
    const transport = async (): Promise<HttpResponse> => {
      throw new Error('ECONNRESET');
    };
    expect(await createBundleUploader(transport).putBundle('u', body, opts)).toEqual({
      ok: false,
      status: 0,
      retryable: true,
    });
  });
});
