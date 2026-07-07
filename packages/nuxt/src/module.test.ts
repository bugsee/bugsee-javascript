import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the @nuxt/kit build-time helpers so `setup` runs without a real Nuxt. `defineNuxtModule` returns its
// definition verbatim so the default export IS the definition (asserted below). `createResolver` returns a
// deterministic resolver so we can assert the server-plugin path.
const { defineNuxtModule, addPluginTemplate, addServerPlugin, createResolver } = vi.hoisted(() => ({
  defineNuxtModule: vi.fn((def: unknown) => def),
  addPluginTemplate: vi.fn(),
  addServerPlugin: vi.fn(),
  createResolver: vi.fn(() => ({ resolve: (p: string) => `RESOLVED:${p}` })),
}));
vi.mock('@nuxt/kit', () => ({
  defineNuxtModule,
  addPluginTemplate,
  addServerPlugin,
  createResolver,
}));

import nuxtModule, { clientPluginContent, type NuxtLike, setupBugseeModule } from './module';

function fakeNuxt(): NuxtLike {
  return { options: { runtimeConfig: { public: {} } } };
}

describe('setupBugseeModule', () => {
  afterEach(() => {
    addPluginTemplate.mockClear();
    addServerPlugin.mockClear();
    createResolver.mockClear();
  });

  it('writes the appToken + client bag into PUBLIC runtime config (shipped to the browser)', () => {
    const nuxt = fakeNuxt();
    setupBugseeModule({ appToken: 'tok', client: { captureLogs: false } }, nuxt);
    expect(nuxt.options.runtimeConfig.public.bugsee).toEqual({
      appToken: 'tok',
      captureLogs: false,
    });
  });

  it('writes the appToken + server bag into PRIVATE runtime config (server-only)', () => {
    const nuxt = fakeNuxt();
    setupBugseeModule({ appToken: 'tok', server: { captureNetwork: false } }, nuxt);
    expect(nuxt.options.runtimeConfig.bugsee).toEqual({ appToken: 'tok', captureNetwork: false });
  });

  it('defaults both bags to just the appToken when omitted', () => {
    const nuxt = fakeNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    expect(nuxt.options.runtimeConfig.public.bugsee).toEqual({ appToken: 'tok' });
    expect(nuxt.options.runtimeConfig.bugsee).toEqual({ appToken: 'tok' });
  });

  it('merges UNDER runtimeConfig the user set directly (explicit value wins, Nuxt `defu` convention)', () => {
    const nuxt: NuxtLike = {
      options: {
        runtimeConfig: {
          bugsee: { appToken: 'SRV-USER', maxDataSize: 10 },
          public: { bugsee: { appToken: 'PUB-USER', extra: 1 } },
        },
      },
    };
    setupBugseeModule({ appToken: 'MODULE', client: { captureLogs: false }, server: {} }, nuxt);
    // The user's explicit appToken + extra keys survive; module defaults only fill the gaps.
    expect(nuxt.options.runtimeConfig.public.bugsee).toEqual({
      appToken: 'PUB-USER',
      captureLogs: false,
      extra: 1,
    });
    expect(nuxt.options.runtimeConfig.bugsee).toEqual({ appToken: 'SRV-USER', maxDataSize: 10 });
  });

  it('registers the client (browser) plugin as a client-mode template with our generator', () => {
    setupBugseeModule({ appToken: 'tok' }, fakeNuxt());
    expect(addPluginTemplate).toHaveBeenCalledWith({
      filename: 'bugsee-client.mjs',
      mode: 'client',
      getContents: clientPluginContent,
    });
  });

  it('registers the shipped Nitro server plugin via the resolved runtime path', () => {
    setupBugseeModule({ appToken: 'tok' }, fakeNuxt());
    expect(createResolver).toHaveBeenCalledTimes(1);
    expect(addServerPlugin).toHaveBeenCalledWith('RESOLVED:./runtime/nitro-plugin');
  });
});

describe('clientPluginContent', () => {
  it('generates a client Nuxt plugin that installs Bugsee from the PUBLIC runtime config', () => {
    const code = clientPluginContent();
    // The auto-imports MUST come from Nuxt's `#imports` virtual module (a wrong specifier = runtime break).
    expect(code).toContain("import { defineNuxtPlugin, useRuntimeConfig } from '#imports';");
    expect(code).toContain("import { installBugseeClient } from '@bugsee/nuxt/client';");
    expect(code).toContain('export default defineNuxtPlugin(');
    expect(code).toContain('installBugseeClient(nuxtApp, useRuntimeConfig().public.bugsee)');
  });

  it('generates a SYNTACTICALLY VALID plugin (balanced braces/parens, parses)', () => {
    const code = clientPluginContent();
    // Strip the ESM imports + turn the default export into a returnable expression, then compile: a dropped
    // `});` or unbalanced paren makes this throw a SyntaxError.
    const body = code.replace(/^import .*$/gm, '').replace('export default', 'return');
    // Compiling the generated source (not executing it) is the validity check.
    expect(
      () => new Function('defineNuxtPlugin', 'useRuntimeConfig', 'installBugseeClient', body),
    ).not.toThrow();
  });
});

describe('the module default export', () => {
  it('is a defineNuxtModule with the `bugsee` config key wired to setupBugseeModule', () => {
    // The declared type is NuxtModule, but our mocked defineNuxtModule returns the definition verbatim.
    const def = nuxtModule as unknown as {
      meta: { name: string; configKey: string };
      setup: unknown;
    };
    expect(def.meta).toEqual({ name: '@bugsee/nuxt', configKey: 'bugsee' });
    expect(def.setup).toBe(setupBugseeModule); // the module delegates to the tested core
  });
});
