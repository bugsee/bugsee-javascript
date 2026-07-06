import { setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandleError, handleError } from './handle-error';

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn(async () => ({ ok: true }) as const),
  };
}

const req = (over: Partial<{ method: string; url: string; aborted: boolean }> = {}) =>
  ({
    method: over.method ?? 'POST',
    url: over.url ?? 'https://app.test/api/users/42?token=secret',
    signal: { aborted: over.aborted ?? false },
  }) as unknown as Request;

describe('createHandleError', () => {
  afterEach(() => setCarrierClient(undefined));

  it('reports the error (http-error) and captures route attribution (method/path/params)', () => {
    const client = fakeClient();
    const bridge = createHandleError({ getClient: () => client as never });
    const err = new Error('loader boom');

    bridge(err, { request: req(), params: { id: '42' } });

    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'remix.request-error',
      expect.objectContaining({ method: 'POST', path: '/api/users/42', params: { id: '42' } }),
    );
  });

  it('drops the query string from the captured path (no secret leak)', () => {
    const client = fakeClient();
    createHandleError({ getClient: () => client as never })(new Error('x'), { request: req() });
    const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.path).toBe('/api/users/42');
  });

  it('omits the path when the request URL is unparseable (best-effort, no throw)', () => {
    const client = fakeClient();
    createHandleError({ getClient: () => client as never })(new Error('x'), {
      request: req({ url: 'not-a-valid-url' }),
    });
    const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('path' in params).toBe(false);
    expect(params.method).toBe('POST'); // still reports what it can
  });

  it('omits params when there are none', () => {
    const client = fakeClient();
    createHandleError({ getClient: () => client as never })(new Error('x'), {
      request: req(),
      params: {},
    });
    const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('params' in params).toBe(false);
  });

  it('does NOT report a cancelled request (aborted signal → noise)', () => {
    const client = fakeClient();
    createHandleError({ getClient: () => client as never })(new Error('x'), {
      request: req({ aborted: true }),
    });
    expect(client.logException).not.toHaveBeenCalled();
    expect(client.event).not.toHaveBeenCalled();
  });

  it('is a no-op when no client is active (does not throw)', () => {
    const getClient = vi.fn<() => undefined>(() => undefined);
    expect(() =>
      createHandleError({ getClient })(new Error('x'), { request: req() }),
    ).not.toThrow();
  });

  it('never throws out of the hook, even with a malformed request', () => {
    const client = fakeClient();
    const bridge = createHandleError({ getClient: () => client as never });
    expect(() => bridge(new Error('x'), { request: undefined as never })).not.toThrow();
  });

  it('defaults to the carrier client when no getClient is provided', () => {
    expect(() => handleError(new Error('x'), { request: req() })).not.toThrow();
  });
});
