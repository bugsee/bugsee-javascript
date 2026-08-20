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

  it('still REPORTS the error when the attribution event fails (the event must not veto the report)', () => {
    // The `event` is decoration — route attribution on the recording. `logException` is the artifact the
    // whole hook exists to produce. `client.event()` reaches the capture aggregator and its store, so a
    // failure there (a full/failed disk write on the node tier, a hostile params object) is reachable in
    // production — and it used to take the exception report down with it, silently, inside the shared
    // `catch`. Every SSR adapter (Next.js onRequestError, SvelteKit/Remix handleError, Nuxt error hook,
    // Astro middleware) routes through here, so the loss is total.
    const client = {
      event: vi.fn(() => {
        throw new Error('capture store write failed');
      }),
      logException: vi.fn(async () => ({ ok: true }) as const),
    };
    const err = new Error('the customer error');
    reportServerError(err, { getClient: () => client as never, event: { name: 'x' } });
    expect(client.event).toHaveBeenCalledTimes(1);
    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('defaults to the carrier client when no getClient is provided', () => {
    const client = fakeClient();
    setCarrierClient(client);
    reportServerError(new Error('x'), { event: { name: 'nuxt.error' } });
    expect(client.event).toHaveBeenCalledWith('nuxt.error', undefined);
    expect(client.logException).toHaveBeenCalledTimes(1);
  });
});
