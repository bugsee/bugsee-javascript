import { describe, expect, it } from 'vitest';
import type { HttpRequestOptions, HttpResponse, HttpTransport } from './transport';
import { withTransportHeaders } from './transport-headers';

const ok: HttpResponse = { status: 200, headers: {}, body: new Uint8Array() };
const recording = (flag = false) => {
  const calls: Array<{ url: string; options: HttpRequestOptions | undefined }> = [];
  const base = async (url: string, options?: HttpRequestOptions): Promise<HttpResponse> => {
    calls.push({ url, options });
    return ok;
  };
  const transport: HttpTransport = flag
    ? Object.assign(base, { acceptsBundleBody: true as const })
    : base;
  return { transport, calls };
};

describe('withTransportHeaders', () => {
  it('adds the headers to a request and keeps the caller headers, method, body and timeout', async () => {
    const { transport, calls } = recording();
    const body = new Uint8Array([1]);
    await withTransportHeaders(transport, { 'x-bugsee-internal': '1' })('https://x', {
      method: 'PUT',
      headers: { a: 'b' },
      body,
      timeoutMs: 5,
    });
    expect(calls[0]).toEqual({
      url: 'https://x',
      options: { method: 'PUT', headers: { a: 'b', 'x-bugsee-internal': '1' }, body, timeoutMs: 5 },
    });
  });

  it('works without options', async () => {
    const { transport, calls } = recording();
    await withTransportHeaders(transport, { t: '1' })('https://x');
    expect(calls[0]?.options).toEqual({ headers: { t: '1' } });
  });

  it('the added headers win over a caller header of the same name', async () => {
    const { transport, calls } = recording();
    await withTransportHeaders(transport, { t: 'sdk' })('https://x', { headers: { t: 'caller' } });
    expect(calls[0]?.options?.headers).toEqual({ t: 'sdk' });
  });

  it('keeps acceptsBundleBody when the inner transport has it, and does not invent it otherwise', () => {
    expect(withTransportHeaders(recording(true).transport, {}).acceptsBundleBody).toBe(true);
    expect(withTransportHeaders(recording(false).transport, {}).acceptsBundleBody).toBeUndefined();
  });
});
