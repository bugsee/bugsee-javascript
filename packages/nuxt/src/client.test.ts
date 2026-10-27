import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the browser umbrella launch + spy @bugsee/vue's installBugseeErrorHandler (keep the rest of
// @bugsee/vue real).
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@bugsee/bugsee', () => ({ launch }));
const { installBugseeErrorHandler } = vi.hoisted(() => ({ installBugseeErrorHandler: vi.fn() }));
const { instrumentVueRouter } = vi.hoisted(() => ({ instrumentVueRouter: vi.fn() }));
vi.mock('@bugsee/vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/vue')>();
  return { ...actual, installBugseeErrorHandler, instrumentVueRouter };
});

import { installBugseeClient, type NuxtAppLike } from './client';

function fakeNuxt(): NuxtAppLike {
  return { vueApp: { config: {} } };
}

describe('installBugseeClient', () => {
  afterEach(() => {
    launch.mockReset();
    installBugseeErrorHandler.mockReset();
    instrumentVueRouter.mockReset();
  });

  it('launches the browser SDK with the appToken + forwarded options, returns the client', async () => {
    const sentinel = { id: 'browser-client' };
    launch.mockReturnValue(sentinel);
    const result = await installBugseeClient(fakeNuxt(), { appToken: 'tok', captureLogs: false });
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false }); // appToken/launch stripped, opts kept
    expect(result).toBe(sentinel);
  });

  it("installs @bugsee/vue's error handler on THIS Nuxt vueApp (by reference)", async () => {
    const nuxtApp = fakeNuxt();
    await installBugseeClient(nuxtApp, { appToken: 'tok' });
    // Referential (not deep) — must be the app's OWN vueApp, not a same-shaped object.
    expect(installBugseeErrorHandler.mock.calls[0]?.[0]).toBe(nuxtApp.vueApp);
  });

  it('accepts a test launch seam and forwards only launch options', async () => {
    const client = { id: 'c' };
    const testLaunch = vi.fn(() => client as never);
    const result = await installBugseeClient(fakeNuxt(), { appToken: 'tok', launch: testLaunch });
    expect(testLaunch).toHaveBeenCalledWith('tok', {});
    expect(result).toBe(client);
    expect(launch).not.toHaveBeenCalled(); // the default browser launch was not used
  });

  it("instruments Nuxt's own vue-router (by reference) for the route and view traces", async () => {
    const $router = { afterEach: vi.fn() };
    await installBugseeClient({ ...fakeNuxt(), $router }, { appToken: 'tok' });
    expect(instrumentVueRouter).toHaveBeenCalledTimes(1);
    expect(instrumentVueRouter.mock.calls[0]?.[0]).toBe($router);
  });

  it('instruments the router only after the SDK is launched (the carrier client exists to feed)', async () => {
    const order: string[] = [];
    instrumentVueRouter.mockImplementation(() => order.push('router'));
    const testLaunch = vi.fn(() => {
      order.push('launch');
      return {} as never;
    });
    await installBugseeClient(
      { ...fakeNuxt(), $router: { afterEach: () => {} } },
      { appToken: 'tok', launch: testLaunch },
    );
    expect(order).toEqual(['launch', 'router']);
  });

  it('skips the router when the app has none (or one without afterEach)', async () => {
    await installBugseeClient(fakeNuxt(), { appToken: 'tok' });
    await installBugseeClient({ ...fakeNuxt(), $router: {} as never }, { appToken: 'tok' });
    expect(instrumentVueRouter).not.toHaveBeenCalled();
  });
});
