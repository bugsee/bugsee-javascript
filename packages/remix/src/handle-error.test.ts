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

  it('never throws out of the hook, and STILL reports, with a malformed request', () => {
    const client = fakeClient();
    const bridge = createHandleError({ getClient: () => client as never });
    const err = new Error('x');
    expect(() => bridge(err, { request: undefined as never })).not.toThrow();
    // Losing the request must cost the ATTRIBUTION, never the report — the binding principle is that an
    // interceptor never swallows an error the app would otherwise see reported.
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('path' in params).toBe(false);
  });

  it('STILL reports when the hook is called with no args at all', () => {
    const client = fakeClient();
    const err = new Error('x');
    expect(() =>
      createHandleError({ getClient: () => client as never })(err, undefined as never),
    ).not.toThrow();
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith('remix.request-error', expect.anything());
  });

  it('STILL reports (with method + path) when the request carries no abort signal', () => {
    const client = fakeClient();
    const err = new Error('x');
    // A hand-rolled / polyfilled Request may have no `signal`; the cancellation guard must not turn that
    // into a dropped report.
    const request = {
      method: 'PUT',
      url: 'https://app.test/api/users/42?token=secret',
    } as unknown as Request;
    expect(() =>
      createHandleError({ getClient: () => client as never })(err, { request }),
    ).not.toThrow();
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'remix.request-error',
      expect.objectContaining({ method: 'PUT', path: '/api/users/42' }),
    );
  });

  it('STILL reports when params are present but the request is not (params attribution survives)', () => {
    const client = fakeClient();
    const err = new Error('x');
    createHandleError({ getClient: () => client as never })(err, {
      request: undefined as never,
      params: { id: '7' },
    });
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'remix.request-error',
      expect.objectContaining({ params: { id: '7' } }),
    );
  });

  it('defaults to the carrier client when no getClient is provided', () => {
    const client = fakeClient();
    setCarrierClient(client as never);
    const err = new Error('x');
    handleError(err, { request: req() });
    // The point of the ready-made export is that it finds the process singleton — assert it REACHED it.
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'remix.request-error',
      expect.objectContaining({ method: 'POST', path: '/api/users/42' }),
    );
  });
});
