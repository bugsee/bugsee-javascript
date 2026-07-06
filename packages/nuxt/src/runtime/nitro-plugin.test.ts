import { afterEach, describe, expect, it, vi } from 'vitest';

// The runtime plugin composes Nitro auto-imports (`defineNitroPlugin`/`useRuntimeConfig` from
// `nitropack/runtime`) + our tested server core (`installBugseeNitro` from `@bugsee/nuxt/server`). Mock all
// three so the plugin body runs in isolation: `defineNitroPlugin` returns the callback verbatim so importing
// the default export gives us the callback to invoke.
const { defineNitroPlugin, useRuntimeConfig } = vi.hoisted(() => ({
  defineNitroPlugin: vi.fn((cb: unknown) => cb),
  useRuntimeConfig: vi.fn(),
}));
vi.mock('nitropack/runtime', () => ({ defineNitroPlugin, useRuntimeConfig }));
const { installBugseeNitro } = vi.hoisted(() => ({ installBugseeNitro: vi.fn() }));
vi.mock('@bugsee/nuxt/server', () => ({ installBugseeNitro }));

import nitroPlugin from './nitro-plugin';

describe('the Nitro runtime plugin', () => {
  afterEach(() => {
    useRuntimeConfig.mockReset();
    installBugseeNitro.mockReset();
  });

  it('is registered via defineNitroPlugin (its default export is that plugin)', () => {
    expect(defineNitroPlugin).toHaveBeenCalledTimes(1);
    expect(nitroPlugin).toBe(defineNitroPlugin.mock.calls[0]?.[0]); // default = the registered callback
  });

  it('installs Bugsee on the Nitro app with the private `bugsee` runtime config', () => {
    const bugseeConfig = { appToken: 'tok', environment: 'prod' };
    useRuntimeConfig.mockReturnValue({ bugsee: bugseeConfig, public: {} });
    const nitroApp = { hooks: { hook: vi.fn() } };

    (nitroPlugin as (app: unknown) => void)(nitroApp);

    expect(installBugseeNitro).toHaveBeenCalledWith(nitroApp, bugseeConfig);
    // Referential (not structural) — the REAL Nitro app (with its live hooks) must be forwarded, not a clone.
    expect(installBugseeNitro.mock.calls[0]?.[0]).toBe(nitroApp);
  });
});
