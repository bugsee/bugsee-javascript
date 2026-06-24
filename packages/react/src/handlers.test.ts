import type { Bugsee } from '@bugsee/browser';
import { describe, expect, it, vi } from 'vitest';
import { createBugseeErrorHandlers } from './handlers';

function fakeClient() {
  const logException = vi.fn(
    (_error: unknown, _options?: { mechanism?: string }): Promise<{ ok: true }> =>
      Promise.resolve({ ok: true }),
  );
  return { client: { logException } as unknown as Bugsee, logException };
}

const errorInfo = (componentStack: string | null) => ({ componentStack });

describe('createBugseeErrorHandlers', () => {
  it('returns onUncaughtError / onCaughtError that report the error with the component stack linked', () => {
    const { client, logException } = fakeClient();
    const handlers = createBugseeErrorHandlers({ getClient: () => client });
    const err = new Error('outside a boundary');
    handlers.onUncaughtError(err, errorInfo('\n    in Page'));
    expect(logException.mock.calls[0]?.[0]).toBe(err);
    expect((err.cause as Error).stack).toContain('in Page'); // component stack linked through reportReactError
  });

  it('onCaughtError reports too (a boundary that does not itself report)', () => {
    const { client, logException } = fakeClient();
    const handlers = createBugseeErrorHandlers({ getClient: () => client });
    handlers.onCaughtError(new Error('caught'), errorInfo(null));
    expect(logException).toHaveBeenCalledTimes(1);
  });

  it('threads the mechanism option through', () => {
    const { client, logException } = fakeClient();
    const handlers = createBugseeErrorHandlers({
      getClient: () => client,
      mechanism: 'programmatic',
    });
    handlers.onUncaughtError(new Error('x'), errorInfo(null));
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
  });

  it('tolerates a null component stack (nothing linked) and a missing errorInfo', () => {
    const { client, logException } = fakeClient();
    const handlers = createBugseeErrorHandlers({ getClient: () => client });
    const err = new Error('x');
    handlers.onUncaughtError(err, errorInfo(null));
    expect(err.cause).toBeUndefined(); // null stack → nothing linked
    expect(() =>
      handlers.onUncaughtError(new Error('y'), undefined as unknown as { componentStack: null }),
    ).not.toThrow(); // a missing errorInfo must not throw
    expect(logException).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no SDK is launched', () => {
    const handlers = createBugseeErrorHandlers({ getClient: () => undefined });
    expect(() => handlers.onUncaughtError(new Error('x'), errorInfo(null))).not.toThrow();
  });
});
