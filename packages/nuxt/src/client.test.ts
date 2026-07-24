import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the browser umbrella launch + spy @bugsee/vue's installBugseeErrorHandler (keep the rest of
// @bugsee/vue real).
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@bugsee/bugsee', () => ({ launch }));
const { installBugseeErrorHandler } = vi.hoisted(() => ({ installBugseeErrorHandler: vi.fn() }));
vi.mock('@bugsee/vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/vue')>();
  return { ...actual, installBugseeErrorHandler };
});

import { installBugseeClient, type NuxtAppLike } from './client';

function fakeNuxt(): NuxtAppLike {
  return { vueApp: { config: {} } };
}

describe('installBugseeClient', () => {
  afterEach(() => {
    launch.mockReset();
    installBugseeErrorHandler.mockReset();
  });

  it('launches the browser SDK with the appToken + forwarded options, returns the client', () => {
    const sentinel = { id: 'browser-client' };
    launch.mockReturnValue(sentinel);
    const result = installBugseeClient(fakeNuxt(), { appToken: 'tok', captureLogs: false });
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false }); // appToken/launch stripped, opts kept
    expect(result).toBe(sentinel);
  });

  it("installs @bugsee/vue's error handler on THIS Nuxt vueApp (by reference)", () => {
    const nuxtApp = fakeNuxt();
    installBugseeClient(nuxtApp, { appToken: 'tok' });
    // Referential (not deep) — must be the app's OWN vueApp, not a same-shaped object.
    expect(installBugseeErrorHandler.mock.calls[0]?.[0]).toBe(nuxtApp.vueApp);
  });

  it('accepts a test launch seam and forwards only launch options', () => {
    const client = { id: 'c' };
    const testLaunch = vi.fn(() => client as never);
    const result = installBugseeClient(fakeNuxt(), { appToken: 'tok', launch: testLaunch });
    expect(testLaunch).toHaveBeenCalledWith('tok', {});
    expect(result).toBe(client);
    expect(launch).not.toHaveBeenCalled(); // the default browser launch was not used
  });
});
