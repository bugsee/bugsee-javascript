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
