import {
  type BugseeApi,
  BugseeError,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { strToU8 } from '@bugsee/util';
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

  describe('a rejection that arrives with HTTP 200', () => {
    // The collector answers `/v2/*` rejections with 200 and the verdict in the envelope (see
    // bugsee-api.ts `unwrap`), so the status alone reports success for a batch that was thrown away.
    const body = (value: unknown): Uint8Array => strToU8(JSON.stringify(value));
    const sendWith = (response: HttpResponse) =>
      createPerformanceSend({
        api: fakeApi(),
        transport: async () => response,
        baseUrl: 'https://api.test',
        getEnvironment: () => env,
      });

    it('throws, carrying the collector error, instead of reporting success', async () => {
      const send = sendWith({
        status: 200,
        headers: {},
        body: body({
          ok: false,
          error: { type: 'UnsupportedSdkError', message: 'too old', code: 99098 },
        }),
      });

      const failure = await send([wire('a')]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BugseeError);
      expect((failure as BugseeError).message).toMatch(/UnsupportedSdkError: too old/);
      expect((failure as BugseeError).serverCode).toBe(99098);
    });

    it('still throws for a bare {ok:false} with no error detail', async () => {
      const send = sendWith({ status: 200, headers: {}, body: body({ ok: false }) });

      await expect(send([wire('a')])).rejects.toThrow(/rejected/);
    });

    it('treats {ok:true}, an empty body and a non-JSON body as success', async () => {
      for (const response of [
        body({ ok: true, result: {} }),
        new Uint8Array(),
        strToU8('not json at all'),
        body({ something: 'else' }),
      ]) {
        await expect(
          sendWith({ status: 200, headers: {}, body: response })([wire('a')]),
        ).resolves.toBeUndefined();
      }
    });
  });
});
