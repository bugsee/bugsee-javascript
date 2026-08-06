import type { UnpluginOptions } from 'unplugin';
import { describe, expect, it } from 'vitest';
import {
  bugseeEsbuildPlugin,
  bugseeRollupPlugin,
  bugseeRspackPlugin,
  bugseeUnplugin,
  bugseeUnpluginFactory,
  resolveOutputDir,
} from './plugin';
import type { BugseePluginOptions } from './resolve';

/** Invoke the factory (which requires a meta arg) and narrow its single-object result. */
const makePlugin = (options?: BugseePluginOptions): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework: 'rollup' }) as UnpluginOptions;

describe('resolveOutputDir', () => {
  it('uses `dir` when present', () => {
    expect(resolveOutputDir({ dir: '/build/dist' })).toBe('/build/dist');
  });

  it('derives the directory from `file` when there is no `dir`', () => {
    expect(resolveOutputDir({ file: '/build/dist/app.js' })).toBe('/build/dist');
  });

  it('returns undefined when neither dir nor file is set (or empty)', () => {
    expect(resolveOutputDir({})).toBeUndefined();
    expect(resolveOutputDir({ dir: '', file: '' })).toBeUndefined();
  });
});

describe('bugseeUnpluginFactory', () => {
  it('produces a plugin named "bugsee" with vite/rollup/webpack entries', () => {
    const plugin = makePlugin({ disabled: true });
    expect(plugin.name).toBe('bugsee');
    expect(plugin.vite).toBeDefined();
    expect(plugin.rollup).toBeDefined();
    expect(typeof plugin.webpack).toBe('function');
  });

  it('vite/rollup writeBundle resolve without error when the plugin is disabled (no upload)', async () => {
    const plugin = makePlugin({ disabled: true });
    const vite = plugin.vite as { writeBundle: (o: { dir?: string }) => Promise<void> };
    const rollup = plugin.rollup as { writeBundle: (o: { file?: string }) => Promise<void> };
    await expect(vite.writeBundle({ dir: '/out' })).resolves.toBeUndefined();
    await expect(rollup.writeBundle({ file: '/out/app.js' })).resolves.toBeUndefined();
  });

  it('writeBundle with no resolvable output dir is a no-op (does not throw)', async () => {
    const plugin = makePlugin({ disabled: true });
    const vite = plugin.vite as { writeBundle: (o: object) => Promise<void> };
    await expect(vite.writeBundle({})).resolves.toBeUndefined();
  });
});

describe('bugseeUnplugin', () => {
  it('exposes per-bundler factories (vite, webpack, rollup, …)', () => {
    expect(typeof bugseeUnplugin.vite).toBe('function');
    expect(typeof bugseeUnplugin.webpack).toBe('function');
    expect(typeof bugseeUnplugin.rollup).toBe('function');
  });
});

describe('convenience per-bundler factories', () => {
  it('exports callable rollup/esbuild/rspack plugin factories', () => {
    expect(typeof bugseeRollupPlugin).toBe('function');
    expect(typeof bugseeEsbuildPlugin).toBe('function');
    expect(typeof bugseeRspackPlugin).toBe('function');
  });

  it('the rollup factory builds a plugin named "bugsee"', () => {
    const plugin = bugseeRollupPlugin({ disabled: true }) as { name?: string };
    const one = Array.isArray(plugin) ? plugin[0] : plugin;
    expect(one?.name).toBe('bugsee');
  });
});

// WAVE 7.6 — the documented Vite setup produced a map-free `dist`.
//
// Vite's `build.sourcemap` defaults to FALSE. Neither wrapper inspected or amended it, so a first-time user
// who adds `bugseeVitePlugin({ appToken })` to an ordinary config got a build that spawned `bugsee-cli`
// against an output directory containing no `.map` files at all — real bugsee-cli v0.7.2 exits 10, "no .map
// source-map files found under: <dir>". Reproduced in the review against real Vite 6.4.3 and 7.3.6.
//
// Containing the failure (Wave 7.3) stops it breaking the build, which turns it into the OTHER failure this
// remediation is about: a feature that silently does nothing. The wrapper owns the one thing the engine
// cannot see — the bundler's own configuration — so this is where it has to be fixed.
describe('the Vite plugin ensures source maps exist (Wave 7.6)', () => {
  const viteConfigHook = (options?: BugseePluginOptions) => {
    const plugin = makePlugin(options);
    const hook = (plugin.vite as { config?: unknown } | undefined)?.config;
    return hook as (config: { build?: { sourcemap?: unknown } }) => unknown;
  };

  it('turns `build.sourcemap` on when the user left it at its default', () => {
    const config: { build?: { sourcemap?: unknown } } = {};
    const patch = viteConfigHook({ appToken: 'tok' })(config) as {
      build?: { sourcemap?: unknown };
    };
    expect(patch?.build?.sourcemap).toBe(true);
  });

  it('turns it on when the user explicitly set it to false', () => {
    const patch = viteConfigHook({ appToken: 'tok' })({ build: { sourcemap: false } }) as {
      build?: { sourcemap?: unknown };
    };
    expect(patch?.build?.sourcemap).toBe(true);
  });

  it('leaves a user’s own choice of `hidden` alone', () => {
    // `hidden` emits the maps but omits the `//# sourceMappingURL` comment — a deliberate production
    // choice, and exactly what a user who cares about this would pick. Overwriting it with `true` would
    // re-add the comment and ship a pointer to maps the plugin then deletes.
    const patch = viteConfigHook({ appToken: 'tok' })({ build: { sourcemap: 'hidden' } });
    expect(patch).toBeUndefined();
  });

  it('leaves `inline` alone too', () => {
    // Inline maps are embedded in the .js; there are no .map files to upload, but overriding the user's
    // explicit choice would change what ships to their users. Nothing to do here.
    const patch = viteConfigHook({ appToken: 'tok' })({ build: { sourcemap: 'inline' } });
    expect(patch).toBeUndefined();
  });

  it('does NOTHING when the plugin is disabled — the canary', () => {
    // A disabled plugin must not alter the user's build output at all.
    const patch = viteConfigHook({ appToken: 'tok', disabled: true })({});
    expect(patch).toBeUndefined();
  });

  it('does nothing when there is no app token', () => {
    // Without a token the plugin no-ops; emitting maps the user did not ask for would be a side effect
    // with no purpose.
    const patch = viteConfigHook({})({});
    expect(patch).toBeUndefined();
  });
});
