// SM-A3 — user-facing plugin option resolution + the guarded upload entry. Merges explicit plugin options
// with environment variables, applies defaults, and decides whether the plugin is active (a token is
// required; a build without one is a no-op rather than an error). Pure + injectable for testing.

import {
  uploadSourcemaps as defaultUploadSourcemaps,
  type UploadSourcemapsResult,
} from './orchestrate';
import type { EnvRecord } from './run-cli';

/** User-facing options for the Bugsee bundler plugin. */
export interface BugseePluginOptions {
  /** Bugsee app token. Falls back to `BUGSEE_APP_TOKEN`. Required to upload; absent ⇒ the plugin no-ops. */
  appToken?: string;
  /** App version. Falls back to `BUGSEE_APP_VERSION`, else `0.0.0`. */
  appVersion?: string;
  /** Build number. Falls back to `BUGSEE_APP_BUILD`, else `0`. */
  appBuild?: string;
  /** API endpoint override. Falls back to `BUGSEE_ENDPOINT`. */
  endpoint?: string;
  /** Delete client `.map`s after upload. Default `true`. */
  deleteMaps?: boolean;
  /** Run bugsee-cli with `--dry-run` (no upload, no deletion). */
  dryRun?: boolean;
  /** Disable the plugin entirely (e.g. dev builds). */
  disabled?: boolean;
  /**
   * FAIL the build when the source-map upload fails. Default `false` (Wave 7).
   *
   * A telemetry side effect must not be able to break a production deploy: before this, an expired token,
   * a transient network error or a `bugsee-cli` missing from PATH aborted the user's build with no escape
   * hatch. Teams that would rather stop on a failed upload opt in.
   */
  failOnError?: boolean;
  /** Where a contained failure is reported. Default: a console warning naming the plugin. */
  onError?: (error: unknown) => void;
}

export interface ResolvedPluginOptions {
  /** Whether the plugin should act (a token is present and it isn't disabled). */
  enabled: boolean;
  appToken: string;
  appVersion: string;
  appBuild: string;
  endpoint: string | undefined;
  deleteMaps: boolean;
  dryRun: boolean;
  /** Whether a failed upload should abort the build. Default false. */
  failOnError: boolean;
  /** Failure sink for the contained path. */
  onError?: (error: unknown) => void;
}

/** Merge plugin options with env vars, apply defaults, and decide whether the plugin is active. */
export function resolvePluginOptions(
  options: BugseePluginOptions,
  env: EnvRecord,
): ResolvedPluginOptions {
  const appToken = options.appToken ?? env.BUGSEE_APP_TOKEN ?? '';
  return {
    enabled: !options.disabled && appToken !== '',
    appToken,
    appVersion: options.appVersion ?? env.BUGSEE_APP_VERSION ?? '0.0.0',
    appBuild: options.appBuild ?? env.BUGSEE_APP_BUILD ?? '0',
    endpoint: options.endpoint ?? env.BUGSEE_ENDPOINT,
    deleteMaps: options.deleteMaps ?? true,
    dryRun: options.dryRun ?? false,
    failOnError: options.failOnError ?? false,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  };
}

/** Run the upload for a resolved config against a build output dir — a no-op when the plugin is disabled. */
export async function runPluginUpload(
  resolved: ResolvedPluginOptions,
  outDir: string,
  deps: { uploadSourcemaps?: typeof defaultUploadSourcemaps } = {},
): Promise<UploadSourcemapsResult | undefined> {
  if (!resolved.enabled) {
    return undefined;
  }
  const uploadSourcemaps = deps.uploadSourcemaps ?? defaultUploadSourcemaps;
  return uploadSourcemaps({
    outDir,
    appToken: resolved.appToken,
    appVersion: resolved.appVersion,
    appBuild: resolved.appBuild,
    endpoint: resolved.endpoint,
    deleteMaps: resolved.deleteMaps,
    dryRun: resolved.dryRun,
    failOnError: resolved.failOnError,
    ...(resolved.onError !== undefined ? { onError: resolved.onError } : {}),
  });
}
