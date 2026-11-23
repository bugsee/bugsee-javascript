// `withBugsee(nextConfig, options)` — the Next.js build integration that makes `next build` upload source maps.
//
//   webpack   (`next build --webpack`; the default up to Next 15): a Bugsee plugin on each of the client, server and
//             edge compilations stamps the debug-IDs inside the build and uploads that compilation's own maps.
//   Turbopack (the default in Next 16; `next build --turbopack` before): no plugin API, so Next's
//             `compiler.runAfterProductionCompile` hook runs the stamp + upload over the written `.next`.
//
// The result composes with what the app already has: a config object, a (phase) function or an async one; the
// app's own `webpack` function, `compiler.runAfterProductionCompile`, `compiler.define` and
// `productionBrowserSourceMaps` are called, kept or extended, never replaced. Nothing runs for `next dev`.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type BugseeNextContext, createBugseeContext, type WithBugseeOptions } from './context';
import { type PostBuildMetadata, runPostBuild } from './post-build';
import { createNextWebpackPlugin, type NextCompilationKind } from './webpack-plugin';

/** The Next config shapes this accepts. Structural: `next` is not a dependency. */
// biome-ignore lint/suspicious/noExplicitAny: a user's Next config is open-ended; only the keys read below matter.
export type NextConfigObject = Record<string, any>;
export type NextConfigFunction<C extends NextConfigObject> = (
  phase: string,
  context: { defaultConfig: NextConfigObject },
) => C | Promise<C>;
export type NextConfigInput<C extends NextConfigObject> = C | Promise<C> | NextConfigFunction<C>;

/** Next's `PHASE_PRODUCTION_BUILD`. The only phase that builds anything we touch. */
const PHASE_PRODUCTION_BUILD = 'phase-production-build';
/** The first Next with `compiler.runAfterProductionCompile` that Turbopack runs (measured, see post-build.ts). */
const MIN_TURBOPACK_HOOK = [15, 4, 1] as const;

/** Seams for tests. */
export interface WithBugseeDeps {
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  /** The installed `next` version, or `undefined` when unknown. */
  nextVersion?: (projectDir: string) => string | undefined;
  createContext?: typeof createBugseeContext;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Whether `version` (`16.4.6`, `15.4.0-canary.12`) is at least `min`. Unparseable counts as new enough. */
export function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return true;
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if ((parts[i] as number) !== min[i]) {
      return (parts[i] as number) > (min[i] as number);
    }
  }
  return true;
}

/** The `version` of the `next` installed for `projectDir`. */
function installedNextVersion(projectDir: string): string | undefined {
  try {
    const require = createRequire(join(projectDir, 'package.json'));
    return (require('next/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function compilationKind(next: { isServer?: boolean; nextRuntime?: string }): NextCompilationKind {
  if (next.isServer !== true) {
    return 'client';
  }
  return next.nextRuntime === 'edge' ? 'edge' : 'server';
}

/** Build the extended config for one resolved context. */
function extendConfig<C extends NextConfigObject>(
  config: C,
  context: BugseeNextContext,
  turbopack: boolean,
  nextVersion: string | undefined,
): C {
  const { resolved } = context;
  const next: NextConfigObject = { ...config };

  // The app's version and build, baked into every bundle (browser, node, edge) for the runtime SDK to read.
  // `compiler.define` applies to all three; `defineServer` must NOT repeat the keys (measured, Next 15.5: it
  // throws "already configured"). A constant the app defined itself wins.
  const identity = resolved.identityDefines;
  if (Object.keys(identity).length > 0) {
    const compiler: NextConfigObject = { ...(config.compiler ?? {}) };
    compiler.define = { ...identity, ...(config.compiler?.define ?? {}) };
    next.compiler = compiler;
  }
  if (!resolved.enabled) {
    return next as C;
  }

  // Browser maps are what Bugsee symbolicates browser crashes with. Forced on only when nothing says otherwise,
  // and only here, where a token means they will be uploaded and then removed from `.next/static`.
  if (config.productionBrowserSourceMaps === undefined) {
    next.productionBrowserSourceMaps = true;
  }

  // webpack builds only. A `webpack` function on a Turbopack build is an ERROR in Next 16 ("a `webpack` config and
  // no `turbopack` config", measured) and a warning in 15.5, so Turbopack builds never get one from us.
  if (!turbopack) {
    const userWebpack = config.webpack as
      | ((webpackConfig: NextConfigObject, options: NextConfigObject) => unknown)
      | undefined;
    next.webpack = (webpackConfig: NextConfigObject, options: NextConfigObject) => {
      const result =
        userWebpack === undefined ? webpackConfig : userWebpack(webpackConfig, options);
      const finish = (value: unknown): NextConfigObject => {
        const out = (value ?? webpackConfig) as NextConfigObject;
        if (options.dev === true) {
          return out;
        }
        const kind = compilationKind(options);
        if (kind !== 'client' && context.serverSourceMaps && !out.devtool) {
          out.devtool = 'source-map';
        }
        out.plugins = [...(out.plugins ?? []), createNextWebpackPlugin(context, kind)];
        return out;
      };
      return isThenable(result) ? result.then(finish) : finish(result);
    };
  }

  if (turbopack) {
    if (nextVersion !== undefined && !versionAtLeast(nextVersion, MIN_TURBOPACK_HOOK)) {
      context.say(
        `Next ${nextVersion} builds with Turbopack but has no post-build hook to upload from; source maps were NOT uploaded. Upgrade to Next 15.4.1 or later, or build with webpack.`,
      );
    } else {
      const userHook = config.compiler?.runAfterProductionCompile as
        | ((metadata: PostBuildMetadata) => Promise<void>)
        | undefined;
      next.compiler = {
        ...(next.compiler ?? config.compiler ?? {}),
        runAfterProductionCompile: async (metadata: PostBuildMetadata) => {
          await userHook?.(metadata);
          await runPostBuild(context, metadata);
        },
      };
    }
  }
  return next as C;
}

/**
 * Wrap a Next config so `next build` stamps debug-IDs and uploads source maps to Bugsee.
 *
 * ```js
 * // next.config.mjs
 * import { withBugsee } from '@bugsee/nextjs/config';
 * export default withBugsee({ /* your config *\/ }, { appToken: process.env.BUGSEE_APP_TOKEN });
 * ```
 */
export function withBugsee<C extends NextConfigObject>(
  nextConfig: NextConfigInput<C> = {} as C,
  options: WithBugseeOptions = {},
  deps: WithBugseeDeps = {},
): NextConfigInput<C> {
  if (options.disabled === true) {
    return nextConfig;
  }
  const env = deps.env ?? process.env;
  const turbopack = Boolean(env.TURBOPACK);
  const apply = (config: C, phase: string | undefined): C => {
    // `next dev`, `next start` and `next export` build nothing this touches. An object config has no phase;
    // there the webpack function is gated on `dev` and the post-build hook only exists in a production build.
    if (phase !== undefined && phase !== PHASE_PRODUCTION_BUILD) {
      return config;
    }
    const projectDir = (deps.cwd ?? process.cwd)();
    const context = (deps.createContext ?? createBugseeContext)(options, projectDir, { env });
    return extendConfig(
      config,
      context,
      turbopack,
      (deps.nextVersion ?? installedNextVersion)(projectDir),
    );
  };
  if (typeof nextConfig === 'function') {
    return async (phase, context) => apply(await nextConfig(phase, context), phase);
  }
  if (isThenable(nextConfig)) {
    return Promise.resolve(nextConfig).then((config) => apply(config, undefined));
  }
  return apply(nextConfig, undefined);
}
