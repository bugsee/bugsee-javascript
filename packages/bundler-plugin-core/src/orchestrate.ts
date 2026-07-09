// SM-A2 — orchestrate a source-map upload by driving `bugsee-cli`: inject debug-IDs, upload the maps, then
// delete the client `.map` files (privacy). Each side-effecting step is behind an injectable seam so the
// orchestration is unit-tested without a real binary or filesystem.
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunBugseeCliOptions, runBugseeCli, type SpawnResult } from './run-cli';

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
}

export interface UploadSourcemapsResult {
  injected: boolean;
  uploaded: boolean;
  deletedMaps: string[];
}

/** Recursively delete every `*.map` under `dir`; returns the deleted paths. */
export async function defaultDeleteMapFiles(dir: string): Promise<string[]> {
  const deleted: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      deleted.push(...(await defaultDeleteMapFiles(full)));
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
  if (appToken === '') {
    throw new Error('uploadSourcemaps: appToken is required');
  }
  const run = options.run ?? runBugseeCli;
  const deleteMaps = options.deleteMaps ?? true;
  const dryFlag = dryRun ? ['--dry-run'] : [];
  const cliOptions: RunBugseeCliOptions = { token: appToken, endpoint };

  // 1. Inject debug-IDs (rewrites the built .js + .map in place).
  await run(['sourcemaps', 'inject', outDir, ...dryFlag], cliOptions);

  // 2. Upload the maps, keyed by the injected debug-ID (+ version/build metadata).
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
      ...dryFlag,
    ],
    cliOptions,
  );

  // 3. Delete the client .map files (privacy) — never on a dry run.
  let deletedMaps: string[] = [];
  if (deleteMaps && !dryRun) {
    deletedMaps = await (options.deleteMapFiles ?? defaultDeleteMapFiles)(outDir);
  }

  return { injected: true, uploaded: true, deletedMaps };
}
