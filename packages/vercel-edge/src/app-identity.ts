import type { AppIdentity } from '@bugsee/core';

/** Console warning sink for launch-time diagnostics; never throws into the host. */
export const warnToConsole = (message: string): void => {
  (globalThis as unknown as { console?: { warn?: (m: string) => void } }).console?.warn?.(message);
};

/** How an edge function is told its version. */
export const EDGE_APP_VERSION_HINT =
  'Pass `appVersion` (and `appBuild`) to launch(), use the Bugsee Vite or webpack plugin (it defines `__BUGSEE_APP_VERSION__`), or set BUGSEE_APP_VERSION (and BUGSEE_APP_BUILD) in the environment.';

const present = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Identity from the edge process environment, below the bundled constants: `BUGSEE_APP_VERSION` and
 * `BUGSEE_APP_BUILD`; for the build alone, on Vercel the deployed commit is the fallback (the version has
 * no platform-provided equivalent). Blank values are skipped and a throwing environment is no environment.
 */
export const edgeAppIdentity = (): AppIdentity | undefined => {
  let env: Record<string, string | undefined> | undefined;
  try {
    env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
  } catch {
    return undefined;
  }
  if (env === undefined) {
    return undefined;
  }
  const identity: AppIdentity = {};
  if (present(env.BUGSEE_APP_VERSION)) {
    identity.version = env.BUGSEE_APP_VERSION;
  }
  const build = [env.BUGSEE_APP_BUILD, env.VERCEL_GIT_COMMIT_SHA].find(present);
  if (build !== undefined) {
    identity.build = build;
  }
  return identity;
};
