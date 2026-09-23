// Register a JavaScript build with Bugsee — docs/design/web-build-registration.md (slice 3).
//
// Product direction (2026-09-19): a JavaScript build SHOULD register a build, and by default only a
// release one. The Android Gradle plugin and the iOS agent are the reference, and this follows them:
//
//   - ON by default, gated only on "release-like" (D2). The analog of AGP's `!isDebuggable` is the
//     bundler's OWN production signal, not minification and not a name match on the output directory.
//   - Register-only (D5). A JavaScript build has no single artefact to ship, so `bugsee-cli upload build`
//     runs with no `--artifact` and the CLI sends `request_artifact_upload: false`.
//   - A failure never fails the build (D4) — reported and contained, like the source-map upload, and
//     `failOnError` opts into a hard stop.
//
// Runs AFTER the source-map upload and its map deletion, which it can because it reads the build's
// debug-ids from the bundles rather than the maps (debug-ids.ts).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deriveBuildUuid } from './build-id';
import { collectDebugIds as defaultCollectDebugIds } from './debug-ids';
import type { RunFn } from './orchestrate';
import { type EnvRecord, runBugseeCli } from './run-cli';
import type { VcsMetadata } from './vcs';

/**
 * Which builds register. `'release'` (default) — only a production build; `'always'` — every build;
 * `false` — none. One tri-state rather than Android's pair (`buildInfo.enabled` + `allBuildTypes`),
 * because it says the same thing without a second switch to reconcile.
 */
export type RegisterBuildSetting = 'release' | 'always' | false;

/** What the bundler itself says about this build. Both fields are optional: Rollup says nothing. */
export interface BundlerBuildContext {
  /**
   * The bundler's production signal — Vite's resolved `isProduction`, webpack's
   * `mode === 'production'`. Preferred over NODE_ENV because it is what the bundler actually built:
   * `vite build --mode staging` is a production build whose NODE_ENV nobody set.
   */
  isProduction?: boolean;
  /** The configuration name recorded on the build — Vite's `mode`, webpack's `mode`. */
  configuration?: string;
}

export type RegistrationDecision =
  | { register: true }
  | { register: false; reason: 'disabled' | 'not-release' };

/** D2: decide whether this build registers at all. Pure. */
export function resolveRegistration(
  setting: RegisterBuildSetting,
  bundler: BundlerBuildContext,
  env: EnvRecord,
): RegistrationDecision {
  if (setting === false) {
    return { register: false, reason: 'disabled' };
  }
  if (setting === 'always') {
    return { register: true };
  }
  const isRelease = bundler.isProduction ?? env.NODE_ENV === 'production';
  return isRelease ? { register: true } : { register: false, reason: 'not-release' };
}

/**
 * D3: the build's `package_id` — the `name` of the NEAREST package.json at or above `from`, scope
 * included (`@acme/web-app`). It is only a scoping key for size analysis, so being stable matters more
 * than being reverse-DNS.
 *
 * Nearest, so a monorepo app is named after itself and not its workspace; a package.json with no
 * usable name (a `"private": true` workspace root) is skipped, as is one that is not valid JSON.
 * `stopAt` bounds the walk (inclusive); it otherwise ends at the filesystem root. Never throws.
 */
export async function findPackageName(from: string, stopAt?: string): Promise<string | undefined> {
  const boundary = stopAt !== undefined ? resolve(stopAt) : undefined;
  let dir = resolve(from);
  for (;;) {
    try {
      const name: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name;
      if (typeof name === 'string' && name.trim() !== '') {
        return name.trim();
      }
    } catch {
      // No package.json here, or not one that parses — keep walking.
    }
    const parent = dirname(dir);
    if (dir === boundary || parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** The registration payload — the POST body `bugsee-cli upload build` forwards to the appserver. */
export interface JsBuildPayload {
  uuid: string;
  /**
   * `js` — the ARTEFACT, like Android's `aab`/`apk` and iOS's `ipa`. Not a runtime: the same plugin
   * registers browser bundles, SSR server bundles, edge workers, bundled Node services and Electron,
   * and their artefact is the same shape. The runtime belongs to the application's type/subtype.
   * (First shipped as `web`, which named only the browser case; renamed in bugsee-appserver#44.)
   */
  format: 'js';
  version: string;
  build: string;
  package_id?: string;
  build_configuration?: string;
  vcs?: VcsMetadata;
}

export interface RegisterJsBuildOptions {
  /** Build output directory — where the stamped bundles are. */
  outDir: string;
  appToken: string;
  appVersion: string;
  appBuild: string;
  endpoint?: string;
  setting: RegisterBuildSetting;
  bundler: BundlerBuildContext;
  /** Consulted only for NODE_ENV, when the bundler has no production signal of its own. */
  env: EnvRecord;
  /** Explicit `package_id`; overrides the package.json lookup. */
  packageId?: string;
  /** Where the package.json lookup starts. */
  projectRoot: string;
  /** VCS metadata the plugin already collected for the source-map upload. */
  vcs?: VcsMetadata;
  dryRun?: boolean;
  failOnError?: boolean;
  onError?: (error: unknown) => void;
  run?: RunFn;
  collectDebugIds?: (dir: string) => Promise<string[]>;
  findPackageName?: (from: string) => Promise<string | undefined>;
}

export type RegisterJsBuildResult =
  | { registered: true; dryRun: boolean; payload: JsBuildPayload }
  | { registered: false; reason: 'disabled' | 'not-release' | 'failed' };

/** Register this build, or say why not. Contained: returns `reason: 'failed'` unless `failOnError`. */
export async function registerJsBuild(
  options: RegisterJsBuildOptions,
): Promise<RegisterJsBuildResult> {
  if (options.appToken === '') {
    throw new Error('registerJsBuild: appToken is required');
  }
  const decision = resolveRegistration(options.setting, options.bundler, options.env);
  if (!decision.register) {
    // Decided before anything is read: a skipped registration costs nothing at all.
    return { registered: false, reason: decision.reason };
  }
  const dryRun = options.dryRun ?? false;
  const onError =
    options.onError ??
    ((error: unknown): void => {
      console.warn(`[bugsee] build registration skipped: ${String(error)}`);
    });

  let scratch: string | undefined;
  try {
    const debugIds = await (options.collectDebugIds ?? defaultCollectDebugIds)(options.outDir);
    const packageId =
      options.packageId ??
      (await (options.findPackageName ?? findPackageName)(options.projectRoot));
    const configuration = options.bundler.configuration ?? options.env.NODE_ENV;

    const payload: JsBuildPayload = {
      uuid: deriveBuildUuid(debugIds, {
        packageId,
        version: options.appVersion,
        build: options.appBuild,
        configuration: configuration ?? '',
      }),
      format: 'js',
      version: options.appVersion,
      build: options.appBuild,
      // Omitted, never sent empty: absence is how the backend tells "unknown" from "known empty".
      ...(packageId !== undefined ? { package_id: packageId } : {}),
      ...(configuration !== undefined && configuration !== ''
        ? { build_configuration: configuration }
        : {}),
      ...(options.vcs !== undefined ? { vcs: options.vcs } : {}),
    };

    // The CLI takes the payload as a FILE. The token is not in it — it travels in the child's
    // environment, exactly as for every other `bugsee-cli` call — so nothing secret reaches disk.
    scratch = await mkdtemp(join(tmpdir(), 'bugsee-build-'));
    const payloadPath = join(scratch, 'payload.json');
    await writeFile(payloadPath, JSON.stringify(payload));

    await (options.run ?? runBugseeCli)(
      ['upload', 'build', '--payload-json', payloadPath, ...(dryRun ? ['--dry-run'] : [])],
      { token: options.appToken, endpoint: options.endpoint },
    );
    return { registered: true, dryRun, payload };
  } catch (error) {
    if (options.failOnError === true) {
      throw error;
    }
    onError(error);
    return { registered: false, reason: 'failed' };
  } finally {
    if (scratch !== undefined) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch {
        // A temp directory that will not delete must not turn a registration that SUCCEEDED into a
        // failure, nor replace the error of one that did not. It holds no secret — see above.
      }
    }
  }
}
