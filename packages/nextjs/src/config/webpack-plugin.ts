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
import { stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type AssetStore,
  type ResolvedPluginOptions,
  runPluginUpload,
  stampAssets,
} from '@bugsee/bundler-plugin-core';
import { type BuildFiles, partitionBuildFiles } from './build-files';
import type { BugseeNextContext } from './context';
import { FALLBACK_SRI_NOTICE, sriManifestNear } from './sri';

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
  getAsset(name: string):
    | {
        source: { buffer(): Buffer };
        /** `related.sourceMap` is how SourceMapDevToolPlugin records which asset is a bundle's map. */
        info?: { related?: { sourceMap?: string | string[] | null } };
      }
    | undefined;
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
  sources?: { RawSource?: new (content: string) => unknown };
}

/** Seams for tests. */
export interface WebpackPluginDeps {
  stamp?: typeof stampAssets;
  upload?: typeof runPluginUpload;
  /** Whether a path exists on disk (default `fs.stat`). */
  exists?: (path: string) => Promise<boolean>;
  /** Whether Next's integrity manifest sits next to this output (default: looks on disk). */
  hasSriManifest?: (outDir: string) => Promise<boolean>;
  /** Delete a file (default `fs.unlink`; a file that is already gone is fine). */
  remove?: (path: string) => Promise<void>;
}

const PLUGIN = 'bugsee-next';
/** A script asset, query and upper-case extension included (what the core's own plugin counts). */
const SCRIPT_ASSET = /\.[cm]?js(\?|$)/i;

/** What the in-build stamp of one compilation established. */
interface InBuildStamp {
  preStamped: boolean;
  /** The bundles it stamped and their maps, by real asset name, for the on-disk re-check. */
  stampedBundles?: string[];
  stampedMaps?: Record<string, string>;
  /** Why the in-build stamp failed, reported once the build knows what happens next (fallback or not). */
  failure?: unknown;
  /** The stamp was refused in a way that makes stamping after emit unsafe too. */
  abandoned?: boolean;
}
/** Stands in for each leading `../` of an asset name inside the staging directory. */
const UP = '__bugsee_up__';

/** Delete a file; one that is already gone is not an error. */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * An asset name without its `?query`: webpack drops `?...` when it writes a file and keeps `#` (measured on real
 * builds by the core's own asset store, which this follows).
 */
const withoutQuery = (name: string): string => name.replace(/\?.*$/, '');

/** Strict, BOM-preserving UTF-8: a lenient decode would silently corrupt an asset. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of an asset's bytes, or a refusal: bytes that are not valid UTF-8 never become a source. */
function asText(name: string, content: Buffer): string {
  try {
    return utf8.decode(content);
  } catch {
    throw new Error(`${name} is not valid UTF-8, so it cannot be stamped as a text source`);
  }
}

/** A compilation's asset table as the core's {@link AssetStore}, plus the way back to real asset names. */
export interface NextAssetStore extends AssetStore {
  /** The real asset name behind a name this store presented. */
  real(name: string): string;
}

/**
 * A compilation's assets as an {@link AssetStore}. Names are presented query-free, and a name that starts with
 * `../` (Next's server output sits one level above the compilation's output path) is staged under a stand-in
 * directory, consistently for a bundle and its map, so their relative layout survives and nothing can escape the
 * staging directory. Two assets that would collide once cleaned keep their real names.
 */
export function nextAssetStore(
  compilation: CompilationLike,
  RawSource: new (content: string) => unknown,
): NextAssetStore {
  const up = (name: string): string =>
    name.replace(/^(?:\.\.\/)+/, (dots) => `${UP}/`.repeat(dots.length / 3));
  const actual = new Map<string, string>();
  const refresh = (): void => {
    actual.clear();
    const names = compilation.getAssets().map((asset) => asset.name);
    const counts = new Map<string, number>();
    for (const name of names) {
      counts.set(up(withoutQuery(name)), (counts.get(up(withoutQuery(name))) ?? 0) + 1);
    }
    for (const name of names) {
      const clean = up(withoutQuery(name));
      actual.set(counts.get(clean) === 1 ? clean : up(name), name);
    }
  };
  const real = (name: string): string => actual.get(name) ?? name;
  return {
    names: () => {
      refresh();
      return [...actual.keys()];
    },
    read: (name) => compilation.getAsset(real(name))?.source.buffer() ?? Buffer.alloc(0),
    // A STRING source on purpose: the stamp runs before webpack's RealContentHashPlugin renames `[contenthash]`
    // chunks, and that plugin rewrites the hashed names inside string sources only. A Buffer would keep the
    // pre-rename chunk URLs (measured on real Next builds: every lazy chunk 404s, ChunkLoadError).
    // Asked by the stamp for every asset BEFORE anything is written, so a bad asset refuses the whole stamp
    // instead of leaving half of it applied.
    check: (name, content) => void asText(name, content),
    update: (name, content) =>
      compilation.updateAsset(real(name), new RawSource(asText(name, content))),
    mapOf: (name) => {
      const related = compilation.getAsset(real(name))?.info?.related?.sourceMap;
      const map = Array.isArray(related) ? related[0] : related;
      return map === undefined || map === null ? undefined : up(withoutQuery(map));
    },
    real,
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
  const hasSriManifest = deps.hasSriManifest ?? ((dir: string) => sriManifestNear(dir));
  const remove = deps.remove ?? removeFile;
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
      let state: InBuildStamp = { preStamped: false };
      if (stage !== undefined && RawSource !== undefined) {
        compiler.hooks.thisCompilation.tap(PLUGIN, (compilation) => {
          state = { preStamped: false };
          // One stage past the source-map plugin (500): the final bytes, before the SRI plugin hashes them.
          compilation.hooks.processAssets.tapPromise(
            { name: PLUGIN, stage: stage + 1 },
            async () => {
              const store = nextAssetStore(compilation, RawSource);
              try {
                const { stamped, maps, bundles } = await stamp(store, { dryRun: resolved.dryRun });
                const scripts = compilation
                  .getAssets()
                  .filter(({ name }) => SCRIPT_ASSET.test(name));
                if (bundles === 0 && scripts.length > 0) {
                  // Never claim a stamp that staged nothing while the build emitted scripts.
                  context.say(
                    `no debug-ID could be stamped inside the ${kind} build (none of its ${scripts.length} script asset(s), e.g. ${scripts[0]?.name}, matched), so stamping after emit instead.`,
                  );
                  return;
                }
                state = {
                  preStamped: true,
                  stampedBundles: stamped.map((name) => store.real(name)),
                  stampedMaps: Object.fromEntries(
                    Object.entries(maps).map(([bundle, map]) => [
                      store.real(bundle),
                      store.real(map),
                    ]),
                  ),
                };
              } catch (error) {
                if (resolved.failOnError) {
                  throw error;
                }
                // A map that cannot be stamped with its bundle (outside the output): stamping after emit would
                // half-stamp the build, so nothing is stamped or uploaded for it.
                const abandoned =
                  (error as { unreachableMap?: boolean } | null)?.unreachableMap === true;
                if (abandoned) {
                  (
                    resolved.onError ??
                    ((e: unknown) =>
                      console.warn(
                        `[bugsee] debug-IDs were NOT stamped, and stamping after emit would half-stamp this build: ${String(e)}`,
                      ))
                  )(error);
                }
                // Said at the end of the build, once it is known whether stamping after emit follows.
                state = {
                  preStamped: false,
                  ...(abandoned ? { abandoned: true } : { failure: error }),
                };
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
          // The file on disk has no `?query` (webpack drops it when it writes the file).
          const path = resolve(outDir, withoutQuery(name));
          if (await exists(path)) {
            emitted.push(path);
          }
        }
        const files: BuildFiles = partitionBuildFiles(emitted);
        // No upload will follow: the browser maps Bugsee itself turned on (the app did not ask for them) must not
        // be left in `.next/static`, which is served publicly. Only this compilation's own files, only the ones
        // Bugsee forced; maps the app enabled stay.
        // Never throws (a failed upload must not fail the build): reported, and only `failOnError` rethrows. Not on
        // a dry run, which deletes nothing (as the core's own upload never does).
        const discardForcedMaps = async (): Promise<{ removed: boolean; failed: boolean }> => {
          if (kind !== 'client' || context.forcedMaps !== true || resolved.dryRun) {
            return { removed: false, failed: false };
          }
          try {
            for (const map of [...files.maps, ...files.stylesheetMaps]) {
              await remove(map);
            }
            return { removed: true, failed: false };
          } catch (error) {
            if (resolved.failOnError) {
              throw error;
            }
            (
              resolved.onError ??
              ((e: unknown) =>
                console.warn(
                  `[bugsee] could not remove the browser source maps Bugsee turned on: ${String(e)}`,
                ))
            )(error);
            return { removed: false, failed: true };
          }
        };
        if (state.abandoned === true) {
          await discardForcedMaps();
          return;
        }
        // The in-build stamp is SRI-safe (it runs before anything hashes). Its fallback, stamping the written
        // files, is not: it would invalidate the hashes Next already pinned, and the browser would refuse the
        // scripts (measured). Nothing is rewritten, so nothing is uploaded.
        if (!state.preStamped && (context.sri === true || (await hasSriManifest(outDir)))) {
          const { removed, failed } = await discardForcedMaps();
          context.say(
            FALLBACK_SRI_NOTICE(kind, removed, { dryRun: resolved.dryRun, removalFailed: failed }),
          );
          // The CAUSE goes through onError / console.warn, never through the notice sink: `silent` mutes notices,
          // and a failure must not vanish with them.
          if (state.failure !== undefined) {
            (
              resolved.onError ??
              ((e: unknown) =>
                console.warn(`[bugsee] in-build debug-ID stamping failed: ${String(e)}`))
            )(state.failure);
          }
          return;
        }
        if (state.failure !== undefined) {
          (
            resolved.onError ??
            ((e: unknown) =>
              console.warn(
                `[bugsee] in-build debug-ID stamping failed; falling back to stamping after emit: ${String(e)}`,
              ))
          )(state.failure);
        }
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
          preStamped: state.preStamped,
          ...(state.preStamped && state.stampedBundles !== undefined
            ? { stampedBundles: state.stampedBundles, stampedMaps: state.stampedMaps }
            : {}),
          files,
        });
      });
    },
  };
}
