import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleErrorWithBugsee } from './error';

// Wave 2.1/2.3 — SvelteKit renders its error page from what `handleError` RETURNS, so an SDK throw here does
// not merely lose a report: it takes the app's error page with it.
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('svelte handleError is a contained host boundary', () => {
  it('does not throw, and STILL returns the app’s own hook result, when the SDK throws', () => {
    const appHandler = vi.fn(() => ({ message: 'app error page' }));
    const onError = vi.fn();
    const hook = handleErrorWithBugsee(appHandler, {
      getClient: () =>
        ({
          logException: () => {
            throw new Error('SDK BOOM');
          },
        }) as never,
      onError,
    });
    const input = { error: new Error('customer'), event: { route: { id: '/x' } } };
    expect(hook(input as never)).toEqual({ message: 'app error page' });
    expect(appHandler).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('does not throw when reading the route off a hostile event', () => {
    const appHandler = vi.fn(() => ({ message: 'ok' }));
    const hook = handleErrorWithBugsee(appHandler, {
      getClient: () => ({ logException: () => Promise.resolve() }) as never,
    });
    const input = {
      error: new Error('e'),
      get event() {
        throw new Error('hostile event');
      },
    };
    expect(hook(input as never)).toEqual({ message: 'ok' });
  });
});
