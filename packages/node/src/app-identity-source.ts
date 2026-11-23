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
  /**
   * The running entry script (a file path). Consulted only when no `appRoot` is given AND the working
   * directory's search found no version (a container `WORKDIR /`, a service manager's cwd): its directory is
   * then searched the same way. Default none; the launch passes `process.argv[1]` / `Bun.main`.
   */
  entryPoint?: () => string | undefined;
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
      return value.trim();
    }
  }
  return undefined;
};

/**
 * Finds the app's version and build on a server or desktop host: `BUGSEE_APP_VERSION` first, then the nearest
 * `package.json` from `appRoot` (else the working directory); a nearest manifest without a version means no
 * version, and a parent's is not adopted. `npm_package_version` is deliberately NOT read: npm/pnpm export the
 * version of the package whose SCRIPT runs and child processes inherit it, so a workspace-root `npm start`
 * spawning an app would report the root's version while the bundler plugin (which walks package.json the same
 * way) labels the maps with the app's own. The build comes from CI/host commit variables. The `package.json`
 * search is done lazily and at most once.
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
      const explicitRoot =
        options.appRoot !== undefined && options.appRoot !== '' ? options.appRoot : undefined;
      const find = (start: string | undefined): string | undefined =>
        start === undefined
          ? undefined
          : findNearestPackageVersion(start, { readFile, dirname, join });
      let value = find(explicitRoot ?? cwd());
      if (value === undefined && explicitRoot === undefined && options.entryPoint !== undefined) {
        try {
          const entry = options.entryPoint();
          // An entry under node_modules is a TOOL's script (tsx/vitest/npx resolve argv[1] there), never the app:
          // walking up from it would stamp the report with the tool's version.
          const underModules = entry !== undefined && /(^|[\\/])node_modules([\\/]|$)/.test(entry);
          value =
            entry === undefined || entry === '' || underModules ? undefined : find(dirname(entry));
        } catch {
          value = undefined; // an entry point that cannot be read is simply unknown
        }
      }
      searched = { value };
    }
    return searched.value;
  };
  return (): AppIdentity => {
    const identity: AppIdentity = {};
    const version = firstSet(env, ['BUGSEE_APP_VERSION']) ?? fromPackageJson();
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
