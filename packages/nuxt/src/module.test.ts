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

  // Nuxt's env overrides are STRINGS: `NUXT_PUBLIC_BUGSEE=whatever` in the deploy environment lands a bare
  // string in the slot we merge over. Spreading a string yields index keys (`{0:'w',1:'h',…}`), which would
  // ship a garbage option bag to the browser; spreading a number/boolean silently yields nothing. The
  // narrowing guard is what keeps a mistyped env var from corrupting the config.
  it.each([
    ['a string (the shape a Nuxt env override produces)', 'NUXT_PUBLIC_BUGSEE=oops'],
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
  ])('ignores a non-object runtimeConfig slot: %s', (_label, value) => {
    const nuxt: NuxtLike = {
      options: {
        runtimeConfig: {
          bugsee: value,
          public: { bugsee: value },
        } as unknown as NuxtLike['options']['runtimeConfig'],
      },
    };
    setupBugseeModule({ appToken: 'tok', client: { captureLogs: false }, server: {} }, nuxt);
    expect(nuxt.options.runtimeConfig.public.bugsee).toStrictEqual({
      appToken: 'tok',
      captureLogs: false,
    });
    expect(nuxt.options.runtimeConfig.bugsee).toStrictEqual({ appToken: 'tok' });
  });

  it('registers the client (browser) plugin as a client-mode template with our generator', () => {
    setupBugseeModule({ appToken: 'tok' }, fakeNuxt());
    expect(addPluginTemplate).toHaveBeenCalledWith({
      filename: 'bugsee-client.mjs',
      mode: 'client',
      getContents: clientPluginContent,
    });
  });

  it('registers the shipped NODE Nitro server plugin by default (non-edge preset)', () => {
    setupBugseeModule({ appToken: 'tok' }, fakeNuxt());
    expect(createResolver).toHaveBeenCalledTimes(1);
    expect(addServerPlugin).toHaveBeenCalledWith('RESOLVED:./runtime/nitro-plugin');
  });

  it('registers the node plugin for an explicit node preset', () => {
    const nuxt = fakeNuxt();
    nuxt.options.nitro = { preset: 'node-server' };
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    expect(addServerPlugin).toHaveBeenCalledWith('RESOLVED:./runtime/nitro-plugin');
  });

  it.each([
    'vercel-edge',
    'cloudflare-pages',
    'cloudflare_module',
    'netlify-edge',
  ])('registers the EDGE plugin for the edge preset %s', (preset) => {
    const nuxt = fakeNuxt();
    nuxt.options.nitro = { preset };
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    expect(addServerPlugin).toHaveBeenCalledWith('RESOLVED:./runtime/nitro-plugin.edge');
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

// WAVE 4.4 — the preset is not known when modules run.
//
// `nuxt.options.nitro?.preset` is only populated when the user writes `nitro: { preset }` or passes an
// explicit override. Nitro's AUTO-DETECTION — the zero-config path Nuxt's own deployment docs advertise —
// resolves it inside `createNitro()`, long after modules have run. Measured on a real `nuxi build` of the
// e2e fixture with CF_PAGES=1 and no preset set:
//
//   PROBE SETUP      nuxt.options.nitro?.preset = undefined
//   PROBE NITRO:INIT nitro.options.preset       = "cloudflare-pages"
//
// So every zero-config Cloudflare deploy got `@bugsee/bugsee/node` — fs storage, the worker-thread ANR
// watchdog and `process.uptime()` — bundled into workerd.
describe('the Nitro plugin follows the RESOLVED preset (Wave 4.4)', () => {
  const fakeNitro = (preset: string | undefined, plugins: string[] = []) => ({
    options: { preset, plugins },
  });

  /** A Nuxt that records `nitro:init` subscribers so a test can fire them the way Nuxt does. */
  function hookableNuxt(): NuxtLike & { fire: (nitro: unknown) => void } {
    const hooks: Array<(nitro: unknown) => void> = [];
    return {
      options: { runtimeConfig: { public: {} } },
      hook: (name: string, fn: (nitro: unknown) => void) => {
        if (name === 'nitro:init') hooks.push(fn);
      },
      fire: (nitro: unknown) => {
        for (const h of hooks) h(nitro);
      },
    } as NuxtLike & { fire: (nitro: unknown) => void };
  }

  it('swaps in the EDGE plugin when the preset is only resolved at nitro:init', () => {
    const nuxt = hookableNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    const nitro = fakeNitro('cloudflare-pages', ['RESOLVED:./runtime/nitro-plugin']);
    nuxt.fire(nitro);
    expect(nitro.options.plugins).toEqual(['RESOLVED:./runtime/nitro-plugin.edge']);
  });

  it('leaves the NODE plugin in place for a resolved node preset', () => {
    const nuxt = hookableNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    const nitro = fakeNitro('node-server', ['RESOLVED:./runtime/nitro-plugin']);
    nuxt.fire(nitro);
    expect(nitro.options.plugins).toEqual(['RESOLVED:./runtime/nitro-plugin']);
  });

  it('does not disturb a user’s own Nitro plugins', () => {
    // The hook mutates a shared array that the app and other modules also write to.
    const nuxt = hookableNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    const nitro = fakeNitro('cloudflare-pages', [
      'user/before',
      'RESOLVED:./runtime/nitro-plugin',
      'user/after',
    ]);
    nuxt.fire(nitro);
    expect(nitro.options.plugins).toEqual([
      'user/before',
      'user/after',
      'RESOLVED:./runtime/nitro-plugin.edge',
    ]);
  });

  // The other direction of "does not disturb a user's own Nitro plugins", and the one that actually bites:
  // when nothing needs dropping, `indexOf` returns -1 — and `splice(-1, 1)` counts from the END, deleting
  // the LAST plugin in the list. The result still contains OUR plugin (it is re-pushed), so the damage is
  // invisible unless the assertion looks at the user's plugins too.
  it('does not drop a user plugin when there is no stale plugin to remove (node preset)', () => {
    const nuxt = hookableNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    const nitro = fakeNitro('node-server', [
      'user/before',
      'RESOLVED:./runtime/nitro-plugin',
      'user/after',
    ]);
    nuxt.fire(nitro);
    expect(nitro.options.plugins).toEqual([
      'user/before',
      'RESOLVED:./runtime/nitro-plugin',
      'user/after',
    ]);
  });

  it('does not drop a user plugin when the correction only has to ADD ours (edge preset)', () => {
    // Nothing of ours registered yet (setup saw no preset and the list has not been merged), so there is no
    // stale entry to splice — the same -1 hazard, with an append instead of a swap.
    const nuxt = hookableNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    const nitro = fakeNitro('cloudflare-pages', ['user/before', 'user/after']);
    nuxt.fire(nitro);
    expect(nitro.options.plugins).toEqual([
      'user/before',
      'user/after',
      'RESOLVED:./runtime/nitro-plugin.edge',
    ]);
  });

  it('is idempotent if nitro:init fires twice', () => {
    const nuxt = hookableNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    const nitro = fakeNitro('cloudflare-pages', ['RESOLVED:./runtime/nitro-plugin']);
    nuxt.fire(nitro);
    nuxt.fire(nitro);
    expect(nitro.options.plugins).toEqual(['RESOLVED:./runtime/nitro-plugin.edge']);
  });

  it('still registers at setup time when there is no hook seam — the canary', () => {
    // A Nuxt without `hook` (or a version whose nitro:init never fires) must be no worse than before, not
    // left with no server plugin at all.
    const nuxt = fakeNuxt();
    setupBugseeModule({ appToken: 'tok' }, nuxt);
    expect(addServerPlugin).toHaveBeenCalledWith('RESOLVED:./runtime/nitro-plugin');
  });
});
