// The webpack side of `withBugsee` (`next build --webpack`, and the default for Next <= 15). One plugin instance per
// Next compilation (client, server, edge), each doing two things for ITS OWN assets only:
//
//   1. stamp the debug-IDs inside the compilation, before anything hashes the output (Subresource Integrity), and
//   2. after emit, upload the maps of exactly the files this compilation wrote, then delete them per policy.
//
// It deliberately does not reuse the generic webpack plugin of `@bugsee/webpack-plugin`: measured against a real
// `next build`, that plugin assumes one compilation per output directory. Next's server compilation emits to
// `.next/server/chunks` with asset names like `../app/page.js` (outside its own output path), so the generic
// plugin neither stamped them (an asset name may not escape the staging directory) nor found their maps, and its
// directory-wide upload of `.next` swept up the server compilation's half-written files.
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type AssetStore,
  type ResolvedPluginOptions,
  runPluginUpload,
  stampAssets,
} from '@bugsee/bundler-plugin-core';
import { type BuildFiles, partitionBuildFiles } from './build-files';
import type { BugseeNextContext } from './context';

/** Which of Next's three webpack compilations a plugin instance serves. */
export type NextCompilationKind = 'client' | 'server' | 'edge';

/** The slice of a webpack compilation the stamp and the file list read and write. */
interface CompilationLike {
  hooks: {
    processAssets: {
      tapPromise: (options: { name: string; stage: number }, fn: () => Promise<void>) => void;
    };
  };
  getAssets(): ReadonlyArray<{ name: string }>;
  getAsset(name: string): { source: { buffer(): Buffer } } | undefined;
  updateAsset(name: string, source: unknown): void;
}

/** The slice of a webpack compiler this taps. Read from the compiler, never imported (see core's plugin.ts). */
export interface CompilerLike {
  options: { output?: { path?: string } };
  hooks: {
    thisCompilation: { tap: (name: string, fn: (compilation: CompilationLike) => void) => void };
    afterEmit: {
      tapPromise: (name: string, fn: (compilation: CompilationLike) => Promise<void>) => void;
    };
  };
  webpack?: WebpackApi;
  rspack?: WebpackApi;
}

interface WebpackApi {
  Compilation?: { PROCESS_ASSETS_STAGE_DEV_TOOLING?: number };
  sources?: { RawSource?: new (content: Buffer) => unknown };
}

/** Seams for tests. */
export interface WebpackPluginDeps {
  stamp?: typeof stampAssets;
  upload?: typeof runPluginUpload;
  /** Whether a path exists on disk (default `fs.stat`). */
  exists?: (path: string) => Promise<boolean>;
}

const PLUGIN = 'bugsee-next';
/** Stands in for each leading `../` of an asset name inside the staging directory. */
const UP = '__bugsee_up__';

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * A compilation's assets as an {@link AssetStore}. Asset names that start with `../` (Next's server output sits
 * one level above the compilation's output path) are staged under a stand-in directory, consistently for a bundle
 * and its map, so their relative layout survives and nothing can escape the staging directory.
 */
export function nextAssetStore(
  compilation: CompilationLike,
  RawSource: new (content: Buffer) => unknown,
): AssetStore {
  const staged = (name: string): string =>
    name.replace(/^(?:\.\.\/)+/, (up) => `${UP}/`.repeat(up.length / 3));
  const actual = new Map<string, string>();
  return {
    names: () => {
      actual.clear();
      for (const { name } of compilation.getAssets()) {
        actual.set(staged(name), name);
      }
      return [...actual.keys()];
    },
    read: (name) =>
      compilation.getAsset(actual.get(name) ?? name)?.source.buffer() ?? Buffer.alloc(0),
    update: (name, content) =>
      compilation.updateAsset(actual.get(name) ?? name, new RawSource(content)),
  };
}

/** The webpack plugin for one Next compilation. */
export function createNextWebpackPlugin(
  context: BugseeNextContext,
  kind: NextCompilationKind,
  deps: WebpackPluginDeps = {},
): { apply(compiler: CompilerLike): void } {
  const stamp = deps.stamp ?? stampAssets;
  const upload = deps.upload ?? runPluginUpload;
  const exists = deps.exists ?? fileExists;
  const { resolved } = context;
  // Only the browser compilation registers the build (once per `next build`), and only it follows the client
  // deletion policy: `.next/static` is public, `.next/server` is not.
  const forKind: ResolvedPluginOptions = {
    ...resolved,
    deleteMaps: kind === 'client' ? resolved.deleteMaps : context.deleteServerMaps,
    registerBuild: kind === 'client' ? resolved.registerBuild : false,
  };

  return {
    apply(compiler) {
      if (!resolved.enabled || (kind !== 'client' && !context.serverSourceMaps)) {
        return;
      }
      const api = compiler.webpack ?? compiler.rspack;
      const stage = api?.Compilation?.PROCESS_ASSETS_STAGE_DEV_TOOLING;
      const RawSource = api?.sources?.RawSource;
      // Reset per compilation: in watch mode a stamp from the previous build cannot vouch for this one.
      let preStamped = false;
      if (stage !== undefined && RawSource !== undefined) {
        compiler.hooks.thisCompilation.tap(PLUGIN, (compilation) => {
          preStamped = false;
          // One stage past the source-map plugin (500): the final bytes, before the SRI plugin hashes them.
          compilation.hooks.processAssets.tapPromise(
            { name: PLUGIN, stage: stage + 1 },
            async () => {
              try {
                await stamp(nextAssetStore(compilation, RawSource), { dryRun: resolved.dryRun });
                preStamped = true;
              } catch (error) {
                if (resolved.failOnError) {
                  throw error;
                }
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

      compiler.hooks.afterEmit.tapPromise(PLUGIN, async (compilation) => {
        const outDir = compiler.options.output?.path;
        if (typeof outDir !== 'string' || outDir === '') {
          return;
        }
        const emitted: string[] = [];
        for (const { name } of compilation.getAssets()) {
          const path = resolve(outDir, name);
          if (await exists(path)) {
            emitted.push(path);
          }
        }
        const files: BuildFiles = partitionBuildFiles(emitted);
        if (files.scripts.length === 0) {
          if (kind === 'client') {
            context.say(
              'the browser build emitted no source maps, so nothing was uploaded for it. Set `productionBrowserSourceMaps: true` (withBugsee does this unless you set it to false).',
            );
          }
          return;
        }
        await upload(forKind, outDir, {
          bundler: { isProduction: true, configuration: kind },
          preStamped,
          files,
        });
      });
    },
  };
}
