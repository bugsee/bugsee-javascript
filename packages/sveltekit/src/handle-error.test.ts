import { type BugseeClient, setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHandleServerError,
  handleError,
  handleErrorWithBugsee,
  type SvelteKitServerErrorInput,
} from './handle-error';

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn(async () => ({ ok: true }) as const),
  } as unknown as BugseeClient & {
    event: ReturnType<typeof vi.fn>;
    logException: ReturnType<typeof vi.fn>;
  };
}

function input(over: Partial<SvelteKitServerErrorInput> = {}): SvelteKitServerErrorInput {
  return {
    error: new Error('sk boom'),
    event: {
      route: { id: '/users/[id]' },
      request: { method: 'GET' },
      url: { pathname: '/users/42' },
    },
    status: 500,
    message: 'Internal Error',
    ...over,
  };
}

describe('createHandleServerError', () => {
  afterEach(() => setCarrierClient(undefined));

  it('reports a 5xx server error with route/method/path attribution + http-error mechanism', () => {
    const client = fakeClient();
    const err = new Error('loader blew up');
    createHandleServerError({ getClient: () => client })(input({ error: err }));

    expect(client.logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(client.event).toHaveBeenCalledWith(
      'sveltekit.server-error',
      expect.objectContaining({ method: 'GET', path: '/users/42', routeId: '/users/[id]' }),
    );
  });

  it('does NOT report an expected <500 error (e.g. a 404 not-found)', () => {
    const client = fakeClient();
    createHandleServerError({ getClient: () => client })(input({ status: 404 }));
    expect(client.logException).not.toHaveBeenCalled();
    expect(client.event).not.toHaveBeenCalled();
  });

  it('reports when status is absent (an unexpected throw with no status)', () => {
    const client = fakeClient();
    createHandleServerError({ getClient: () => client })(input({ status: undefined }));
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('omits attribution fields that are absent (no event)', () => {
    const client = fakeClient();
    createHandleServerError({ getClient: () => client })({ error: new Error('x'), status: 500 });
    expect(client.event).toHaveBeenCalledWith('sveltekit.server-error', {});
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('defaults to the carrier client when no getClient is given', () => {
    const client = fakeClient();
    setCarrierClient(client);
    handleError(input());
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('never throws out of the hook (defensive) + returns undefined', () => {
    const hostile = {
      event: () => {
        throw new Error('boom');
      },
    } as unknown as BugseeClient;
    expect(createHandleServerError({ getClient: () => hostile })(input())).toBeUndefined();
  });
});

describe('handleErrorWithBugsee', () => {
  afterEach(() => setCarrierClient(undefined));

  it('reports, then delegates to the app handler and forwards its return (App.Error shape)', () => {
    const client = fakeClient();
    const appHandler = vi.fn(() => ({ message: 'custom' }));
    const result = handleErrorWithBugsee(appHandler, { getClient: () => client })(input());

    expect(client.logException).toHaveBeenCalledTimes(1);
    expect(appHandler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: 'custom' });
  });

  it('reports even when there is no app handler (returns undefined)', () => {
    const client = fakeClient();
    expect(handleErrorWithBugsee(undefined, { getClient: () => client })(input())).toBeUndefined();
    expect(client.logException).toHaveBeenCalledTimes(1);
  });

  it('delegates to the app handler even for a skipped <500 error (does not report it)', () => {
    const client = fakeClient();
    const appHandler = vi.fn(() => ({ message: 'nf' }));
    const result = handleErrorWithBugsee(appHandler, { getClient: () => client })(
      input({ status: 404 }),
    );
    expect(client.logException).not.toHaveBeenCalled();
    expect(result).toEqual({ message: 'nf' });
  });
});
