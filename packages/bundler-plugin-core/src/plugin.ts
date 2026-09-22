// SM-A3 — the unplugin factory. Wires each bundler's "output written" hook to the guarded upload:
// vite/rollup `writeBundle` and webpack `afterEmit`. The per-bundler entry points (@bugsee/vite-plugin,
// @bugsee/webpack-plugin) are thin wrappers over `bugseeUnplugin`. The output-dir resolver is a pure,
// tested helper; the framework hook registration is thin glue exercised by the real-build e2e (SM-B/SM-C).
import { dirname } from 'node:path';
import { createUnplugin, type UnpluginFactory, type UnpluginInstance } from 'unplugin';
import type { BundlerBuildContext } from './register-build';
import { type BugseePluginOptions, resolvePluginOptions, runPluginUpload } from './resolve';

/** The subset of a rollup/vite output-options object we read. */
export interface OutputLike {
  dir?: string;
  file?: string;
}

/** Resolve the build output directory from a rollup/vite output-options object. */
export function resolveOutputDir(output: OutputLike): string | undefined {
  if (output.dir !== undefined && output.dir !== '') {
    return output.dir;
  }
  if (output.file !== undefined && output.file !== '') {
    return dirname(output.file);
  }
  return undefined;
}

/** Minimal shape of the webpack compiler we tap (avoids a webpack type dependency in the core). */
interface WebpackCompilerLike {
  options: { output?: { path?: string }; mode?: string };
  hooks: { afterEmit: { tapPromise: (name: string, fn: () => Promise<void>) => void } };
}

/**
 * webpack's own answer to "is this a production build". It never writes its default back, so
 * `options.mode` stays undefined for a config that set none, yet webpack BUILDS that as production:
 * `const production = mode === "production" || !mode` (lib/config/defaults.js). Mirrored exactly, so
 * the plugin agrees with what webpack actually emitted.
 */
function webpackBuild(mode: string | undefined): BundlerBuildContext {
  const effective = mode === undefined || mode === '' ? 'production' : mode;
  return { isProduction: effective === 'production', configuration: effective };
}

export const bugseeUnpluginFactory: UnpluginFactory<BugseePluginOptions | undefined> = (
  options = {},
) => {
  const resolved = resolvePluginOptions(options, process.env);
  const name = 'bugsee';

  // What the bundler says about THIS build — whether it is production, and the configuration's name.
  // Vite states it in `configResolved`, before any output is written; Rollup states nothing, and the
  // run then falls back to NODE_ENV. It decides whether the build registers (register-build.ts, D2).
  let viteBuild: BundlerBuildContext = {};

  const uploadForOutput = async (
    output: OutputLike,
    bundler: BundlerBuildContext,
  ): Promise<void> => {
    const outDir = resolveOutputDir(output);
    if (outDir !== undefined) {
      await runPluginUpload(resolved, outDir, { bundler });
    }
  };

  return {
    name,
    // rollup/vite hand us the output options; upload after the bundle is on disk.
    vite: {
      /**
       * Ensure the build actually EMITS the maps this plugin exists to upload (Wave 7.6).
       *
       * Vite's `build.sourcemap` defaults to `false`, and nothing here inspected it — so the documented
       * setup (`plugins: [bugseeVitePlugin({ appToken })]` on an ordinary config) drove `bugsee-cli`
       * against a `dist` with no `.map` files at all. Real bugsee-cli v0.7.2 exits 10 on that input, "no
       * .map source-map files found", which used to abort the build and now (Wave 7.3) merely means the
       * feature silently does nothing.
       *
       * Returning a PARTIAL config is Vite's own merge protocol — it is deep-merged over the user's, so
       * everything else they set is untouched. Only the default and an explicit `false` are overridden:
       * `'hidden'` and `'inline'` are deliberate production choices, and replacing them would change what
       * ships to the user's own users.
       */
      config(config: { build?: { sourcemap?: boolean | string } }) {
        if (!resolved.enabled) {
          return undefined; // a disabled plugin must not alter the build at all
        }
        const current = config.build?.sourcemap;
        if (current === undefined || current === false) {
          return { build: { sourcemap: true } };
        }
        return undefined;
      },
      /**
       * `isProduction`, not `mode === 'production'`: `vite build --mode staging` is a production build.
       * Vite defaults NODE_ENV to `production` for `vite build` whatever the mode, unless NODE_ENV was
       * already set or the mode's `.env` sets `development`, and `isProduction` is exactly
       * `NODE_ENV === 'production'` after that. A mode-name check would skip every staging release.
       * The mode is still what names the configuration.
       */
      configResolved(config: { isProduction: boolean; mode: string }) {
        viteBuild = { isProduction: config.isProduction, configuration: config.mode };
      },
      writeBundle: (output: OutputLike) => uploadForOutput(output, viteBuild),
    },
    rollup: { writeBundle: (output: OutputLike) => uploadForOutput(output, {}) },
    webpack(compiler: WebpackCompilerLike) {
      compiler.hooks.afterEmit.tapPromise(name, async () => {
        const dir = compiler.options.output?.path;
        if (typeof dir === 'string' && dir !== '') {
          await runPluginUpload(resolved, dir, { bundler: webpackBuild(compiler.options.mode) });
        }
      });
    },
  };
};

export const bugseeUnplugin: UnpluginInstance<BugseePluginOptions | undefined> =
  createUnplugin(bugseeUnpluginFactory);

// Convenience per-bundler factories over the same core. `@bugsee/vite-plugin` / `@bugsee/webpack-plugin`
// ship the two most common ones as their own packages; these cover the esbuild-based toolchains (Angular 17+,
// Bun where its plugin hooks suffice), Rollup (Vite/meta-frameworks internals), and Rspack. Any other target
// (Deno, tsc/swc, or a build with no plugin hook) uses the standalone `bugsee-cli` post-build step instead.
export const bugseeRollupPlugin = bugseeUnplugin.rollup;
export const bugseeEsbuildPlugin = bugseeUnplugin.esbuild;
export const bugseeRspackPlugin = bugseeUnplugin.rspack;
