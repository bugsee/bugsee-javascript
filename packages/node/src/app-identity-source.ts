import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { type AppIdentity, type AppIdentitySource, findNearestPackageVersion } from '@bugsee/core';

/** Commit variables set by CI systems and hosting platforms, in the order they are tried. */
const BUILD_ENV_VARS = [
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
] as const;

export interface NodeAppIdentitySourceOptions {
  /** Environment variables. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** The working directory. Default `process.cwd()`, or nothing when that has been deleted. */
  cwd?: () => string | undefined;
  /** Reads a file as text. Default `fs.readFileSync`. */
  readFile?: (path: string) => string;
  /** Directory to start looking for `package.json` in. Default the working directory. */
  appRoot?: string;
}

const defaultCwd = (): string | undefined => {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
};

const present = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const firstSet = (
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined => {
  for (const name of names) {
    const value = env[name];
    if (present(value)) {
      return value;
    }
  }
  return undefined;
};

/**
 * Finds the app's version and build on a server or desktop host: environment overrides first, then the
 * version npm exports to scripts, then the nearest `package.json` (a nearest manifest without a version means no version; a parent's is not adopted); the build comes from CI/host commit
 * variables. The `package.json` search is done lazily and at most once.
 */
export const createNodeAppIdentitySource = (
  options: NodeAppIdentitySourceOptions = {},
): AppIdentitySource => {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? defaultCwd;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let searched: { value: string | undefined } | undefined;
  const fromPackageJson = (): string | undefined => {
    if (searched === undefined) {
      const start =
        options.appRoot !== undefined && options.appRoot !== '' ? options.appRoot : cwd();
      searched = {
        value:
          start === undefined
            ? undefined
            : findNearestPackageVersion(start, { readFile, dirname, join }),
      };
    }
    return searched.value;
  };
  return (): AppIdentity => {
    const identity: AppIdentity = {};
    const version =
      firstSet(env, ['BUGSEE_APP_VERSION', 'npm_package_version']) ?? fromPackageJson();
    if (version !== undefined) {
      identity.version = version;
    }
    const build = firstSet(env, ['BUGSEE_APP_BUILD', ...BUILD_ENV_VARS]);
    if (build !== undefined) {
      identity.build = build;
    }
    return identity;
  };
};
