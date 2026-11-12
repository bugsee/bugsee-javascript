// SM-A2 — orchestrate a source-map upload by driving `bugsee-cli`: inject debug-IDs, upload the maps, then
// delete the client `.map` files (privacy). Each side-effecting step is behind an injectable seam so the
// orchestration is unit-tested without a real binary or filesystem.
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunBugseeCliOptions, runBugseeCli, type SpawnResult } from './run-cli';
import { findIntegrityMismatches, findSriProtectedScripts, type SriProtectedScript } from './sri';
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
  /**
   * Upload source maps WITHOUT their embedded `sourcesContent` (bugsee-cli >= 0.7.11).
   *
   * The map's `sourcesContent` is your source verbatim, and it is what lets a symbolicated crash show
   * source lines. Stripping it keeps file/line/column resolution and drops the snippet, for teams who
   * would rather their code did not leave the build machine. The maps on disk are not modified.
   */
  stripSourcesContent?: boolean;
  /** Injectable `bugsee-cli` runner (default {@link runBugseeCli}). */
  run?: RunFn;
  /**
   * Injectable `.map` deleter (default {@link defaultDeleteMapFiles}). `only` is the set of maps that existed
   * when the upload started: maps another build wrote into the same directory while the upload was in flight
   * were never sent and must not be deleted.
   */
  deleteMapFiles?: (dir: string, only?: readonly string[]) => Promise<string[]>;
  /**
   * The build's OWN output files, when the caller knows them (esbuild's metafile). The CLI is then given exactly
   * these paths instead of the directory, and exactly these maps are deleted, only after a confirmed upload.
   * Nothing walks the directory, so a build can never touch (stamp, upload under its own options, or delete) a
   * file another build wrote there. `scripts` are the `.js`/`.mjs`/`.cjs` outputs, `maps` the `.map` outputs.
   */
  files?: {
    scripts: readonly string[];
    maps: readonly string[];
    /** Maps the CLI is not given (stylesheet maps); deleted with `maps`, only after a confirmed upload. */
    stylesheetMaps?: readonly string[];
  };
  /** Injectable `.map` lister for the delete snapshot of a directory run (default {@link listMapFiles}). */
  listMapFiles?: (dir: string) => Promise<string[]>;
  /** Injectable SRI scan (default {@link findSriProtectedScripts}). */
  findSri?: (dir: string) => Promise<SriProtectedScript[]>;
  /**
   * The bundles were already stamped INSIDE the build (stamp-assets.ts), before any SRI plugin took
   * its hashes. Skips `sourcemaps inject` — nothing is rewritten after emit — and with it the SRI
   * refusal, which exists only to protect a page from that rewrite. Runs {@link verifySri} instead.
   */
  preStamped?: boolean;
  /** Injectable integrity check for the pre-stamped path (default {@link findIntegrityMismatches}). */
  verifySri?: (dir: string) => Promise<SriProtectedScript[]>;
  /**
   * FAIL the build when `bugsee-cli` fails. Default `false`.
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
   * upload wire protocol has a field to put it in.
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
 * Directories never descended into when deleting `.map` files.
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

/** Paths per CLI call: keeps a build with thousands of outputs under the OS command-line length limit. */
export const MAX_PATHS_PER_CALL = 200;
function inBatches<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_PATHS_PER_CALL) {
    batches.push(items.slice(i, i + MAX_PATHS_PER_CALL));
  }
  return batches;
}

/** Recursively list every build `*.map` under `dir`. */
export async function listMapFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DELETE_DEPTH) {
    return [];
  }
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skipped by NAME at every level, not just the root: a mis-resolved out dir puts these one level
      // down, which is exactly the case that caused the loss.
      if (NEVER_WALK.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      found.push(...(await listMapFiles(full, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Delete build `*.map` files under `dir`; returns the deleted paths. With `only`, just those (already
 * listed, so the same exclusions applied); a file that is already gone is not an error.
 */
export async function defaultDeleteMapFiles(
  dir: string,
  only?: readonly string[],
): Promise<string[]> {
  const targets = only ?? (await listMapFiles(dir));
  const deleted: string[] = [];
  for (const full of targets) {
    try {
      await unlink(full);
      deleted.push(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return deleted;
}

/** Where a contained upload failure goes when the user gave no `onError`. */
function defaultUploadErrorHandler(error: unknown): void {
  console.warn(`[bugsee] source-map upload skipped: ${String(error)}`);
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
  const files = options.files;
  const deleteMaps = options.deleteMaps ?? true;
  const dryFlag = dryRun ? ['--dry-run'] : [];
  const cliOptions: RunBugseeCliOptions = { token: appToken, endpoint };
  const onError = options.onError ?? defaultUploadErrorHandler;

  try {
    if (options.preStamped === true) {
      // 0'. Stamped in the build, so this run rewrites nothing and cannot break SRI. What it CAN do is
      //     notice that the build broke itself: a plugin that hashed BEFORE the stamp pinned bytes the
      //     page no longer has. Refusing is too late — the files are written — so the value is in
      //     saying so, loudly, rather than shipping a page that loads nothing without a word.
      const broken = await (options.verifySri ?? findIntegrityMismatches)(outDir);
      if (broken.length > 0) {
        const [first] = broken as [SriProtectedScript, ...SriProtectedScript[]];
        const error = new Error(
          `${first.script} no longer matches the integrity hash ${first.html} pins` +
            (broken.length > 1 ? ` (and ${broken.length - 1} more)` : '') +
            `, so the browser will refuse to run it. Bugsee stamps debug-IDs inside the build at ` +
            `PROCESS_ASSETS_STAGE_DEV_TOOLING + 1, before webpack-subresource-integrity hashes at ` +
            `PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE; a plugin that hashes EARLIER than that sees the ` +
            `bytes before the stamp. Move that plugin's hashing later, or disable this plugin for this build.`,
        );
        if (options.failOnError === true) {
          throw error;
        }
        // Reported, and the upload goes on: the maps are correct and still worth having — it is the
        // page that is broken, not them. NOT through the default `onError` wording, which says the
        // upload was skipped; here it was not.
        (options.onError ?? ((e: unknown) => console.warn(`[bugsee] ${String(e)}`)))(error);
      }
    } else {
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
      if (files === undefined) {
        await run(['sourcemaps', 'inject', outDir, ...dryFlag], cliOptions);
      } else {
        // A script and its map may land in different batches: harmless, the debug-id is derived from the
        // bundle's content, so each side stamps the same id (measured with 250 entries, none mismatched).
        for (const batch of inBatches([...files.scripts, ...files.maps])) {
          await run(['sourcemaps', 'inject', ...batch, ...dryFlag], cliOptions);
        }
      }
    }

    // 2. Upload the maps, keyed by the injected debug-ID (+ version/build metadata).
    //
    // A dry run goes through this step too, as of bugsee-cli 0.7.11. It used to be skipped:
    // `sourcemaps inject --dry-run` writes nothing by design, so no map carried a debug_id and
    // `debug-files upload --dry-run` hard-failed on the first one (measured against v0.7.2: exit 11,
    // "source map has no debug_id … run 'sourcemaps inject' first"). Skipping it meant the one option
    // documented as the SAFE diagnostic never exercised the upload path at all. The CLI now reports
    // such a map and counts it (`unkeyed`) instead of failing, so the preview covers the whole flow.
    //
    // `--allow-empty` (bugsee-cli >= 0.7.10): an output directory with no maps is a legitimate build
    // shape — a monorepo package built without them, a framework whose server output has none — and
    // the CLI otherwise exits 10 on it. Under `failOnError` it is NOT passed: a team that asked for
    // strictness wants "this build produced no maps at all" to stop the build, which is exactly the
    // misconfiguration that silently costs them symbolication later.
    //
    // A DIRECTORY run snapshots the maps that exist now: they are the ones this upload covers, and only they
    // may be deleted (a map written meanwhile was never sent). If the snapshot cannot be taken, nothing is
    // deleted afterwards and that is reported. A FILE run (`files`) names its maps up front.
    let snapshot: string[] | undefined;
    let snapshotError: unknown;
    if (files === undefined && deleteMaps && !dryRun) {
      try {
        snapshot = await (options.listMapFiles ?? listMapFiles)(outDir);
      } catch (error) {
        snapshotError = error;
      }
    }
    const emptyFlag = options.failOnError === true ? [] : ['--allow-empty'];
    const uploadArgs = (targets: readonly string[]): string[] => [
      'debug-files',
      'upload',
      ...targets,
      '--type',
      'sourcemaps',
      '--version',
      appVersion,
      '--build',
      appBuild,
      ...emptyFlag,
      ...(options.stripSourcesContent === true ? ['--strip-sources-content'] : []),
      ...dryFlag,
    ];
    if (files === undefined) {
      await run(uploadArgs([outDir]), cliOptions);
    } else {
      for (const batch of inBatches(files.maps)) {
        await run(uploadArgs(batch), cliOptions);
      }
    }

    // A dry run stops here: nothing was uploaded, so nothing justifies deleting the only copy of the
    // user's maps.
    if (dryRun) {
      return { injected: true, uploaded: false, deletedMaps: [], ...vcsEcho };
    }

    // 3. Delete the client .map files (privacy) — only after a CONFIRMED upload. Deleting after a failure
    //    would destroy the only copy of the mapping while the symbols were never delivered.
    if (snapshotError !== undefined) {
      // Fail CLOSED: with no snapshot, deleting "every map found" could remove maps that were never uploaded.
      const failure = new Error(
        `the source maps were uploaded but could not be listed for deletion, so none were deleted: ${String(snapshotError)}`,
      );
      if (options.failOnError === true) {
        throw failure;
      }
      onError(failure);
      return { injected: true, uploaded: true, deletedMaps: [], ...vcsEcho };
    }
    const deletedMaps = deleteMaps
      ? await (options.deleteMapFiles ?? defaultDeleteMapFiles)(
          outDir,
          files === undefined ? snapshot : [...files.maps, ...(files.stylesheetMaps ?? [])],
        )
      : [];
    return { injected: true, uploaded: true, deletedMaps, ...vcsEcho };
  } catch (error) {
    // A telemetry side effect must not break a production deploy. Reported, never swallowed;
    // `failOnError` is there for teams that would rather the build stopped.
    if (options.failOnError === true) {
      throw error;
    }
    onError(error);
    return { injected: false, uploaded: false, deletedMaps: [], ...vcsEcho };
  }
}
