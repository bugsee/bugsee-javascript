import { afterEach, describe, expect, it, vi } from 'vitest';

// Mirror of the node runtime-plugin test, for the edge variant: mock the Nitro auto-imports + the edge core.
const { defineNitroPlugin, useRuntimeConfig } = vi.hoisted(() => ({
  defineNitroPlugin: vi.fn((cb: unknown) => cb),
  useRuntimeConfig: vi.fn(),
}));
vi.mock('nitropack/runtime', () => ({ defineNitroPlugin, useRuntimeConfig }));
const { installBugseeNitroEdge } = vi.hoisted(() => ({ installBugseeNitroEdge: vi.fn() }));
vi.mock('@bugsee/nuxt/edge', () => ({ installBugseeNitroEdge }));

import edgePlugin from './nitro-plugin.edge';

describe('the edge Nitro runtime plugin', () => {
  afterEach(() => {
    useRuntimeConfig.mockReset();
    installBugseeNitroEdge.mockReset();
  });

  it('is registered via defineNitroPlugin (its default export is that plugin)', () => {
    expect(defineNitroPlugin).toHaveBeenCalledTimes(1);
    expect(edgePlugin).toBe(defineNitroPlugin.mock.calls[0]?.[0]);
  });

  it('installs the EDGE Bugsee on the Nitro app with the private `bugsee` runtime config', () => {
    const bugseeConfig = { appToken: 'tok', platformType: 'workers' };
    useRuntimeConfig.mockReturnValue({ bugsee: bugseeConfig, public: {} });
    const nitroApp = { hooks: { hook: vi.fn() } };

    (edgePlugin as (app: unknown) => void)(nitroApp);

    expect(installBugseeNitroEdge).toHaveBeenCalledWith(nitroApp, bugseeConfig);
  });
});
