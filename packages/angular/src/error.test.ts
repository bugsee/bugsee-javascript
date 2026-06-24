import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BugseeErrorHandler, createAngularErrorHandler, reportAngularError } from './error';

function fakeClient() {
  const logException = vi.fn(
    (_error: unknown, _options?: { mechanism?: string }): Promise<{ ok: true }> =>
      Promise.resolve({ ok: true }),
  );
  return { client: { logException } as unknown as Bugsee, logException };
}

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('reportAngularError', () => {
  it('reports the error with the default `uncaught` mechanism', () => {
    const { client, logException } = fakeClient();
    const err = new Error('boom');
    reportAngularError(err, { getClient: () => client });
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(err);
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('uncaught');
  });

  it('unwraps Angular`s wrapper to report the ORIGINAL error (error.ngOriginalError)', () => {
    const { client, logException } = fakeClient();
    const original = new Error('the real cause');
    const wrapped = Object.assign(new Error('wrapped'), { ngOriginalError: original });
    reportAngularError(wrapped, { getClient: () => client });
    expect(logException.mock.calls[0]?.[0]).toBe(original); // the unwrapped original is reported
  });

  it('reports the error as-is when there is no ngOriginalError (incl. a non-object thrown value)', () => {
    const { client, logException } = fakeClient();
    reportAngularError('a string error', { getClient: () => client });
    expect(logException.mock.calls[0]?.[0]).toBe('a string error');
  });

  it('treats a null/undefined ngOriginalError as absent (reports the wrapper itself)', () => {
    const { client, logException } = fakeClient();
    const wrapped = Object.assign(new Error('wrapped'), { ngOriginalError: null });
    reportAngularError(wrapped, { getClient: () => client });
    expect(logException.mock.calls[0]?.[0]).toBe(wrapped);
  });

  it('applies a mechanism override', () => {
    const { client, logException } = fakeClient();
    reportAngularError(new Error('x'), { getClient: () => client, mechanism: 'programmatic' });
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
  });

  it('is a no-op when no client is resolvable', () => {
    expect(() => reportAngularError(new Error('x'), { getClient: () => undefined })).not.toThrow();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, logException } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { '0.0.0': { client } };
    reportAngularError(new Error('via-carrier'));
    expect(logException).toHaveBeenCalledTimes(1);
  });
});

describe('createAngularErrorHandler', () => {
  it('handleError reports the error and then DELEGATES to a chained handler (e.g. the default ErrorHandler)', () => {
    const { client, logException } = fakeClient();
    const delegate = { handleError: vi.fn() };
    const handler = createAngularErrorHandler({ getClient: () => client, delegate });
    const err = new Error('boom');
    handler.handleError(err);
    expect(logException).toHaveBeenCalledTimes(1);
    expect(delegate.handleError).toHaveBeenCalledWith(err); // the default handler still runs (console etc.)
  });

  it('works with no delegate (reports only)', () => {
    const { client, logException } = fakeClient();
    const handler = createAngularErrorHandler({ getClient: () => client });
    expect(() => handler.handleError(new Error('x'))).not.toThrow();
    expect(logException).toHaveBeenCalledTimes(1);
  });
});

describe('BugseeErrorHandler', () => {
  it('is a parameterless ErrorHandler (useClass) that reports via the carrier client', () => {
    const { client, logException } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { '0.0.0': { client } };
    const handler = new BugseeErrorHandler(); // Angular: { provide: ErrorHandler, useClass: BugseeErrorHandler }
    handler.handleError(new Error('boom'));
    expect(logException).toHaveBeenCalledTimes(1);
  });
});
