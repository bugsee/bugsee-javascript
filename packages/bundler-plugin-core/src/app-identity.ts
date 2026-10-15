// Where the plugin's app version and build number come from, and how they reach the app's own bundle.
//
// The same two values serve two purposes: they label the source-map upload / build registration, and
// they are baked into the bundle (as the `__BUGSEE_APP_VERSION__` / `__BUGSEE_APP_BUILD__` constants the
// runtime SDK reads) so a web app reports the version it was actually built as.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findNearestPackageVersion } from '@bugsee/core';
import type { EnvRecord } from './run-cli';

/** Commit-id variables set by common CI / hosting providers, in priority order. */
export const CI_COMMIT_ENV_VARS: readonly string[] = [
  'GITHUB_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'CI_COMMIT_SHA',
  'CIRCLE_SHA1',
  'BUILDKITE_COMMIT',
  'SOURCE_VERSION',
  'RENDER_GIT_COMMIT',
  'COMMIT_REF',
  'CF_PAGES_COMMIT_SHA',
  'GIT_COMMIT',
];

/** The build-time constants the runtime SDK looks for. */
export const APP_VERSION_DEFINE = '__BUGSEE_APP_VERSION__';
export const APP_BUILD_DEFINE = '__BUGSEE_APP_BUILD__';

/** Seams for the filesystem and the working directory, so resolution is testable and never throws. */
export interface AppIdentityDeps {
  readFile?: (path: string) => string;
  cwd?: () => string;
}

/** The first non-blank value among the variables, trimmed. */
function firstEnv(env: EnvRecord, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

/**
 * The `version` of the NEAREST package.json at or above `from` (the one shared rule, in `@bugsee/core`): a
 * monorepo app reports its own version rather than the workspace's, and a nearest manifest without a version
 * means no version. Synchronous and never throws.
 */
export function findPackageVersion(
  from: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  return findNearestPackageVersion(resolve(from), { readFile, dirname, join });
}

/** What was found; `undefined` for a value nothing supplied, so a real one is told apart from a default. */
export interface FoundAppIdentity {
  version: string | undefined;
  build: string | undefined;
}

/** The value when it has something in it, trimmed; blank and whitespace-only count as unset. */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * A constant the app's own bundler config already defines, as far as we can read it. A string is the value
 * the app will report (a JSON string literal), so it is also the identity to upload. `null` is a definition we
 * cannot read (an expression, a non-string): it is what the app reports, so no auto-detected value may be
 * uploaded in its place — only values the user gave explicitly. `undefined` means the constant is free and
 * detection applies.
 */
export interface FixedIdentity {
  version?: string | null;
  build?: string | null;
}

/** Both constants unreadable: a bundler path that cannot be told what the bundle will report. */
export const UNBAKEABLE_IDENTITY: FixedIdentity = { version: null, build: null };

/** The string a `define` value spells as a JSON string literal; null for anything else (or a blank one). */
function literalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' && parsed.trim() !== '' ? parsed : null;
  } catch {
    return null;
  }
}

/** What the user's own `define` entries (Vite, esbuild, a DefinePlugin) already fix for the two constants. */
export function fixedIdentityFromDefines(
  defines: Record<string, unknown> | undefined,
): FixedIdentity {
  const has = (key: string): boolean => defines !== undefined && key in defines;
  return {
    ...(has(APP_VERSION_DEFINE) ? { version: literalString(defines?.[APP_VERSION_DEFINE]) } : {}),
    ...(has(APP_BUILD_DEFINE) ? { build: literalString(defines?.[APP_BUILD_DEFINE]) } : {}),
  };
}

/**
 * Resolve version and build. Version: option, `BUGSEE_APP_VERSION`, the nearest package.json from `root`
 * (the BUNDLER's project directory, not the VCS root). Build: option, `BUGSEE_APP_BUILD`, a CI commit id.
 * A blank option or variable is "unset" everywhere, so it falls through rather than being uploaded or baked.
 * `root` (or, without one, `process.cwd()`) is consulted only when nothing earlier answered, and a throwing
 * working directory just means "not found". A `fixed` value (see FixedIdentity) overrides all of that for its
 * field: a literal is used as is; an unreadable one restricts the field to the explicit option / `BUGSEE_*`
 * variable, with no package.json or CI-commit detection.
 */
export function findAppIdentity(
  options: { appVersion?: string; appBuild?: string },
  env: EnvRecord,
  deps: AppIdentityDeps = {},
  root?: string,
  fixed: FixedIdentity = {},
): FoundAppIdentity {
  const explicitVersion = nonBlank(options.appVersion) ?? firstEnv(env, ['BUGSEE_APP_VERSION']);
  let version: string | undefined;
  if (fixed.version !== undefined) {
    version = fixed.version ?? explicitVersion;
  } else {
    version = explicitVersion;
    if (version === undefined) {
      try {
        version = findPackageVersion(root ?? (deps.cwd ?? process.cwd)(), deps.readFile);
      } catch {
        version = undefined;
      }
    }
  }
  const explicitBuild = nonBlank(options.appBuild) ?? firstEnv(env, ['BUGSEE_APP_BUILD']);
  const build =
    fixed.build !== undefined
      ? (fixed.build ?? explicitBuild)
      : (explicitBuild ?? firstEnv(env, CI_COMMIT_ENV_VARS));
  return { version, build };
}

/**
 * The `define` entries for the app's bundle: only for a value that was really found, never the `0.0.0` / `0`
 * placeholder, so an app with no known version keeps the runtime SDK's own fallbacks.
 */
export function appIdentityDefines(found: FoundAppIdentity): Record<string, string> {
  return {
    ...(found.version !== undefined ? { [APP_VERSION_DEFINE]: JSON.stringify(found.version) } : {}),
    ...(found.build !== undefined ? { [APP_BUILD_DEFINE]: JSON.stringify(found.build) } : {}),
  };
}
