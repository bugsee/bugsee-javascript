import type { Bugsee } from '@bugsee/bugsee';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as componentAnnotate from './component-annotate';
import * as componentName from './component-name';
import * as errorMod from './error';
import { installBugseeErrorHandler } from './error';
import * as renderMixin from './render-mixin';
import * as routerMod from './router';

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

  it('contains a throwing client and a throwing RESOLVER at every other host seam', () => {
    // Wave 2.2. The tests above cover `installBugseeErrorHandler` — the seam the review named. Nothing
    // covered the rest, and `getClient` is APPLICATION-supplied: it needs no SDK bug to throw (an app
    // reading an auth header that is absent is enough) and it runs before any guard on the client.
    const hostileClient = (): Bugsee =>
      new Proxy({} as Bugsee, {
        get() {
          return () => {
            throw new Error('SDK internal failure');
          };
        },
      });
    const hostileResolver = (): Bugsee => {
      throw new Error('app resolver failed');
    };

    for (const getClient of [() => hostileClient(), hostileResolver]) {
      expect(() => errorMod.reportVueError(new Error('boom'), { getClient })).not.toThrow();

      // Re-exported from @bugsee/web-adapter, but reachable from `@bugsee/vue` — so it is part of THIS
      // package's host-facing surface and gets asserted here rather than exempted on trust.
      expect(() => routerMod.setRouteName('/users/:id', { getClient })).not.toThrow();

      expect(() => {
        const mixin = renderMixin.createBugseeVueRenderMixin({ getClient }) as unknown as Record<
          string,
          (this: unknown) => void
        >;
        for (const hook of Object.keys(mixin)) {
          mixin[hook]?.call({ $options: { name: 'Widget' } });
        }
      }).not.toThrow();

      // vue-router invokes the registered callback on EVERY navigation, long after setup returned.
      expect(() => {
        let after: ((to: unknown) => void) | undefined;
        routerMod.instrumentVueRouter(
          {
            afterEach: (fn: (to: unknown) => void) => {
              after = fn;
            },
          } as never,
          { getClient },
        );
        after?.({ matched: [{ path: '/users/:id' }] });
      }).not.toThrow();
    }
  });

  it('contains a hostile ROUTER object — it is host-supplied and this runs at app setup', () => {
    expect(() =>
      routerMod.instrumentVueRouter(
        {
          afterEach: () => {
            throw new Error('router blew up');
          },
        } as never,
        {},
      ),
    ).not.toThrow();
  });

  it('contains a hostile object in the pure readers', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile object');
        },
      },
    );
    expect(() => componentName.vueComponentName(hostile)).not.toThrow();
    expect(() => routerMod.routePatternFromVueRoute(hostile as never)).not.toThrow();
  });

  it('covers EVERY host-facing export — adding one without a containment test fails here', () => {
    // The COMPLETENESS half, and the thing that makes Wave 2.2 enforcement rather than a snapshot of
    // today's diligence: a new export with no containment test fails this assertion by name.
    const owned: Record<string, unknown> = {
      ...componentAnnotate,
      ...componentName,
      ...errorMod,
      ...renderMixin,
      ...routerMod,
    };
    const functions = Object.keys(owned).filter((name) => typeof owned[name] === 'function');
    const covered = new Set([
      'installBugseeErrorHandler',
      'reportVueError',
      'createBugseeVueRenderMixin',
      'instrumentVueRouter',
      'vueComponentName',
      'routePatternFromVueRoute',
      'setRouteName',
      // Returns a plain options object for the caller to register with Vue; holds no client and touches
      // nothing host-supplied until Vue calls the hooks, which the render-mixin case above drives.
      'createBugseeVueComponentMixin',
    ]);
    expect(functions.filter((name) => !covered.has(name)).sort()).toEqual([]);
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
