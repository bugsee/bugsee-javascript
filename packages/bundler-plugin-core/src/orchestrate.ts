// SM-A2 — orchestrate a source-map upload by driving `bugsee-cli`: inject debug-IDs, upload the maps, then
// delete the client `.map` files (privacy). Each side-effecting step is behind an injectable seam so the
// orchestration is unit-tested without a real binary or filesystem.
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunBugseeCliOptions, runBugseeCli, type SpawnResult } from './run-cli';
import { findSriProtectedScripts, type SriProtectedScript } from './sri';
import type { VcsMetadata } from './vcs';

/** The `runBugseeCli` shape, injectable for tests. */
export type RunFn = (args: string[], options: RunBugseeCliOptions) => Promise<SpawnResult>;

export interface UploadSourcemapsOptions {
  /** Build output directory containing the `.js` + `.js.map` files. */
  outDir: string;
  /** Bugsee app token (required — forwarded to `bugsee-cli`). */
  appToken: string;
  /** App version (`--version`). */
  appVersion: string;
  /** Build number (`--build`). */
  appBuild: string;
  /** API endpoint override (`--endpoint`). */
  endpoint?: string;
  /** Delete client `.map` files after upload. Default `true` (privacy). */
  deleteMaps?: boolean;
  /** Pass `--dry-run` to the CLI + skip deletion. */
  dryRun?: boolean;
  /** Injectable `bugsee-cli` runner (default {@link runBugseeCli}). */
  run?: RunFn;
  /** Injectable `.map` deleter (default {@link defaultDeleteMapFiles}). */
  deleteMapFiles?: (dir: string) => Promise<string[]>;
  /** Injectable SRI scan (default {@link findSriProtectedScripts}). */
  findSri?: (dir: string) => Promise<SriProtectedScript[]>;
  /**
   * FAIL the build when `bugsee-cli` fails. Default `false` (Wave 7).
   *
   * A telemetry side effect must not be able to break a production deploy: an expired token, a transient
   * network error, a Bugsee outage or a binary missing from PATH used to reject `writeBundle` and abort the
   * user's build, with no escape hatch at all. `@sentry/webpack-plugin` ships `errorHandler` for exactly
   * this reason. Teams that WANT a hard failure opt in.
   */
  failOnError?: boolean;
  /** Where a contained failure is reported. Default: a console warning naming the plugin. */
  onError?: (error: unknown) => void;
  /**
   * The build's VCS metadata, already collected by the caller (SM-A4).
   *
   * Data, not policy: collection is the context-gathering layer's job (`resolve.ts`), this layer only
   * drives `bugsee-cli`. Carried here because this is where it will be handed to the CLI once the
   * upload wire protocol has a field to put it in — see docs/design/source-maps.md §9.
   */
  vcs?: VcsMetadata;
}

export interface UploadSourcemapsResult {
  injected: boolean;
  uploaded: boolean;
  deletedMaps: string[];
  /** Echo of the collected VCS metadata; absent when none was captured. */
  vcs?: VcsMetadata;
}

/**
 * Directories never descended into when deleting `.map` files (Wave 7).
 *
 * A relative `output.file` resolves the output dir to `'.'` — `path.dirname('bundle.js') === '.'`, an
 * entirely ordinary Rollup library config — so the walk started at the PROJECT ROOT. With no exclusions it
 * unlinked dependency source maps under `node_modules/` (breaking debugging until a reinstall) and a
 * developer's own authored maps under `src/`. Silent, unrecoverable loss in the working tree, on by default.
 */
const NEVER_WALK = new Set([
  'node_modules',
  'src',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'test',
  'tests',
  '__tests__',
]);

/**
 * Depth limit for the walk. Build output is shallow (`dist/assets/chunk.js.map` is 2); an unbounded walk
 * from a mis-resolved root could traverse an entire disk.
 */
const MAX_DELETE_DEPTH = 6;

/** Recursively delete every build `*.map` under `dir`; returns the deleted paths. */
export async function defaultDeleteMapFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DELETE_DEPTH) {
    return [];
  }
  const deleted: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skipped by NAME at every level, not just the root: a mis-resolved out dir puts these one level
      // down, which is exactly the case that caused the loss.
      if (NEVER_WALK.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      deleted.push(...(await defaultDeleteMapFiles(full, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      await unlink(full);
      deleted.push(full);
    }
  }
  return deleted;
}

/** Drive `bugsee-cli`: inject debug-IDs into the build, upload the source-maps, then delete the client maps. */
export async function uploadSourcemaps(
  options: UploadSourcemapsOptions,
): Promise<UploadSourcemapsResult> {
  const { outDir, appToken, appVersion, appBuild, endpoint, dryRun = false } = options;
  // Echoed on every RETURNING path, including the contained failure: what the plugin captured is a fact
  // about the build, independent of whether the upload that would carry it succeeded. (The two paths
  // that THROW — an empty token, and a `failOnError` rethrow — carry no result object to echo on.)
  const vcsEcho = options.vcs !== undefined ? { vcs: options.vcs } : {};
  if (appToken === '') {
    throw new Error('uploadSourcemaps: appToken is required');
  }
  const run = options.run ?? runBugseeCli;
  const deleteMaps = options.deleteMaps ?? true;
  const dryFlag = dryRun ? ['--dry-run'] : [];
  const cliOptions: RunBugseeCliOptions = { token: appToken, endpoint };
  const onError =
    options.onError ??
    ((error: unknown): void => {
      console.warn(`[bugsee] source-map upload skipped: ${String(error)}`);
    });

  try {
    // 0. Refuse outright if the build pins its own script hashes. `sourcemaps inject` appends bytes
    //    to every emitted `.js`, and a hash computed during emit is already in the HTML — measured on
    //    webpack 5.111 + webpack-subresource-integrity in Chromium 151: after stamping, the entry
    //    script is BLOCKED and the page runs nothing. Losing symbolication on this build is
    //    survivable; shipping a page that does not load is not. Checked BEFORE anything is written,
    //    so a refusal leaves the build exactly as the bundler emitted it.
    const pinned = await (options.findSri ?? findSriProtectedScripts)(outDir);
    if (pinned.length > 0) {
      const [first] = pinned as [SriProtectedScript, ...SriProtectedScript[]];
      throw new Error(
        `refusing to stamp debug-IDs: this build uses Subresource Integrity — ${first.html} pins a ` +
          `hash of ${first.script}` +
          (pinned.length > 1 ? ` (and ${pinned.length - 1} more)` : '') +
          `. Injecting a debug-ID rewrites that file, so the browser would refuse to run it and the ` +
          `page would load nothing. Source maps were NOT uploaded. See ` +
          `https://github.com/bugsee/bugsee-javascript/blob/main/docs/design/source-maps.md#subresource-integrity`,
      );
    }

    // 1. Inject debug-IDs (rewrites the built .js + .map in place).
    await run(['sourcemaps', 'inject', outDir, ...dryFlag], cliOptions);

    // 2. Upload the maps, keyed by the injected debug-ID (+ version/build metadata).
    //
    // SKIPPED entirely on a dry run (Wave 7). `sourcemaps inject --dry-run` writes nothing by design, so
    // the maps still carry no debug_id and `debug-files upload --dry-run` then hard-fails — measured
    // against the real bugsee-cli v0.7.2: exit 11, "source map has no debug_id … run 'sourcemaps inject'
    // first". That failure aborted the user's build, on every freshly-built output directory, from the one
    // option documented as the SAFE diagnostic.
    if (dryRun) {
      return { injected: true, uploaded: false, deletedMaps: [], ...vcsEcho };
    }
    // `--allow-empty` (bugsee-cli >= 0.7.10): an output directory with no maps is a legitimate build
    // shape — a monorepo package built without them, a framework whose server output has none — and
    // the CLI otherwise exits 10 on it. Under `failOnError` it is NOT passed: a team that asked for
    // strictness wants "this build produced no maps at all" to stop the build, which is exactly the
    // misconfiguration that silently costs them symbolication later.
    const emptyFlag = options.failOnError === true ? [] : ['--allow-empty'];
    await run(
      [
        'debug-files',
        'upload',
        outDir,
        '--type',
        'sourcemaps',
        '--version',
        appVersion,
        '--build',
        appBuild,
        ...emptyFlag,
      ],
      cliOptions,
    );

    // 3. Delete the client .map files (privacy) — only after a CONFIRMED upload. Deleting after a failure
    //    would destroy the only copy of the mapping while the symbols were never delivered.
    const deletedMaps = deleteMaps
      ? await (options.deleteMapFiles ?? defaultDeleteMapFiles)(outDir)
      : [];
    return { injected: true, uploaded: true, deletedMaps, ...vcsEcho };
  } catch (error) {
    // A telemetry side effect must not break a production deploy (Wave 7). Reported, never swallowed;
    // `failOnError` is there for teams that would rather the build stopped.
    if (options.failOnError === true) {
      throw error;
    }
    onError(error);
    return { injected: false, uploaded: false, deletedMaps: [], ...vcsEcho };
  }
}
