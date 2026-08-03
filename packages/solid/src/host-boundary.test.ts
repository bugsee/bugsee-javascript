import { afterEach, describe, expect, it, vi } from 'vitest';
import { solidErrorHandler } from './error';

// Wave 2.1/2.3 — this handler is wired into `<ErrorBoundary>` / `catchError`, so a throw escapes the very
// boundary meant to contain the customer's error and takes the fallback UI down with it.
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('solid error handler is a contained host boundary', () => {
  it('does not throw out of the ErrorBoundary when the SDK throws', () => {
    const onError = vi.fn();
    const handler = solidErrorHandler({
      getClient: () =>
        ({
          logException: () => {
            throw new Error('SDK BOOM');
          },
        }) as never,
      onError,
    });
    expect(() => handler(new Error('customer'))).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});
