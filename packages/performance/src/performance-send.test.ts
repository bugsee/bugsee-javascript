import type { BugseeApi, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createPerformanceSend } from './performance-send';
import type { TransactionWire } from './span';

const env = { platform: { type: 'web', version: '1' } } as unknown as EnvironmentEnvelope;
const ok: HttpResponse = { status: 200, headers: {}, body: new Uint8Array() };
const wire = (name: string): TransactionWire => ({ name }) as TransactionWire;

const fakeApi = (token = 'tok123') =>
  ({ ensureSession: vi.fn(async () => token) }) as unknown as BugseeApi;

describe('createPerformanceSend', () => {
  it('POSTs {transactions} to /v2/performance/transactions with the session Bearer token', async () => {
    const api = fakeApi('access-xyz');
    let call: { url: string; opts: HttpRequestOptions } | undefined;
    const transport: HttpTransport = async (url, opts = {}) => {
      call = { url, opts };
      return ok;
    };
    const send = createPerformanceSend({
      api,
      transport,
      baseUrl: 'https://api.test',
      getEnvironment: () => env,
    });

    await send([wire('a'), wire('b')]);

    expect(api.ensureSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(env);
    expect(call?.url).toBe('https://api.test/v2/performance/transactions');
    expect(call?.opts.method).toBe('POST');
    expect(call?.opts.headers?.authorization).toBe('Bearer access-xyz');
    expect(call?.opts.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(call?.opts.body as string)).toEqual({
      transactions: [{ name: 'a' }, { name: 'b' }],
    });
  });

  it('throws on a non-2xx response (so the uploader treats it as a failed batch)', async () => {
    const send = createPerformanceSend({
      api: fakeApi(),
      transport: async () => ({ status: 500, headers: {}, body: new Uint8Array() }),
      baseUrl: 'https://api.test',
      getEnvironment: () => env,
    });
    await expect(send([wire('a')])).rejects.toThrow(/performance upload failed \(500\)/);
  });

  it('resolves on any 2xx', async () => {
    const send = createPerformanceSend({
      api: fakeApi(),
      transport: async () => ({ status: 204, headers: {}, body: new Uint8Array() }),
      baseUrl: 'https://api.test',
      getEnvironment: () => env,
    });
    await expect(send([wire('a')])).resolves.toBeUndefined();
  });
});
