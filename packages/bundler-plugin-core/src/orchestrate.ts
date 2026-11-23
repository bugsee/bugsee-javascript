// SM-A2 — orchestrate a source-map upload by driving `bugsee-cli`: inject debug-IDs, upload the maps, then
// delete the client `.map` files (privacy). Each side-effecting step is behind an injectable seam so the
// orchestration is unit-tested without a real binary or filesystem.
import { access, readdir, readFile, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { readDebugId } from './debug-ids';
import { type RunBugseeCliOptions, runBugseeCli, type SpawnResult } from './run-cli';
import { findIntegrityMismatches, findSriProtectedScripts, type SriProtectedScript } from './sri';
import {
  isFencedPath,
  isProjectRootOrAbove,
  isUploadableMap,
  listOutputMaps,
  MAX_WALK_DEPTH,
  NEVER_WALK,
  ownedBy,
  partitionByKeyed,
  type SnapshotTarget,
  type StampSnapshot,
  snapshotStampFiles,
  verifyAndRestore,
  verifyStampedOnDisk,
} from './stamp-files';
import type { VcsMetadata } from './vcs';
import { formatIssues } from './verify-stamp';

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
  /** Injectable `.map` lister for the delete snapshot of a directory run (default {@link listOutputMaps}). */
  listMapFiles?: (dir: string) => Promise<string[]>;
  /**
   * Injectable keyed-map check for the deletion step (default {@link partitionByKeyed}): which of the
   * candidate maps carry a debug-id, i.e. were actually keyed for upload, and so may be deleted.
   */
  partitionMaps?: typeof partitionByKeyed;
  /** Injectable SRI scan (default {@link findSriProtectedScripts}). */
  findSri?: (dir: string) => Promise<SriProtectedScript[]>;
  /**
   * The bundles were already stamped INSIDE the build (stamp-assets.ts), before any SRI plugin took
   * its hashes. Skips `sourcemaps inject` — nothing is rewritten after emit — and with it the SRI
   * refusal, which exists only to protect a page from that rewrite. Runs {@link verifySri} instead.
   */
  preStamped?: boolean;
  /**
   * The bundles (paths relative to `outDir`) the in-build stamp wrote. With `preStamped`, the on-disk
   * re-check judges exactly these and their maps — never the directory, so a file that was not part of the
   * bundle (a `public/` script, a stale file with `emptyOutDir: false`) is not taken for one the stamp
   * missed. Without it the re-check has nothing to name and does not run.
   */
  stampedBundles?: readonly string[];
  /**
   * The names this build emitted (relative to `outDir`). A stylesheet / declaration map is deleted only if it is
   * among them, and a keyed script map only if it is among them too; anything else is foreign, left alone, and
   * said. Without it (a directory run where the output is not known) the directory-name fence applies.
   */
  ownFiles?: readonly string[];
  /** The in-build stamp's bundle -> map names (relative to `outDir`), for maps the pointer and sibling cannot name. */
  stampedMaps?: Readonly<Record<string, string>>;
  /** Where a non-failing observation goes (default: nowhere — callers that want it pass the notice sink). */
  onNotice?: (message: string) => void;
  /** Injectable lister of the script maps to consider for a pre-stamped directory upload (default {@link listOutputMaps}). */
  listUploadMaps?: (dir: string) => Promise<string[]>;
  /** Where the pre-inject originals are spilled (default: the OS temp directory). A test seam. */
  spillRoot?: string;
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
  if (depth > MAX_WALK_DEPTH) {
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

/** The error for a stamp that did not verify: what was restored, and anything that could not be. */
function verifyFailure(
  issues: Parameters<typeof formatIssues>[0],
  restored: readonly string[],
  failed: ReadonlyArray<{ path: string; error: string }>,
): Error {
  return new Error(
    `the debug-ID stamp did not verify, so ${restored.length} file(s) were restored to the bundler's original bytes (${formatIssues(issues)})` +
      (failed.length > 0
        ? `; COULD NOT restore ${failed.map((f) => `${f.path} (${f.error})`).join(', ')}, which still carry the unverified stamp`
        : ''),
  );
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

  const notice = (message: string): void =>
    (options.onNotice ?? ((m: string) => console.warn(`[bugsee] ${m}`)))(message);

  /**
   * Reports something that does NOT stop the upload (the catch-up's problems): the default must not say the
   * upload was skipped, as the contained-failure wording does.
   */
  const reportContinuing = (error: unknown): void =>
    (options.onError ?? ((e: unknown) => console.warn(`[bugsee] ${String(e)}`)))(error);

  /** The map is a JSON object (what inject can stamp): not empty, not garbage, not `[]` / `null`. */
  const isMapObject = async (map: string): Promise<boolean> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(map, 'utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  };

  /**
   * CATCH UP the build's OWN script maps that still carry no debug-id. Vite builds a worker through a
   * sub-build, then puts its code in the output while REGENERATING its map (Vite 8) or emitting both after
   * our `generateBundle` (Vite 7): the worker file is stamped without its map carrying the id, or not stamped
   * at all. `sourcemaps inject` on a bundle that already carries the id AND the registration leaves its bytes
   * unchanged and puts the id in the map (measured, bugsee-cli 0.9.0). Only maps this build emitted
   * (`ownFiles`) are touched, never a `public/` copy; a bundle that is not fully stamped yet and is pinned by
   * Subresource Integrity is left alone (stamping it would change pinned bytes).
   *
   * Robust by construction: a map that is not a JSON object is skipped (the CLI rejects the whole batch for
   * one), a rejected batch is retried pair by pair, and whatever was rewritten is verified and restored.
   * Returns a failure only when files could not be restored from an unverified stamp (and `failOnError` is on).
   */
  const catchUpUnkeyed = async (ownFiles: readonly string[]): Promise<Error | undefined> => {
    const own = ownedBy(outDir, ownFiles);
    const unkeyed = (
      await (options.partitionMaps ?? partitionByKeyed)(
        (
          await (options.listUploadMaps ?? listOutputMaps)(outDir)
        ).filter((map) => isUploadableMap(map) && own(map)),
      )
    ).kept;
    const pairs: Array<{ bundle: string; map: string }> = [];
    for (const map of unkeyed) {
      const bundle = map.slice(0, -'.map'.length);
      if (
        /\.[cm]?js$/i.test(bundle) &&
        (await access(bundle).then(
          () => true,
          () => false,
        )) &&
        (await isMapObject(map))
      ) {
        pairs.push({ bundle, map });
      }
    }
    if (pairs.length === 0) {
      return undefined;
    }
    const pinned = new Set(
      (await (options.findSri ?? findSriProtectedScripts)(outDir)).map((pin) =>
        resolve(pin.script),
      ),
    );
    const eligible: typeof pairs = [];
    const blocked: typeof pairs = [];
    for (const pair of pairs) {
      let code: string;
      try {
        code = await readFile(pair.bundle, 'utf8');
      } catch {
        continue; // vanished, or not a file: not a candidate
      }
      // "Stamped" means the id AND the registration: a foreign `//# debugId=` comment alone would still get
      // the registration appended, which changes pinned bytes.
      const stamped = readDebugId(code) !== undefined && code.includes('_bugseeDebugIds');
      (pinned.has(resolve(pair.bundle)) && !stamped ? blocked : eligible).push(pair);
    }
    if (blocked.length > 0) {
      notice(
        `${blocked.length} script(s) this build emitted were not fully stamped because Subresource Integrity pins them, so their maps were not uploaded: ${blocked.map((pair) => pair.bundle).join(', ')}`,
      );
    }
    if (eligible.length === 0) {
      return undefined;
    }
    const targets = eligible.flatMap((pair) => [pair.bundle, pair.map]);
    const snapshot = await snapshotStampFiles({ files: targets }, options.spillRoot);
    try {
      const pairErrors: Error[] = [];
      try {
        for (const batch of inBatches(targets)) {
          await run(['sourcemaps', 'inject', ...batch], cliOptions);
        }
      } catch {
        // The CLI rejected a batch: find out which pair, so one bad file does not cost the others.
        for (const pair of eligible) {
          try {
            await run(['sourcemaps', 'inject', pair.bundle, pair.map], cliOptions);
          } catch (error) {
            pairErrors.push(
              new Error(`bugsee-cli could not stamp ${pair.bundle}: ${String(error)}`),
            );
          }
        }
      }
      // Whatever was rewritten (even by a CLI that then failed) is verified, and restored if it is not sound:
      // BEFORE anything is reported, so a user handler that throws cannot skip it.
      const { issues, restored, failed } = await verifyAndRestore(snapshot);
      for (const error of pairErrors) {
        reportContinuing(error);
      }
      if (issues.length > 0) {
        const failure = verifyFailure(issues, restored, failed);
        // Restored means the output is exactly what the bundler wrote (safe): reported. Only files that could
        // NOT be restored still carry an unverified stamp, which `failOnError` refuses to ship.
        if (options.failOnError === true && failed.length > 0) {
          return failure;
        }
        reportContinuing(failure);
      }
      return undefined;
    } finally {
      await snapshot.dispose();
    }
  };

  let original: StampSnapshot | undefined;
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
            `, so the browser will refuse to run it. Bugsee stamps debug-IDs inside the build, before the ` +
            `bundler writes its output (webpack/Rspack: PROCESS_ASSETS_STAGE_DEV_TOOLING + 1; Vite/Rollup: ` +
            `generateBundle, order 'pre'). A plugin that hashes EARLIER than that sees the bytes before the ` +
            `stamp, and one that rewrites the file AFTER it changes bytes that were already hashed. Run the ` +
            `hashing after this plugin (list this plugin first), or disable this plugin for this build.`,
        );
        if (options.failOnError === true) {
          throw error;
        }
        // Reported, and the upload goes on: the maps are correct and still worth having — it is the
        // page that is broken, not them. NOT through the default `onError` wording, which says the
        // upload was skipped; here it was not.
        (options.onError ?? ((e: unknown) => console.warn(`[bugsee] ${String(e)}`)))(error);
      }
      // 0'''. CATCH UP the build's OWN script maps that still carry no debug-id. Vite builds a worker through a
      //       sub-build, then copies its code into the output while REGENERATING its map (Vite 8) or emitting both
      //       after our `generateBundle` (Vite 7): the worker file is stamped without its map carrying the id, or
      //       not stamped at all. `sourcemaps inject` on an already-stamped bundle leaves its bytes unchanged
      //       and puts the bundle's id in the map (measured, bugsee-cli 0.9.0), so this is idempotent. Only maps
      //       this build emitted (`ownFiles`) are touched, never a `public/` copy; a bundle that is not stamped
      //       yet and is pinned by Subresource Integrity is left alone (stamping it would break the page).
      if (!dryRun && files === undefined && options.ownFiles !== undefined) {
        // Best effort: nothing in the catch-up may cost the build its other maps. Only an applied stamp that
        // does not VERIFY is a strict failure (thrown under failOnError); a CLI error is reported and the map
        // simply stays unkeyed.
        let strict: Error | undefined;
        try {
          strict = await catchUpUnkeyed(options.ownFiles);
        } catch (error) {
          onError(
            new Error(`stamping this build's remaining script maps failed: ${String(error)}`),
          );
        }
        if (strict !== undefined) {
          throw strict;
        }
      }
      // 0''. The same stamp, as it is on disk after the bundler wrote the output. A later step can rewrite a
      //      chunk or REGENERATE its map after the in-build stamp (Vite does, for dynamic-import preload
      //      markers), and a bundle that looks stamped with a map that no longer carries its id cannot be
      //      symbolicated. Nothing to restore here (no originals), so it is reported; the keyed check at
      //      deletion keeps any map that lost its id. Not on a dry run: nothing was stamped.
      if (!dryRun && options.stampedBundles !== undefined) {
        const known = new Map(
          Object.entries(options.stampedMaps ?? {}).map(([bundle, map]) => [
            resolve(outDir, bundle),
            resolve(outDir, map),
          ]),
        );
        const lost = await verifyStampedOnDisk(
          options.stampedBundles.map((bundle) => resolve(outDir, bundle)),
          known,
        );
        if (lost.length > 0) {
          const failure = new Error(
            `the debug-IDs stamped inside the build did not survive intact to disk: they changed after the build wrote it, ` +
              `or something rewrote a bundle or its map after Bugsee stamped it (${formatIssues(lost)}). ` +
              `Affected maps cannot be matched to their bundle.`,
          );
          if (options.failOnError === true) {
            throw failure;
          }
          onError(failure);
        }
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
            `page would load nothing. Source maps were NOT uploaded. Bundlers that let this plugin stamp ` +
            `inside the build (webpack 5, Rspack, Vite, Rollup) avoid this; if one did and this still fired, its ` +
            `in-build stamp failed (see the earlier warning). For esbuild or the standalone CLI, run ` +
            `\`bugsee-cli sourcemaps inject\` BEFORE the step that computes the hashes. See ` +
            `https://github.com/bugsee/bugsee-javascript/blob/main/docs/design/source-maps.md#subresource-integrity`,
        );
      }

      // 0b. Take the originals, so a stamp that does not verify can be undone (see below). Not on a dry run:
      //     inject writes nothing, so there is nothing to undo.
      const target: SnapshotTarget =
        files === undefined ? { dir: outDir } : { files: [...files.scripts, ...files.maps] };
      //     A directory that is the project root (or above) is NOT snapshotted: a bare `output.file`
      //     resolves to `.`, and snapshot-and-restore there would reach across the project tree.
      if (!dryRun) {
        if (files === undefined && (await isProjectRootOrAbove(outDir))) {
          onError(
            new Error(
              `the debug-ID stamp of ${outDir} cannot be verified or undone: the output directory is the project root (or contains it), so originals are not snapshotted. Set an output directory (output.dir) to get stamp verification.`,
            ),
          );
        } else {
          original = await snapshotStampFiles(target, options.spillRoot);
        }
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

      // 1b. VERIFY what inject wrote (verify-stamp.ts): every changed bundle still parses and keeps its map
      //     pointer, the bytes are the original plus an appended stamp, every map is JSON whose debugId
      //     matches its bundle. A failure puts the ORIGINAL bytes back (bundle and map as a pair) and is
      //     reported — a script that no longer parses is a blank page, and shipping it silently is the one
      //     outcome this must rule out. What did verify stays stamped and is uploaded below; the restored
      //     maps carry no debugId, so the keyed check at deletion keeps them.
      if (original !== undefined) {
        const { issues, restored, failed } = await verifyAndRestore(original);
        if (issues.length > 0) {
          const failure = verifyFailure(issues, restored, failed);
          if (options.failOnError === true) {
            throw failure;
          }
          onError(failure);
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
    // A PRE-STAMPED directory is uploaded as an explicit file set (below), and what is deleted is exactly
    // that set: no second walk to disagree with the first about which maps exist.
    const explicitUpload = files === undefined && options.preStamped === true && !dryRun;
    let uploadedMaps: string[] = [];
    let unuploadableMaps: string[] = [];
    let snapshot: string[] | undefined;
    let snapshotError: unknown;
    if (files === undefined && deleteMaps && !dryRun && !explicitUpload) {
      try {
        snapshot = await (options.listMapFiles ?? listOutputMaps)(outDir);
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
    // A PRE-STAMPED directory is uploaded as an explicit file set, never as the directory. Only what the
    // in-build stamp wrote has a debug-id; anything else in the directory (a `public/` vendor script and
    // its map, a stale map with `emptyOutDir: false`) has none, and the CLI exits non-zero for a directory
    // holding such a map ("nothing was uploaded"), which would lose EVERY map of the build. Unkeyed maps
    // are left alone and said, not failed.
    if (explicitUpload) {
      // ONE walk: the uploadable maps are classified by key; the stylesheet / declaration maps of the same
      // walk are never uploaded but embed the source, so they are deleted with the uploaded ones.
      // Sorted here, so the CLI batches and the notice are stable whatever order a walk returns.
      const everything = [...(await (options.listUploadMaps ?? listOutputMaps)(outDir))].sort();
      const { deletable, kept } = await (options.partitionMaps ?? partitionByKeyed)(
        everything.filter(isUploadableMap),
      );
      // Only THIS build's own stylesheet / declaration maps are deleted: never one under node_modules, src,
      // test or a dot-directory (foreign files this build did not produce), and an unkeyed map there is
      // not worth a notice either.
      const notFenced = (map: string): boolean => !isFencedPath(relative(outDir, map));
      // (ownership is applied once, when deciding what to delete)
      unuploadableMaps = everything.filter((map) => !isUploadableMap(map));
      const noticed = kept.filter(notFenced);
      if (noticed.length > 0) {
        (options.onNotice ?? ((m: string) => console.warn(`[bugsee] ${m}`)))(
          `${noticed.length} source map(s) in ${outDir} have no readable debug-ID, so they were not uploaded (left on disk untouched): ${noticed.join(', ')}`,
        );
      }
      if (deletable.length === 0) {
        if (options.failOnError === true) {
          throw new Error(
            `no source maps with a debug-ID were found in ${outDir}, so nothing was uploaded`,
          );
        }
      } else {
        for (const batch of inBatches(deletable)) {
          await run(uploadArgs(batch), cliOptions);
        }
        uploadedMaps = deletable;
      }
    } else if (files === undefined) {
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
    //    "The upload command exited 0" is not "this map was uploaded": the CLI skips a map with no debug-id.
    //    Only a map that carries one was keyed for upload, so only those are deleted (stamp-files.ts).
    let deletedMaps: string[] = [];
    if (deleteMaps) {
      // A pre-stamped build deletes exactly what it uploaded (already classified keyed, so not re-read) plus
      // the maps that were never uploadable, and only if something was uploaded. Any other path classifies
      // its candidates here.
      let deletable: string[];
      let kept: string[] = [];
      const own = ownedBy(outDir, options.ownFiles);
      // A keyed script map is deleted only if this build emitted it (when the build's names are known); a
      // stylesheet / declaration map only if it is this build's (by name, or the directory fence as fallback).
      const mayDelete = (map: string): boolean =>
        isUploadableMap(map) ? options.ownFiles === undefined || own(map) : own(map);
      if (explicitUpload) {
        deletable = uploadedMaps.length > 0 ? [...uploadedMaps, ...unuploadableMaps] : [];
      } else {
        ({ deletable, kept } = await (options.partitionMaps ?? partitionByKeyed)(
          files === undefined
            ? (snapshot as string[])
            : [...files.maps, ...(files.stylesheetMaps ?? [])],
        ));
        if (files === undefined) {
          // A directory walk also sees foreign files; an unkeyed map in a fenced directory is not reported.
          kept = kept.filter((map) => !isFencedPath(relative(outDir, map)));
        }
      }
      // Directory runs only: the explicit `files` path deletes exactly the files it was given.
      let foreign: string[] = [];
      if (files === undefined) {
        foreign = deletable.filter((map) => isUploadableMap(map) && !mayDelete(map));
        deletable = deletable.filter(mayDelete);
      }
      if (foreign.length > 0) {
        (options.onNotice ?? ((m: string) => console.warn(`[bugsee] ${m}`)))(
          `${foreign.length} keyed source map(s) in ${outDir} were not produced by this build, so they were left on disk (uploaded, not deleted): ${foreign.join(', ')}`,
        );
      }
      deletedMaps = await (options.deleteMapFiles ?? defaultDeleteMapFiles)(outDir, deletable);
      if (kept.length > 0) {
        const failure = new Error(
          `${kept.length} source map(s) have no readable debug-ID, so they were not uploaded and were left on disk: ${kept.join(', ')}`,
        );
        if (options.failOnError === true) {
          throw failure;
        }
        onError(failure);
      }
    }
    // Truthful: a pre-stamped build with no keyed map made no upload at all.
    return {
      injected: true,
      uploaded: !explicitUpload || uploadedMaps.length > 0,
      deletedMaps,
      ...vcsEcho,
    };
  } catch (error) {
    // A telemetry side effect must not break a production deploy. Reported, never swallowed;
    // `failOnError` is there for teams that would rather the build stopped.
    if (options.failOnError === true) {
      throw error;
    }
    onError(error);
    return { injected: false, uploaded: false, deletedMaps: [], ...vcsEcho };
  } finally {
    // Cleanup must never fail a build whose upload already succeeded, nor mask the error being reported:
    // removing the spill directory can fail (EPERM/EBUSY under antivirus on Windows). Said, not thrown.
    try {
      await original?.dispose();
    } catch (error) {
      onError(
        new Error(
          `could not remove the temporary spill directory of the originals: ${String(error)}`,
        ),
      );
    }
  }
}
