import { setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportServerError } from './report-server-error';

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn(async () => ({ ok: true }) as const),
  };
}

describe('reportServerError', () => {
  afterEach(() => setCarrierClient(undefined));

  it('reports the error (default http-error mechanism) and captures the attribution event', () => {
    const client = fakeClient();
    const err = new Error('boom');
    reportServerError(err, {
      getClient: () => client as never,
      event: { name: 'svelte.request-error', params: { route: '/a/[id]', method: 'POST' } },
    });
    expect(client.event).toHaveBeenCalledWith('svelte.request-error', {
      route: '/a/[id]',
      method: 'POST',
    });
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('honours a custom mechanism', () => {
    const client = fakeClient();
    reportServerError(new Error('x'), {
      getClient: () => client as never,
      mechanism: 'uncaught',
    });
    expect(client.logException).toHaveBeenCalledWith(expect.any(Error), { mechanism: 'uncaught' });
  });

  it('reports without an event when none is provided (logException only)', () => {
    const client = fakeClient();
    reportServerError(new Error('x'), { getClient: () => client as never });
    expect(client.event).not.toHaveBeenCalled();
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no client is active (consults the resolver, does not throw)', () => {
    const getClient = vi.fn<() => undefined>(() => undefined);
    expect(() => reportServerError(new Error('x'), { getClient })).not.toThrow();
    expect(getClient).toHaveBeenCalledTimes(1);
  });

  it('never throws when the client throws (must not disrupt the framework hook)', () => {
    const client = {
      event: vi.fn(() => {
        throw new Error('capture failed');
      }),
      logException: vi.fn(),
    };
    expect(() =>
      reportServerError(new Error('x'), {
        getClient: () => client as never,
        event: { name: 'x' },
      }),
    ).not.toThrow();
  });

  it('defaults to the carrier client when no getClient is provided', () => {
    const client = fakeClient();
    setCarrierClient(client);
    reportServerError(new Error('x'), { event: { name: 'nuxt.error' } });
    expect(client.event).toHaveBeenCalledWith('nuxt.error', undefined);
    expect(client.logException).toHaveBeenCalledTimes(1);
  });
});
