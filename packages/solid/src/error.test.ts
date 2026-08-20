import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportSolidError, solidErrorHandler } from './error';

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

describe('reportSolidError', () => {
  it('reports the error with the default `uncaught` mechanism', () => {
    const { client, logException } = fakeClient();
    const err = new Error('boom');
    reportSolidError(err, { getClient: () => client });
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(err);
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('uncaught');
  });

  it('applies a mechanism override', () => {
    const { client, logException } = fakeClient();
    reportSolidError(new Error('x'), { getClient: () => client, mechanism: 'programmatic' });
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
  });

  it('is a no-op when no client is resolvable', () => {
    expect(() => reportSolidError(new Error('x'), { getClient: () => undefined })).not.toThrow();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, logException } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } };
    reportSolidError(new Error('via-carrier'));
    expect(logException).toHaveBeenCalledTimes(1);
  });
});

describe('solidErrorHandler', () => {
  it('returns a handler (for Solid onError / an ErrorBoundary fallback) that reports the error', () => {
    const { client, logException } = fakeClient();
    const handler = solidErrorHandler({ getClient: () => client });
    const err = new Error('render boom');
    handler(err); // e.g. onError(handler) or <ErrorBoundary fallback={(e) => (handler(e), <Fallback/>)}>
    expect(logException.mock.calls[0]?.[0]).toBe(err);
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('uncaught');
  });

  it('threads the mechanism option through to the report', () => {
    const { client, logException } = fakeClient();
    solidErrorHandler({ getClient: () => client, mechanism: 'programmatic' })(new Error('x'));
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
  });
});
