// `@bugsee/angular/sourcemaps` — upload an Angular build's source maps. A post-build step, because Angular's
// esbuild application builder has no plugin hook; it reuses @bugsee/bundler-plugin-core's pipeline (inject
// debug-IDs with `bugsee-cli`, upload the maps, register the build, delete the client maps) and adds only what
// is Angular's: where the output is, and Subresource Integrity.
//
// SRI. With `subresourceIntegrity: true` Angular writes a hash of every script into `index.html` — as tags, and
// (esbuild builder, Angular 21+) as an import map's `integrity` table that pins every lazy chunk — and, for SSR,
// into the copy of that page it embeds in the server modules; the webpack builder also keeps the lazy chunks'
// hashes in its runtime chunk. Stamping the scripts afterwards changes their bytes, so every digest of a changed
// script is re-written wherever it appears (`resealSri`, bundler-plugin-core), and a build that cannot be re-sealed
// is restored. Measured on real @angular/build 22.3 and build-angular 19.2 builds; see docs/design/source-maps.md §7.1.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  type BugseePluginOptions,
  type EnvRecord,
  isFencedPath,
  loadBuildPluginEnv,
  mergeBuildPluginEnv,
  type PluginRunResult,
  type ResolvedPluginOptions,
  resolvePluginOptions,
  runPluginUpload,
} from '@bugsee/bundler-plugin-core';
import { type AngularOutput, resolveAngularOutput } from './output';
import { findServerRoot } from './server-root';

export interface AngularUploadOptions extends BugseePluginOptions {
  /** Workspace directory (angular.json is looked for here and above). Default: the working directory. */
  cwd?: string;
  /** Application project. Default: the only application in the workspace. */
  project?: string;
  /** The `ng build` configuration the output came from. Default: the build target's default. */
  configuration?: string;
  /** The browser output directory, when it is not where angular.json says (skips the angular.json lookup). */
  dist?: string;
  /** What `ng build --output-path` was given: the output base (its `browser/` is used when present). Skips the lookup. */
  outputPath?: string;
  /** Environment to read BUGSEE_* from. Default: `process.env`, plus `.env.bugsee-build-plugin`. */
  env?: EnvRecord;
}

export interface AngularUploadResult {
  /**
   * `uploaded`: the pipeline ran (its result says how far it got — a contained failure is reported, not thrown).
   * `disabled`: no token or `disabled: true`. `skipped`: a development build. `misconfigured`: the output could
   * not be found (said; thrown under `failOnError`).
   */
  status: 'uploaded' | 'disabled' | 'skipped' | 'misconfigured';
  outDir: string;
  configuration: string | undefined;
  result?: PluginRunResult;
}

export interface AngularUploadDeps {
  runPluginUpload?: (
    resolved: ResolvedPluginOptions,
    outDir: string,
    deps: NonNullable<Parameters<typeof runPluginUpload>[2]>,
  ) => Promise<PluginRunResult | undefined>;
}

/** Whether `dir` holds at least one `.map`, looking a few levels down and never inside `node_modules`. */
function hasSourceMaps(dir: string, depth = 0): boolean {
  if (depth > 3) {
    return false;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && hasSourceMaps(join(dir, entry.name), depth + 1)) {
        return true;
      }
    } else if (entry.name.endsWith('.map')) {
      return true;
    }
  }
  return false;
}

/**
 * Every file under `dir` that is not inside a fenced directory (`node_modules`, `src`, `test`, a dot-directory),
 * relative to it. Angular reports no list of what it emitted, and cleans its output directory before a build, so
 * what is outside the fence IS this build's. Naming them makes the deletion identity-based: a keyed map a foreign
 * tool left in a fenced directory is uploaded with the directory but never deleted.
 */
function ownFilesOf(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, level: number): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (level < 8) {
          walk(full, level + 1);
        }
      } else if (!isFencedPath(relative(dir, full))) {
        found.push(relative(dir, full));
      }
    }
  };
  walk(dir, 0);
  return found;
}

/** Upload the source maps of an Angular build. Never throws for an upload failure unless `failOnError` is set. */
export async function uploadAngularSourcemaps(
  options: AngularUploadOptions,
  deps: AngularUploadDeps = {},
): Promise<AngularUploadResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const say = (message: string): void => {
    const text = `[bugsee] ${message}`;
    if (options.onNotice !== undefined) {
      options.onNotice(text);
    } else {
      console.warn(text);
    }
  };
  const file = options.disabled ? { values: {} } : loadBuildPluginEnv(cwd);
  if ('problem' in file && file.problem !== undefined) {
    say(file.problem);
  }
  const env = mergeBuildPluginEnv(options.env ?? (process.env as EnvRecord), file.values);
  const resolved = resolvePluginOptions(
    { ...options, projectRoot: options.projectRoot ?? cwd },
    env,
  );

  if (!resolved.enabled) {
    // Before the output is looked up: a build with no token (a contributor's PR, no secrets) is a no-op, and must
    // stay one when angular.json cannot be read or names several applications.
    if (!options.disabled) {
      say('no app token (BUGSEE_APP_TOKEN): nothing was uploaded.');
    }
    return {
      status: 'disabled',
      outDir:
        options.dist !== undefined
          ? resolve(cwd, options.dist)
          : options.outputPath !== undefined
            ? resolve(cwd, options.outputPath)
            : '',
      configuration: options.configuration,
    };
  }
  // Where the output is. A problem here is a misconfiguration of THIS step (no angular.json, several applications, a
  // moved output path, ng build not run), not a failed upload: it must not fail a pipeline whose build succeeded,
  // so it is said and the step stops, unless `failOnError` asks for the strict reading.
  const misconfigured = (message: string, outDir: string, configuration?: string) => {
    if (resolved.failOnError) {
      throw new Error(message);
    }
    say(`${message} Nothing was uploaded.`);
    return { status: 'misconfigured' as const, outDir, configuration };
  };
  let located: AngularOutput | undefined;
  let outDir: string;
  // The output ROOT whose pages must be re-sealed: an SSR build's server modules embed the page.
  let resealRoot: string | undefined;
  // The browser directory of that root (its name is not always `browser`).
  let rootBrowser: string | undefined;
  const probeServerRoot = (): void => {
    const found = findServerRoot(outDir, cwd);
    if (found !== undefined && 'root' in found) {
      resealRoot = found.root;
      rootBrowser = found.browser;
    } else if (found !== undefined) {
      say(found.notice);
    }
  };
  if (options.dist !== undefined) {
    outDir = resolve(cwd, options.dist);
    probeServerRoot();
  } else if (options.outputPath !== undefined) {
    // `ng build --output-path <base>`: the base of an application build (browser/ and server/ below it), or a
    // browser directory itself.
    const base = resolve(cwd, options.outputPath);
    if (existsSync(join(base, 'browser'))) {
      outDir = join(base, 'browser');
      resealRoot = existsSync(join(base, 'server')) ? base : undefined;
      rootBrowser = outDir;
    } else {
      outDir = base;
      probeServerRoot();
    }
  } else {
    try {
      located = resolveAngularOutput({
        cwd,
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.configuration !== undefined ? { configuration: options.configuration } : {}),
      });
    } catch (error) {
      return misconfigured(
        `${(error as Error).message}. If you built to a different directory, give it with --output-path (or --dist).`,
        '',
        options.configuration,
      );
    }
    outDir = located.browserDir;
    rootBrowser = outDir;
    resealRoot =
      located.serverDir !== undefined && existsSync(located.serverDir)
        ? located.baseDir
        : undefined;
  }
  const configuration = located?.configuration ?? options.configuration;

  if (!existsSync(outDir)) {
    return misconfigured(
      `the build output ${outDir} does not exist. Run \`ng build\` first (this step uploads what it wrote); if you ` +
        `built to a different directory, give it with --output-path (or --dist).`,
      outDir,
      configuration,
    );
  }
  const isProduction = !(configuration?.split(',').includes('development') ?? false);
  if (!isProduction && !resolved.uploadInDevelopment) {
    say(
      'development configuration: nothing was uploaded, and any source maps on disk were left in place. Set ' +
        '`uploadInDevelopment: true` (--upload-in-development) to upload from it too.',
    );
    return { status: 'skipped', outDir, configuration };
  }
  if (!hasSourceMaps(outDir)) {
    say(
      `no source maps found in ${outDir}. Enable them for this build ("sourceMap": { "scripts": true, ` +
        `"styles": false, "hidden": true } in angular.json), or nothing can be symbolicated.`,
    );
  }

  const run = deps.runPluginUpload ?? runPluginUpload;
  const result = await run(resolved, outDir, {
    // Only acts when the build pins script hashes; then inject runs with --allow-sri and the page is re-sealed.
    resealSri: true,
    // The server modules of an SSR build embed the page, hashes included.
    resealDirs:
      resealRoot === undefined || outDir === rootBrowser
        ? [resealRoot ?? outDir]
        : // One locale of several: stamp and re-seal only it and ITS server pages. Angular emits byte-identical
          // shared scripts into every locale, so re-sealing the whole root would pin the other locales' never-stamped
          // scripts to stamped digests.
          [outDir, join(resealRoot, 'server', relative(rootBrowser as string, outDir))],
    // Verified across the whole output root: a pin anywhere that no longer matches its file is a failure.
    verifyDirs: [resealRoot ?? outDir],
    bundler: { isProduction, ...(configuration !== undefined ? { configuration } : {}) },
    ownFiles: ownFilesOf(outDir),
  });
  return { status: 'uploaded', outDir, configuration, ...(result !== undefined ? { result } : {}) };
}
