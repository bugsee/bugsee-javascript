import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBugseeErrorHandler } from './error';

// Wave 2.1/2.3 — docs/review/frontend-adapters-vue-angular-svelte-solid.md SEV1 #1 and its SEV3 #7: "no test
// in any of the four packages ever injects an SDK client that throws — and the two mutations encoding that
// gap survived". Measured against real vue@3.5.38, an SDK throw here turned a customer error that the app's
// own errorHandler fully recovered from into a throw out of `app.mount()` and an empty DOM.
const throwingClient = () =>
  ({
    logException: () => {
      throw new Error('SDK BOOM');
    },
  }) as never;

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('vue does not delete the app’s error surfacing', () => {
  it('chains to Vue’s OWN default when the app has no errorHandler', () => {
    // Installing a handler REPLACES Vue's default. Measured on real vue 3.5.38: the production build went
    // from 1 console.error to 0. Identical to the Angular defect fixed in e17f389 — its sibling, one
    // package over, which that commit did not carry across.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = { config: {} as { errorHandler?: unknown } };
    installBugseeErrorHandler(app as never, {
      getClient: () => ({ logException: () => Promise.resolve() }) as never,
    });
    const err = new Error('uncaught');
    (app.config.errorHandler as (e: unknown, i: unknown, s: string) => void)(err, {}, 'render');
    expect(consoleError).toHaveBeenCalledWith(err);
    consoleError.mockRestore();
  });

  it('prefers the app’s own handler over the default when one exists', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = vi.fn();
    const app = { config: { errorHandler: previous } };
    installBugseeErrorHandler(app as never, {
      getClient: () => ({ logException: () => Promise.resolve() }) as never,
    });
    app.config.errorHandler(new Error('e'), {}, 'render');
    expect(previous).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled(); // no double-surfacing
    consoleError.mockRestore();
  });
});

describe('vue error handler is a contained host boundary', () => {
  it('does not throw into Vue, and STILL runs the app’s own handler, when the SDK throws', () => {
    const previous = vi.fn();
    const onError = vi.fn();
    const app = { config: { errorHandler: previous } };
    installBugseeErrorHandler(app as never, { getClient: throwingClient, onError });
    const err = new Error('customer render error');
    expect(() => app.config.errorHandler(err, {}, 'render')).not.toThrow();
    expect(previous).toHaveBeenCalledWith(err, {}, 'render'); // the app keeps its recovery
    expect(onError).toHaveBeenCalled();
  });

  it('does not throw into Vue when the component-name lookup itself throws', () => {
    // The label work runs in the same seam; a hostile/exotic instance must not take the app down either.
    const previous = vi.fn();
    const app = { config: { errorHandler: previous } };
    installBugseeErrorHandler(app as never, {
      getClient: () => ({ logException: () => Promise.resolve() }) as never,
    });
    const hostile = {
      get $options() {
        throw new Error('hostile instance');
      },
    };
    expect(() => app.config.errorHandler(new Error('e'), hostile, 'render')).not.toThrow();
    expect(previous).toHaveBeenCalled();
  });
});
