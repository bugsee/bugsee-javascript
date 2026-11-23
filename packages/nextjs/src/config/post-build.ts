// The Turbopack side of `withBugsee`. Turbopack has no plugin API, so the upload runs from Next's own
// `compiler.runAfterProductionCompile` hook: after the bundler finished writing `.next` and before Next generates
// the static pages. Everything the hook needs is on disk by then, so this stamps the debug-IDs into the written
// bundles (the real `bugsee-cli sourcemaps inject`, with the same verify-and-restore the post-emit path has),
// uploads the maps and deletes them per policy.
//
// What it cannot do is stamp a build that pins Subresource Integrity (`experimental.sri`): Turbopack writes the
// hashes BEFORE this hook runs (measured, Next 16.4.6: appending a byte to a chunk in the hook makes every
// `integrity` the page carries wrong), so stamping afterwards would ship a page whose scripts the browser
// refuses to run. That build is left exactly as Next wrote it, and the notice says why.
import { join, resolve } from 'node:path';
import { type ResolvedPluginOptions, runPluginUpload } from '@bugsee/bundler-plugin-core';
import { type BuildFiles, collectBuildFiles } from './build-files';
import type { BugseeNextContext } from './context';
import { isFile, SRI_MANIFEST, TURBOPACK_SRI_NOTICE } from './sri';

/** What Next hands `compiler.runAfterProductionCompile`. */
export interface PostBuildMetadata {
  projectDir: string;
  distDir: string;
}

/** Seams for tests. */
export interface PostBuildDeps {
  upload?: typeof runPluginUpload;
  collect?: (dir: string) => Promise<BuildFiles>;
  exists?: (path: string) => Promise<boolean>;
}

/** Stamp, upload and delete for a finished Turbopack build. Skips (and says why) when it cannot be done safely. */
export async function runPostBuild(
  context: BugseeNextContext,
  metadata: PostBuildMetadata,
  deps: PostBuildDeps = {},
): Promise<void> {
  const { resolved } = context;
  if (!resolved.enabled) {
    return;
  }
  // Next rethrows whatever this hook throws and fails the build, so a telemetry step must not throw (an unreadable
  // bundle, a full disk): it is reported, and only `failOnError` lets it stop the build.
  try {
    await postBuild(context, metadata, deps);
  } catch (error) {
    if (resolved.failOnError) {
      throw error;
    }
    (
      resolved.onError ??
      ((e: unknown) => console.warn(`[bugsee] source-map upload skipped: ${String(e)}`))
    )(error);
  }
}

async function postBuild(
  context: BugseeNextContext,
  metadata: PostBuildMetadata,
  deps: PostBuildDeps,
): Promise<void> {
  const { resolved } = context;
  const upload = deps.upload ?? runPluginUpload;
  const collect = deps.collect ?? collectBuildFiles;
  const exists = deps.exists ?? isFile;
  const distDir = resolve(metadata.projectDir, metadata.distDir);

  if (context.sri === true || (await exists(join(distDir, SRI_MANIFEST)))) {
    context.say(TURBOPACK_SRI_NOTICE);
    return;
  }

  const client = await collect(join(distDir, 'static'));
  const server = context.serverSourceMaps ? await collect(join(distDir, 'server')) : undefined;
  if (client.scripts.length === 0) {
    context.say(
      'the browser build emitted no source maps, so nothing was uploaded for it. Set `productionBrowserSourceMaps: true` (withBugsee does this unless you set it to false).',
    );
  }

  const shared = (client.shared?.length ?? 0) + (server?.shared?.length ?? 0);
  if (shared > 0) {
    context.say(
      `${shared} bundle(s) share one source map with another bundle (Next 15's Turbopack does this for its runtime chunks), so they were left unstamped: a map carries one debug-ID.`,
    );
  }

  const bundler = { isProduction: true, configuration: 'production' };
  const runFor = async (
    dir: string,
    files: BuildFiles,
    options: Partial<ResolvedPluginOptions>,
  ): Promise<void> => {
    if (files.scripts.length === 0) {
      return;
    }
    await upload({ ...resolved, ...options }, dir, { bundler, files });
  };
  // Browser first (it registers the build once); the server and edge output follows its own deletion policy.
  await runFor(join(distDir, 'static'), client, {});
  if (server !== undefined) {
    await runFor(join(distDir, 'server'), server, {
      deleteMaps: context.deleteServerMaps,
      registerBuild: false,
    });
  }
}
