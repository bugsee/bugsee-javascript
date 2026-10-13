// Where the plugin's app version and build number come from, and how they reach the app's own bundle.
//
// The same two values serve two purposes: they label the source-map upload / build registration, and
// they are baked into the bundle (as the `__BUGSEE_APP_VERSION__` / `__BUGSEE_APP_BUILD__` constants the
// runtime SDK reads) so a web app reports the version it was actually built as.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
 * The `version` of the NEAREST package.json at or above `from`. Nearest, so a monorepo app reports its own
 * version rather than the workspace's; a package.json without a version stops the search (it is the app's,
 * it just has no version), while a missing or unparseable one keeps walking. Synchronous and never throws.
 */
export function findPackageVersion(
  from: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  let dir = resolve(from);
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(readFile(join(dir, 'package.json')));
      if (typeof pkg === 'object' && pkg !== null) {
        const version = (pkg as { version?: unknown }).version;
        return typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined;
      }
    } catch {
      // No package.json here, or not one that parses — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** What was found; `undefined` for a value nothing supplied, so a real one is told apart from a default. */
export interface FoundAppIdentity {
  version: string | undefined;
  build: string | undefined;
}

/**
 * Resolve version and build. Version: option, `BUGSEE_APP_VERSION`, the nearest package.json. Build: option,
 * `BUGSEE_APP_BUILD`, a CI commit id. `process.cwd()` is consulted only when nothing earlier answered, and
 * a throwing one (an unlinked working directory) just means "not found".
 */
export function findAppIdentity(
  options: { appVersion?: string; appBuild?: string; projectRoot?: string },
  env: EnvRecord,
  deps: AppIdentityDeps = {},
): FoundAppIdentity {
  let version = options.appVersion ?? firstEnv(env, ['BUGSEE_APP_VERSION']);
  if (version === undefined) {
    try {
      version = findPackageVersion(
        options.projectRoot ?? (deps.cwd ?? process.cwd)(),
        deps.readFile,
      );
    } catch {
      version = undefined;
    }
  }
  const build = options.appBuild ?? firstEnv(env, ['BUGSEE_APP_BUILD', ...CI_COMMIT_ENV_VARS]);
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
