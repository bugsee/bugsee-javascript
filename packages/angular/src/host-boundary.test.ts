import { afterEach, describe, expect, it, vi } from 'vitest';
import { BugseeErrorHandler, createAngularErrorHandler } from './error';

// Wave 2.1/2.3 — docs/review/frontend-adapters-vue-angular-svelte-solid.md SEV1 #1 + #2.
const throwingClient = () =>
  ({
    logException: () => {
      throw new Error('SDK BOOM');
    },
  }) as never;

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  vi.restoreAllMocks();
});

describe('angular error handler is a contained host boundary', () => {
  it('does not throw into Angular, and STILL delegates, when the SDK throws', () => {
    const delegate = { handleError: vi.fn() };
    const onError = vi.fn();
    const handler = createAngularErrorHandler({ getClient: throwingClient, delegate, onError });
    const err = new Error('customer error');
    expect(() => handler.handleError(err)).not.toThrow();
    expect(delegate.handleError).toHaveBeenCalledWith(err);
    expect(onError).toHaveBeenCalled();
  });
});

describe('angular unwrapping is inside the guard too', () => {
  it('does not throw when unwrapping a hostile error object', () => {
    // `originalError()` reads `ngOriginalError`/`rejection` off the thrown value BEFORE the (separately
    // guarded) report, so a throwing getter there escapes unless the seam itself is contained.
    const delegate = { handleError: vi.fn() };
    const handler = createAngularErrorHandler({
      getClient: () => ({ logException: () => Promise.resolve() }) as never,
      delegate,
    });
    const hostile = {
      get ngOriginalError(): unknown {
        throw new Error('hostile getter');
      },
    };
    expect(() => handler.handleError(hostile)).not.toThrow();
    // Identity, not deep equality: a deep compare would itself read the throwing getter.
    expect(delegate.handleError.mock.calls[0]?.[0]).toBe(hostile);
  });
});

describe('BugseeErrorHandler does not silently delete the app’s error surfacing', () => {
  it('chains to Angular’s DEFAULT behaviour, so the documented one-liner adds rather than removes', () => {
    // `{ provide: ErrorHandler, useClass: BugseeErrorHandler }` REPLACES whatever handler the app had. With
    // nothing chained it printed zero console.error calls where Angular's own default prints one — measured
    // against real @angular/core — so uncaught errors stopped surfacing at all.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('uncaught');
    new BugseeErrorHandler().handleError(err);
    expect(consoleError).toHaveBeenCalledWith('ERROR', err);
  });

  it('still surfaces the error when the SDK throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = {
      client: {
        logException: () => {
          throw new Error('SDK BOOM');
        },
      },
    };
    expect(() => new BugseeErrorHandler().handleError(new Error('e'))).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
  });
});
