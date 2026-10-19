/** The application's own version and build, as reported in `environment.app`. */
export interface AppIdentity {
  version?: string;
  build?: string;
}

/** Something that may know the app identity. May throw or return nothing. */
export type AppIdentitySource = () => AppIdentity | undefined;

// Build-time constants. A bundler `define` (the Bugsee Vite/webpack plugins inject these) replaces the
// identifier with a string literal; without one the identifier is looked up as a global, so a page may
// also set them itself. `typeof` keeps the lookup from throwing when neither exists.
declare const __BUGSEE_APP_VERSION__: unknown;
declare const __BUGSEE_APP_BUILD__: unknown;

/** The identity injected at build time, if any. */
export const bundledAppIdentity = (): AppIdentity => {
  const identity: AppIdentity = {};
  if (typeof __BUGSEE_APP_VERSION__ === 'string') {
    identity.version = __BUGSEE_APP_VERSION__;
  }
  if (typeof __BUGSEE_APP_BUILD__ === 'string') {
    identity.build = __BUGSEE_APP_BUILD__;
  }
  return identity;
};

const usable = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Settles the app identity: an explicit option wins (an empty string is an explicit choice; a
 * whitespace-only one is a stray newline, not a choice, and counts as unset), otherwise each field comes
 * from the first source that has a usable value. A missing version is reported once
 * through `warn`; a missing build is not (it is a refinement of the version). `hint` says how THIS runtime
 * is told its version (a browser has no environment variables, a server does) and ends the warning.
 */
export const resolveAppIdentity = (
  explicit: AppIdentity,
  sources: readonly AppIdentitySource[],
  warn?: (message: string) => void,
  hint = 'Pass `appVersion` (and `appBuild`) to launch().',
): AppIdentity => {
  const resolved: AppIdentity = {};
  for (const field of ['version', 'build'] as const) {
    const given = explicit[field];
    if (given !== undefined && (given === '' || usable(given))) {
      resolved[field] = given;
      continue;
    }
    for (const source of sources) {
      let found: unknown;
      try {
        found = source()?.[field];
      } catch {
        continue;
      }
      if (usable(found)) {
        resolved[field] = found;
        break;
      }
    }
  }
  if (resolved.version === undefined) {
    try {
      warn?.(`Bugsee: the app version could not be detected, so reports will show 0.0.0. ${hint}`);
    } catch {
      // A broken warning sink must never break launch.
    }
  }
  return resolved;
};

/** How many directories (the start included) are searched for a `package.json`. */
export const PACKAGE_VERSION_MAX_DEPTH = 12;

/** The path primitives and file read the manifest walk needs; the platform supplies them. */
export interface PackageVersionIo {
  /** Reads a file as text; may throw. */
  readFile: (path: string) => string;
  /** The parent directory of a path; the same path at the root. */
  dirname: (path: string) => string;
  /** Joins a directory and a file name. */
  join: (dir: string, name: string) => string;
}

/**
 * The `version` of the NEAREST `package.json` at or above `start`. Nearest, so a workspace app reports its
 * own version rather than the monorepo root's: a manifest that parses but has no usable version ENDS the
 * search with no version, while a missing or unparseable file keeps it walking. Searches at most
 * {@link PACKAGE_VERSION_MAX_DEPTH} directories. Never throws.
 *
 * `skipMarkers` also walks past a manifest with neither a usable version NOR a usable name: a module-scope
 * marker such as the `{"type":"commonjs"}` a dual build leaves in `dist/cjs`, which describes no package.
 * Only for a walk that starts INSIDE build output (Rollup's output directory); a named manifest still ends
 * the search, so a workspace app is never given its root's version.
 */
export const findNearestPackageVersion = (
  start: string,
  io: PackageVersionIo,
  { skipMarkers = false }: { skipMarkers?: boolean } = {},
): string | undefined => {
  let dir = start;
  for (let depth = 0; depth < PACKAGE_VERSION_MAX_DEPTH; depth++) {
    try {
      const parsed: unknown = JSON.parse(io.readFile(io.join(dir, 'package.json')));
      if (typeof parsed === 'object' && parsed !== null) {
        const { version, name } = parsed as { version?: unknown; name?: unknown };
        if (usable(version)) {
          return version.trim();
        }
        if (!skipMarkers || usable(name)) {
          return undefined;
        }
      }
    } catch {
      // Missing, unreadable or invalid: keep walking.
    }
    const parent = io.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
};
