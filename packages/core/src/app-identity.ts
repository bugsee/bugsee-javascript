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
 * Settles the app identity: an explicit option wins (an empty string is an explicit choice), otherwise
 * each field comes from the first source that has a usable value. A missing version is reported once
 * through `warn`; a missing build is not (it is a refinement of the version).
 */
export const resolveAppIdentity = (
  explicit: AppIdentity,
  sources: readonly AppIdentitySource[],
  warn?: (message: string) => void,
): AppIdentity => {
  const resolved: AppIdentity = {};
  for (const field of ['version', 'build'] as const) {
    const given = explicit[field];
    if (given !== undefined) {
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
      warn?.(
        'Bugsee: the app version could not be detected, so reports will show 0.0.0. Pass `appVersion` (and `appBuild`) to launch(), or set BUGSEE_APP_VERSION.',
      );
    } catch {
      // A broken warning sink must never break launch.
    }
  }
  return resolved;
};
