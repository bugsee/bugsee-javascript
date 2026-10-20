// SM-A3 — the unplugin factory. Wires each bundler's "output written" hook to the guarded upload:
// vite/rollup `writeBundle` and webpack `afterEmit`. The per-bundler entry points (@bugsee/vite-plugin,
// @bugsee/webpack-plugin) are thin wrappers over `bugseeUnplugin`. The output-dir resolver is a pure,
// tested helper; the framework hook registration is thin glue exercised by the real-build e2e (SM-B/SM-C).
import { dirname, resolve } from 'node:path';
import { createUnplugin, type UnpluginFactory, type UnpluginInstance } from 'unplugin';
import {
  APP_BUILD_DEFINE,
  APP_VERSION_DEFINE,
  type FixedIdentity,
  fixedIdentityFromDefines,
  UNBAKEABLE_IDENTITY,
} from './app-identity';
import { bakeIdentity, type ParseChunk } from './bake-identity';
import type { BundlerBuildContext } from './register-build';
import {
  type BugseePluginOptions,
  notify,
  type ResolvedIdentity,
  resolveIdentity,
  resolvePluginOptions,
  runPluginUpload,
} from './resolve';
import { type AssetStore, stampAssets } from './stamp-assets';

/** The subset of a rollup/vite output-options object we read. */
export interface OutputLike {
  dir?: string;
  file?: string;
  /** Output format (`es`, `cjs`, `iife`, `umd`, …); `es` is always strict. */
  format?: string;
  /** Whether Rollup emits `'use strict'` for the non-`es` formats (default true). */
  strict?: boolean;
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

/** The slice of a webpack 5 compilation the in-build stamp reads and writes. */
interface WebpackCompilationLike {
  hooks: {
    processAssets: {
      tapPromise: (options: { name: string; stage: number }, fn: () => Promise<void>) => void;
    };
  };
  getAssets(): ReadonlyArray<{ name: string }>;
  getAsset(name: string): { source: { buffer(): Buffer } } | undefined;
  updateAsset(name: string, source: unknown): void;
}

/** Minimal shape of the webpack compiler we tap (avoids a webpack type dependency in the core). */
interface WebpackCompilerLike {
  options: { output?: { path?: string }; mode?: string; plugins?: unknown[] };
  /** The base directory of the build (webpack's `context`, default the cwd). */
  context?: string;
  hooks: {
    afterEmit: { tapPromise: (name: string, fn: () => Promise<void>) => void };
    /** webpack 5 only. */
    thisCompilation?: {
      tap: (name: string, fn: (compilation: WebpackCompilationLike) => void) => void;
    };
  };
  /**
   * webpack 5's own API object. Read from the COMPILER, never imported: the stage constant and the
   * `RawSource` class must be the ones this compilation uses, not a second copy of webpack or
   * webpack-sources that happens to resolve from this package.
   */
  webpack?: {
    Compilation: { PROCESS_ASSETS_STAGE_DEV_TOOLING: number };
    sources: { RawSource: new (buffer: Buffer) => unknown };
    DefinePlugin?: DefinePluginCtor;
  };
  /** Rspack's own API object (webpack-compatible `DefinePlugin`). */
  rspack?: { DefinePlugin?: DefinePluginCtor };
}

/** webpack's / rspack's `DefinePlugin`, as far as the identity injection uses it. */
type DefinePluginCtor = new (
  definitions: Record<string, string>,
) => {
  apply(compiler: unknown): void;
};

/** Everything the user's own `DefinePlugin` instances (they expose `.definitions`) already define. */
function pluginDefinitions(compiler: {
  options: { plugins?: unknown[] };
}): Record<string, unknown> {
  const taken: Record<string, unknown> = {};
  for (const plugin of compiler.options.plugins ?? []) {
    const definitions = (plugin as { definitions?: unknown } | null)?.definitions;
    if (typeof definitions === 'object' && definitions !== null) {
      Object.assign(taken, definitions);
    }
  }
  return taken;
}

/**
 * What the app's own webpack/rspack config fixes for the identity constants. Without a `DefinePlugin` of the
 * bundler's own (webpack 4) nothing can be baked, so a key the user did not define is unreadable too.
 */
function webpackFixedIdentity(
  DefinePlugin: DefinePluginCtor | undefined,
  taken: Record<string, unknown>,
): FixedIdentity {
  return {
    ...(DefinePlugin === undefined ? UNBAKEABLE_IDENTITY : {}),
    ...fixedIdentityFromDefines(taken),
  };
}

/**
 * Add the app-identity constants through the bundler's own `DefinePlugin`, skipping any key the user
 * already defines so an explicit definition wins (and, being fixed, is what the upload carries too).
 */
function injectDefines(
  compiler: object,
  DefinePlugin: DefinePluginCtor | undefined,
  defines: Record<string, string>,
  taken: Record<string, unknown>,
): void {
  if (DefinePlugin === undefined) {
    return;
  }
  const free = Object.fromEntries(Object.entries(defines).filter(([key]) => !(key in taken)));
  if (Object.keys(free).length > 0) {
    new DefinePlugin(free).apply(compiler);
  }
}

/** Each identity constant with the option / variable that answers it explicitly. */
const IDENTITY_FIELDS = [
  { field: 'version', key: APP_VERSION_DEFINE, option: 'appVersion', env: 'BUGSEE_APP_VERSION' },
  { field: 'build', key: APP_BUILD_DEFINE, option: 'appBuild', env: 'BUGSEE_APP_BUILD' },
] as const;

/**
 * The notices for every constant the plugin cannot read (`null` in `fixed`) and no explicit value answered
 * (its key is then absent from `identityDefines`). The upload goes up WITHOUT that value rather than with a
 * detected one the app never reports — debug IDs still match — and the user is told how to label it. A key
 * in the user's own defines is their unreadable expression; any other was unreadable because the bundler
 * has no DefinePlugin to bake with (webpack 4), where an explicit value is not baked either.
 */
function unreadableIdentityNotices(
  fixed: FixedIdentity,
  identityDefines: Record<string, string>,
  userDefines: Record<string, unknown>,
): string[] {
  const notices: string[] = [];
  for (const { field, key, option, env } of IDENTITY_FIELDS) {
    if (fixed[field] !== null || key in identityDefines) {
      continue;
    }
    notices.push(
      key in userDefines
        ? `your own define of ${key} is not a JSON string literal the plugin can read, so the source-map ` +
            `upload carries no ${field} rather than a detected one your app does not report. Set \`${option}\` ` +
            `on the plugin (or ${env}) to the value it evaluates to.`
        : `this bundler has no DefinePlugin (webpack 4), so ${key} cannot be baked into the bundle and the ` +
            `source-map upload carries no ${field}. Define it yourself with a DefinePlugin JSON string literal, ` +
            `or set \`${option}\` on the plugin (or ${env}) and pass the same value to launch().`,
    );
  }
  return notices;
}

/** A compilation's asset table as the core's `AssetStore`. */
function webpackAssetStore(
  compilation: WebpackCompilationLike,
  RawSource: new (buffer: Buffer) => unknown,
): AssetStore {
  return {
    names: () => compilation.getAssets().map((asset) => asset.name),
    read: (name) => compilation.getAsset(name)?.source.buffer() ?? Buffer.alloc(0),
    update: (name, content) => compilation.updateAsset(name, new RawSource(content)),
  };
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

  // The app identity comes from the BUNDLER's project directory (Vite `root`, webpack `context`, esbuild
  // `absWorkingDir`), which the hooks report; `projectRoot` is for VCS only. ONE resolution per build feeds
  // both the baked `define`s and the upload / registration, so the two cannot disagree. A bundler with no
  // such hook (Rollup) resolves lazily from the output directory upward, as `package_id` does, once per
  // directory: the chunk it bakes and the upload for that directory use the same answer. A constant the
  // user's own config already defines is `fixed` (see FixedIdentity), so the upload matches what the app reads.
  // A constant it cannot read is reported (once per build configuration) when there is an upload to label.
  let bundlerIdentity: ResolvedIdentity | undefined;
  const identityFromRoot = (
    root: string | undefined,
    fixed: FixedIdentity,
    userDefines: Record<string, unknown>,
  ): ResolvedIdentity => {
    bundlerIdentity = resolveIdentity(options, process.env, root, {}, fixed);
    if (resolved.enabled) {
      unreadableIdentityNotices(fixed, bundlerIdentity.identityDefines, userDefines).forEach(
        notify(resolved),
      );
    }
    return bundlerIdentity;
  };
  const unbakedOutDirs = new Set<string>();
  const identityByOutDir = new Map<string, ResolvedIdentity>();
  const identityForOutput = (outDir: string): ResolvedIdentity => {
    if (bundlerIdentity !== undefined) {
      return bundlerIdentity;
    }
    let identity = identityByOutDir.get(outDir);
    if (identity === undefined) {
      // Starting inside build output, a `{"type":"commonjs"}` marker there is not the app's manifest.
      identity = resolveIdentity(options, process.env, outDir, { skipMarkers: true });
      identityByOutDir.set(outDir, identity);
    }
    return identity;
  };
  const forOutput = (outDir: string): typeof resolved => ({
    ...resolved,
    ...identityForOutput(outDir),
  });

  // What the bundler says about THIS build — whether it is production, and the configuration's name.
  // Vite states it in `configResolved`, before any output is written; Rollup states nothing, and the
  // run then falls back to NODE_ENV. It decides whether the build registers (register-build.ts).
  let viteBuild: BundlerBuildContext = {};

  const uploadForOutput = async (
    output: OutputLike,
    bundler: BundlerBuildContext,
  ): Promise<void> => {
    const outDir = resolveOutputDir(output);
    if (outDir !== undefined) {
      await runPluginUpload(forOutput(outDir), outDir, { bundler });
    }
  };

  return {
    name,
    // rollup/vite hand us the output options; upload after the bundle is on disk.
    vite: {
      /**
       * Ensure the build actually EMITS the maps this plugin exists to upload.
       *
       * Vite's `build.sourcemap` defaults to `false`, and nothing here inspected it — so the documented
       * setup (`plugins: [bugseeVitePlugin({ appToken })]` on an ordinary config) drove `bugsee-cli`
       * against a `dist` with no `.map` files at all. Real bugsee-cli v0.7.2 exits 10 on that input, "no
       * .map source-map files found", which used to abort the build and now merely means the
       * feature silently does nothing.
       *
       * Returning a PARTIAL config is Vite's own merge protocol — it is deep-merged over the user's, so
       * everything else they set is untouched. Only the default and an explicit `false` are overridden:
       * `'hidden'` and `'inline'` are deliberate production choices, and replacing them would change what
       * ships to the user's own users.
       */
      config(config: {
        root?: string;
        build?: { sourcemap?: boolean | string };
        define?: Record<string, unknown>;
      }) {
        // The app's version/build go in whenever one was found, token or not (`identityDefines` is empty
        // when `disabled`, so a disabled plugin still alters nothing). A key the user defines themselves
        // is left alone. Vite resolves a relative `root` against the cwd, so this does too.
        const { identityDefines } = identityFromRoot(
          config.root !== undefined && config.root !== '' ? resolve(config.root) : undefined,
          fixedIdentityFromDefines(config.define),
          config.define ?? {},
        );
        const define = Object.fromEntries(
          Object.entries(identityDefines).filter(
            ([key]) => config.define === undefined || !(key in config.define),
          ),
        );
        const current = config.build?.sourcemap;
        const wantMaps = resolved.enabled && (current === undefined || current === false);
        if (!wantMaps && Object.keys(define).length === 0) {
          return undefined;
        }
        return {
          ...(wantMaps ? { build: { sourcemap: true } } : {}),
          ...(Object.keys(define).length > 0 ? { define } : {}),
        };
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
    rollup: {
      // Rollup has no `define`: bake the constants into each rendered chunk (with a source map), from the same
      // per-output-directory identity the upload uses. Rollup's own parser finds the real references, so a
      // string, template or comment that merely spells the name is never rewritten.
      renderChunk(
        this: { parse?: ParseChunk; warn?: (message: string) => void } | undefined,
        code: string,
        _chunk: unknown,
        output: OutputLike,
      ) {
        const outDir = resolveOutputDir(output);
        if (outDir === undefined) {
          return null;
        }
        const parse = this?.parse;
        return bakeIdentity(
          code,
          identityForOutput(outDir).identityDefines,
          parse === undefined ? undefined : (chunk) => parse.call(this, chunk),
          (reason) => {
            // Said once per output directory: every chunk of a build would otherwise repeat it.
            if (!unbakedOutDirs.has(outDir)) {
              unbakedOutDirs.add(outDir);
              this?.warn?.(
                `[bugsee] The app version/build were NOT baked into ${outDir}: ${reason}. ` +
                  'Reads of __BUGSEE_APP_VERSION__ / __BUGSEE_APP_BUILD__ in that output stay unreplaced.',
              );
            }
          },
          output.format === 'es' || output.strict !== false,
        );
      },
      // A watch rebuild is a new build: warn again if it is again not baked.
      buildStart() {
        unbakedOutDirs.clear();
      },
      writeBundle: (output: OutputLike) => uploadForOutput(output, {}),
    },
    esbuild: {
      // esbuild's `define` is a plain string map; a key the user already set is kept.
      config(initialOptions: { define?: Record<string, string>; absWorkingDir?: string }) {
        const { identityDefines } = identityFromRoot(
          initialOptions.absWorkingDir,
          fixedIdentityFromDefines(initialOptions.define),
          initialOptions.define ?? {},
        );
        const define = { ...identityDefines, ...initialOptions.define };
        if (Object.keys(define).length > 0) {
          initialOptions.define = define;
        }
      },
    },
    rspack(compiler: WebpackCompilerLike) {
      const DefinePlugin = compiler.rspack?.DefinePlugin;
      const taken = pluginDefinitions(compiler);
      const { identityDefines } = identityFromRoot(
        compiler.context,
        webpackFixedIdentity(DefinePlugin, taken),
        taken,
      );
      injectDefines(compiler, DefinePlugin, identityDefines, taken);
    },
    webpack(compiler: WebpackCompilerLike) {
      const DefinePlugin = compiler.webpack?.DefinePlugin;
      const taken = pluginDefinitions(compiler);
      const { identityDefines } = identityFromRoot(
        compiler.context,
        webpackFixedIdentity(DefinePlugin, taken),
        taken,
      );
      injectDefines(compiler, DefinePlugin, identityDefines, taken);
      // Whether THIS compilation's bundles were stamped in the build. Reset per compilation, so in
      // watch mode a stamp from the previous build cannot vouch for this one.
      let preStamped = false;

      // THE SRI FIX. On webpack 5, stamp the debug-ids
      // INSIDE the compilation, at a stage after the maps exist and before any integrity hash is
      // taken: SourceMapDevToolPlugin emits maps at PROCESS_ASSETS_STAGE_DEV_TOOLING (500, after
      // minification at 400), and webpack-subresource-integrity hashes at
      // PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE (700). One stage past 500 sees the final bytes, and the
      // SRI plugin then hashes the STAMPED bytes — for the HTML and for the lazy-chunk `sriHashes`
      // table it writes into the runtime chunk alike. Nothing is rewritten after emit.
      const api = compiler.webpack;
      const thisCompilation = compiler.hooks.thisCompilation;
      if (resolved.enabled && api !== undefined && thisCompilation !== undefined) {
        thisCompilation.tap(name, (compilation) => {
          preStamped = false;
          compilation.hooks.processAssets.tapPromise(
            { name, stage: api.Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING + 1 },
            async () => {
              try {
                await stampAssets(webpackAssetStore(compilation, api.sources.RawSource), {
                  dryRun: resolved.dryRun,
                });
                // True on a dry run too: the preview must follow the path the real run takes, and the
                // real run would not refuse an SRI build — it would stamp it here.
                preStamped = true;
              } catch (error) {
                if (resolved.failOnError) {
                  throw error;
                }
                // Contained, and NOT silent about what happens next: the post-emit path takes over,
                // and it still carries the SRI refusal, so a failed in-build stamp degrades to the old
                // safe behaviour rather than to an unchecked page.
                (
                  resolved.onError ??
                  ((e: unknown) =>
                    console.warn(
                      `[bugsee] in-build debug-ID stamping failed; falling back to stamping after emit: ${String(e)}`,
                    ))
                )(error);
              }
            },
          );
        });
      }

      compiler.hooks.afterEmit.tapPromise(name, async () => {
        const dir = compiler.options.output?.path;
        if (typeof dir === 'string' && dir !== '') {
          await runPluginUpload(forOutput(dir), dir, {
            bundler: webpackBuild(compiler.options.mode),
            preStamped,
          });
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
