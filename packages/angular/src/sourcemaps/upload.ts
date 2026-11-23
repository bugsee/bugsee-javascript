// `@bugsee/angular/sourcemaps` — upload an Angular build's source maps. A post-build step, because Angular's
// esbuild application builder has no plugin hook; it reuses @bugsee/bundler-plugin-core's pipeline (inject
// debug-IDs with `bugsee-cli`, upload the maps, register the build, delete the client maps) and adds only what
// is Angular's: where the output is, and Subresource Integrity.
//
// SRI. With `subresourceIntegrity: true` Angular writes a hash of every script into `index.html` (and, for SSR,
// into the copy of that page it embeds in the server modules). Stamping the scripts afterwards changes their
// bytes, so the hashes are re-written to match (`resealSri`) — sound here because those pages are the only
// place Angular's esbuild builder keeps them (lazy chunks are loaded by `import()`, with no hash). Measured on
// a real @angular/build 22 build; see docs/design/source-maps.md §7.1.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type BugseePluginOptions,
  type EnvRecord,
  loadBuildPluginEnv,
  mergeBuildPluginEnv,
  type PluginRunResult,
  type ResolvedPluginOptions,
  resolvePluginOptions,
  runPluginUpload,
} from '@bugsee/bundler-plugin-core';
import { resolveAngularOutput } from './output';

export interface AngularUploadOptions extends BugseePluginOptions {
  /** Workspace directory (angular.json is looked for here and above). Default: the working directory. */
  cwd?: string;
  /** Application project. Default: the only application in the workspace. */
  project?: string;
  /** The `ng build` configuration the output came from. Default: the build target's default. */
  configuration?: string;
  /** The browser output directory, when it is not where angular.json says (skips the angular.json lookup). */
  dist?: string;
  /** Environment to read BUGSEE_* from. Default: `process.env`, plus `.env.bugsee-build-plugin`. */
  env?: EnvRecord;
}

export interface AngularUploadResult {
  /**
   * `uploaded`: the pipeline ran (its result says how far it got — a contained failure is reported, not thrown).
   * `disabled`: no token or `disabled: true`. `skipped`: a development build. `refused`: a build this tool
   * cannot stamp safely (see the notice).
   */
  status: 'uploaded' | 'disabled' | 'skipped' | 'refused';
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

  const located =
    options.dist !== undefined
      ? undefined
      : resolveAngularOutput({
          cwd,
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.configuration !== undefined ? { configuration: options.configuration } : {}),
        });
  const outDir =
    options.dist !== undefined ? resolve(cwd, options.dist) : (located?.browserDir as string);
  const configuration = located?.configuration ?? options.configuration;

  if (!resolved.enabled) {
    if (!options.disabled) {
      say('no app token (BUGSEE_APP_TOKEN): nothing was uploaded.');
    }
    return { status: 'disabled', outDir, configuration };
  }
  if (!existsSync(outDir)) {
    throw new Error(
      `the build output ${outDir} does not exist. Run \`ng build\` first (this step uploads what it wrote), or ` +
        `give the directory with --dist.`,
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
  if (existsSync(join(outDir, 'ngsw.json'))) {
    // ngsw.json carries a hash of every file; the service worker treats a file that no longer matches as
    // corrupt and stops serving the app. Stamping changes the bytes, so it is refused rather than guessed at.
    const failure = new Error(
      `${join(outDir, 'ngsw.json')} is the Angular service worker's manifest: it pins a hash of every file, and ` +
        `stamping debug-IDs changes them, which would make the service worker reject the app. Source maps were ` +
        `NOT uploaded. Build without \`serviceWorker\` for the build you symbolicate, or upload the maps yourself ` +
        `with \`bugsee-cli debug-files upload\` (the symbol match then falls back to app version/build).`,
    );
    if (resolved.failOnError) {
      throw failure;
    }
    say(failure.message);
    return { status: 'refused', outDir, configuration };
  }
  if (!hasSourceMaps(outDir)) {
    say(
      `no source maps found in ${outDir}. Enable them for this build ("sourceMap": { "scripts": true, ` +
        `"styles": false, "hidden": true } in angular.json), or nothing can be symbolicated.`,
    );
  }

  const server = located?.serverDir;
  const run = deps.runPluginUpload ?? runPluginUpload;
  const result = await run(resolved, outDir, {
    // Only acts when the build pins script hashes; then inject runs with --allow-sri and the page is re-sealed.
    resealSri: true,
    // The server modules of an SSR build embed the page, hashes included.
    resealDirs:
      located !== undefined && server !== undefined && existsSync(server)
        ? [located.baseDir]
        : [outDir],
    bundler: { isProduction, ...(configuration !== undefined ? { configuration } : {}) },
  });
  return { status: 'uploaded', outDir, configuration, ...(result !== undefined ? { result } : {}) };
}
