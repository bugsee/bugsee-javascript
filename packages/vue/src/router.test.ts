import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instrumentVueRouter,
  routePatternFromVueRoute,
  setRouteName,
  type VueRouteLike,
  type VueRouterLike,
  viewNameFromVueRoute,
} from './router';

function fakeClient() {
  const setRouteNameSpy = vi.fn();
  const ext = vi.fn((name: string) => {
    if (name === 'performance') return { setRouteName: setRouteNameSpy };
    throw new Error(`extension ${name} not registered`);
  });
  return { client: { ext } as unknown as Bugsee, setRouteName: setRouteNameSpy };
}

const route = (matched: NonNullable<VueRouteLike['matched']>): VueRouteLike => ({ matched });

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('routePatternFromVueRoute', () => {
  it('uses the DEEPEST matched record path (the full parameterized pattern)', () => {
    // vue-router normalizes nested children to absolute paths, so the last record carries the full pattern.
    expect(routePatternFromVueRoute(route([{ path: '/users' }, { path: '/users/:id' }]))).toBe(
      '/users/:id',
    );
  });

  it('returns undefined when there is no matched record or no pattern', () => {
    expect(routePatternFromVueRoute(route([]))).toBeUndefined();
    expect(routePatternFromVueRoute({})).toBeUndefined();
    expect(routePatternFromVueRoute(route([{ path: '' }]))).toBeUndefined();
    expect(routePatternFromVueRoute(route([{}]))).toBeUndefined();
  });
});

describe('setRouteName', () => {
  it('refines the active transaction via ext(performance).setRouteName', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteName('/users/:id', { getClient: () => client });
    expect(spy).toHaveBeenCalledWith('/users/:id');
  });

  it('is a no-op when no client is resolvable', () => {
    expect(() => setRouteName('/x', { getClient: () => undefined })).not.toThrow();
  });

  it('is a no-op when the performance extension is not registered (ext throws)', () => {
    const client = {
      ext: () => {
        throw new Error('not registered');
      },
    } as unknown as Bugsee;
    expect(() => setRouteName('/x', { getClient: () => client })).not.toThrow();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, setRouteName: spy } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } };
    setRouteName('/dash');
    expect(spy).toHaveBeenCalledWith('/dash');
  });
});

describe('instrumentVueRouter', () => {
  it('registers an afterEach that refines the active transaction to the matched route pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    let guard: ((to: VueRouteLike) => void) | undefined;
    const router: VueRouterLike = {
      afterEach: (g) => {
        guard = g;
      },
    };
    instrumentVueRouter(router, { getClient: () => client });
    guard?.(route([{ path: '/orders/:orderId' }])); // a navigation resolves
    expect(spy).toHaveBeenCalledWith('/orders/:orderId');
  });

  it('does nothing for a navigation with no usable route pattern (setRouteName not called)', () => {
    const { client, setRouteName: spy } = fakeClient();
    let guard: ((to: VueRouteLike) => void) | undefined;
    instrumentVueRouter(
      {
        afterEach: (g) => {
          guard = g;
        },
      },
      { getClient: () => client },
    );
    guard?.(route([])); // no matched record
    expect(spy).not.toHaveBeenCalled();
  });
});

type Guard = (to: VueRouteLike, from?: unknown, failure?: unknown) => void;
const wire = () => {
  const setRoute = vi.fn();
  const setView = vi.fn();
  const { client } = fakeClient();
  const full = { ...(client as object), setRoute, setView } as unknown as Bugsee;
  let guard: Guard | undefined;
  instrumentVueRouter({ afterEach: (g) => (guard = g) }, { getClient: () => full });
  return { setRoute, setView, navigate: (...a: Parameters<Guard>) => guard?.(...a) };
};

describe('instrumentVueRouter: the route trace is for COMMITTED navigations only', () => {
  it('writes the matched pattern to client.setRoute', () => {
    const { setRoute, navigate } = wire();
    navigate(route([{ path: '/orders/:id' }]));
    expect(setRoute).toHaveBeenCalledExactlyOnceWith('/orders/:id');
  });

  it('writes nothing for a navigation that carries a failure (aborted, cancelled, duplicated, redirected away)', () => {
    const { setRoute, setView, navigate } = wire();
    for (const failure of [new Error('aborted'), { type: 16 }, 'x', 0, false, '']) {
      navigate(
        route([{ path: '/orders/:id', components: { default: { name: 'OrderDetail' } } }]),
        {},
        failure,
      );
    }
    expect(setRoute).not.toHaveBeenCalled();
    expect(setView).not.toHaveBeenCalled();
  });

  it('treats an explicit undefined or null failure as a success', () => {
    const { setRoute, navigate } = wire();
    navigate(route([{ path: '/a' }]), {}, undefined);
    navigate(route([{ path: '/b' }]), {}, null);
    expect(setRoute.mock.calls).toEqual([['/a'], ['/b']]);
  });
});

describe('viewNameFromVueRoute', () => {
  const view = (component: unknown) =>
    viewNameFromVueRoute(
      route([{ path: '/p' }, { path: '/p/q', components: { default: component } }]),
    );

  it('reads the deepest matched record default component: name, then __name, then displayName', () => {
    expect(view({ name: 'OrderDetail' })).toBe('OrderDetail');
    expect(view({ __name: 'ScriptSetup' })).toBe('ScriptSetup');
    expect(view({ displayName: 'Functional' })).toBe('Functional');
    expect(view({ name: 'A', __name: 'B', displayName: 'C' })).toBe('A');
  });

  it('is undefined when there is no component, no name, or an empty or non-string name', () => {
    expect(view(undefined)).toBeUndefined();
    expect(view({})).toBeUndefined();
    expect(view({ name: '' })).toBeUndefined();
    expect(view({ name: 5 })).toBeUndefined();
    expect(viewNameFromVueRoute({})).toBeUndefined();
    expect(viewNameFromVueRoute(route([]))).toBeUndefined();
    expect(viewNameFromVueRoute(route([{ path: '/x', components: null }]))).toBeUndefined();
  });

  it('reads only the DEEPEST record (a layout parent does not name the page)', () => {
    const r = route([
      { path: '/p', components: { default: { name: 'Layout' } } },
      { path: '/p/q' },
    ]);
    expect(viewNameFromVueRoute(r)).toBeUndefined();
  });

  it('never throws on a hostile route', () => {
    const hostile = {
      get matched(): never {
        throw new Error('boom');
      },
    } as unknown as VueRouteLike;
    expect(viewNameFromVueRoute(hostile)).toBeUndefined();
  });
});

describe('instrumentVueRouter: the best-effort view trace', () => {
  it('writes {name, type: "vue"} through client.setView', () => {
    const { setView, navigate } = wire();
    navigate(route([{ path: '/o/:id', components: { default: { name: 'OrderDetail' } } }]));
    expect(setView).toHaveBeenCalledExactlyOnceWith({ name: 'OrderDetail', type: 'vue' });
  });

  it('writes no view for a minified or missing name, but still the route', () => {
    const { setRoute, setView, navigate } = wire();
    navigate(route([{ path: '/o', components: { default: { name: 'e' } } }]));
    navigate(route([{ path: '/p' }]));
    expect(setView).not.toHaveBeenCalled();
    expect(setRoute.mock.calls).toEqual([['/o'], ['/p']]);
  });

  it('still writes the view when the record has a component but no usable path pattern', () => {
    const { setRoute, setView, navigate } = wire();
    navigate(route([{ path: '', components: { default: { name: 'Account' } } }]));
    expect(setRoute).not.toHaveBeenCalled();
    expect(setView).toHaveBeenCalledWith({ name: 'Account', type: 'vue' });
  });

  it('a defineAsyncComponent wrapper is not a view (AsyncComponentWrapper, carrying __asyncLoader)', () => {
    const view = (component: unknown) =>
      viewNameFromVueRoute(route([{ path: '/p/q', components: { default: component } }]));
    const loader = () => Promise.resolve({});
    expect(view({ name: 'AsyncComponentWrapper', __asyncLoader: loader })).toBeUndefined();
    expect(view({ name: 'Dashboard', __asyncLoader: loader })).toBeUndefined();
    expect(view({ name: 'Dashboard', __asyncLoader: 'not a loader' })).toBe('Dashboard');
  });
});

describe('instrumentVueRouter: an async wrapper writes the route and no view', () => {
  it('writes no view for AsyncComponentWrapper by name either', () => {
    const { setRoute, setView, navigate } = wire();
    navigate(route([{ path: '/o', components: { default: { name: 'AsyncComponentWrapper' } } }]));
    expect(setRoute).toHaveBeenCalledWith('/o');
    expect(setView).not.toHaveBeenCalled();
  });
});

describe('instrumentVueRouter: seeds the CURRENT route (the landing page is not lost)', () => {
  const setup = (router: Partial<VueRouterLike> & { currentRoute?: unknown }) => {
    const setRoute = vi.fn();
    const setView = vi.fn();
    const { client } = fakeClient();
    const full = { ...(client as object), setRoute, setView } as unknown as Bugsee;
    let guard: Guard | undefined;
    const errors: unknown[] = [];
    // descriptors, not a spread: a hostile getter must not run while the test builds its router
    const built = Object.defineProperties(
      { afterEach: (g: Guard) => (guard = g) },
      Object.getOwnPropertyDescriptors(router),
    ) as unknown as VueRouterLike;
    instrumentVueRouter(built, {
      getClient: () => full,
      onError: (e) => errors.push(e),
    });
    return { setRoute, setView, errors, guard: () => guard };
  };

  it('writes the route and view of an already-committed currentRoute at instrument time', () => {
    const { setRoute, setView } = setup({
      currentRoute: {
        value: route([{ path: '/o/:id', components: { default: { name: 'OrderDetail' } } }]),
      },
    });
    expect(setRoute).toHaveBeenCalledExactlyOnceWith('/o/:id');
    expect(setView).toHaveBeenCalledExactlyOnceWith({ name: 'OrderDetail', type: 'vue' });
  });

  it('writes nothing for the initial START_LOCATION (no matched record yet), and still follows afterEach', () => {
    const { setRoute, guard } = setup({ currentRoute: { value: { matched: [] } } });
    expect(setRoute).not.toHaveBeenCalled();
    guard()?.(route([{ path: '/later' }]));
    expect(setRoute).toHaveBeenCalledExactlyOnceWith('/later');
  });

  it('a router without currentRoute (or with an empty ref) is simply not seeded', () => {
    expect(setup({}).setRoute).not.toHaveBeenCalled();
    expect(setup({ currentRoute: {} }).setRoute).not.toHaveBeenCalled();
    expect(setup({ currentRoute: { value: undefined } }).setRoute).not.toHaveBeenCalled();
    expect(setup({ currentRoute: null }).setRoute).not.toHaveBeenCalled();
  });

  it('a hostile currentRoute is contained, reported, and does not stop afterEach being registered', () => {
    const { setRoute, errors, guard } = setup({
      get currentRoute(): never {
        throw new Error('hostile currentRoute');
      },
    });
    expect((errors[0] as Error).message).toBe('hostile currentRoute');
    guard()?.(route([{ path: '/later' }]));
    expect(setRoute).toHaveBeenCalledWith('/later');
  });

  it('registers afterEach BEFORE seeding (a seed that throws cannot cost the subscription)', () => {
    const order: string[] = [];
    const { setRoute: _unused } = setup({
      afterEach: () => order.push('afterEach'),
      get currentRoute(): never {
        order.push('currentRoute');
        throw new Error('x');
      },
    });
    expect(order).toEqual(['afterEach', 'currentRoute']);
  });
});
