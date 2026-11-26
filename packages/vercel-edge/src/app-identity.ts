import type { AppIdentity } from '@bugsee/core';

/** Console warning sink for launch-time diagnostics; never throws into the host. */
export const warnToConsole = (message: string): void => {
  (globalThis as unknown as { console?: { warn?: (m: string) => void } }).console?.warn?.(message);
};

/** How an edge function is told its version. */
export const EDGE_APP_VERSION_HINT =
  'Pass `appVersion` (and `appBuild`) to launch(), use the Bugsee Vite or webpack plugin (it defines `__BUGSEE_APP_VERSION__`), set BUGSEE_APP_VERSION (and BUGSEE_APP_BUILD) in the environment, or (Cloudflare) pass the `env` object as `bindings`.';

const present = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const trimmed = (value: unknown): string | undefined => (present(value) ? value.trim() : undefined);

/**
 * Identity from the edge process environment, then from the host's bindings, below the bundled constants.
 * `BUGSEE_APP_VERSION` / `BUGSEE_APP_BUILD` are read from `process.env` first (workerd populates it only for
 * newer compatibility dates), then from `bindings` (Cloudflare's per-deployment `env` object, which is the
 * reliable carrier there). A Cloudflare `CF_VERSION_METADATA` binding supplies the rest: its `tag` is the
 * version and its `id` the build, each only when nothing explicit answered. For the build alone, on Vercel
 * the deployed commit is the last fallback (the version has no platform-provided equivalent). Blank values
 * are skipped and a throwing environment is no environment.
 */
export const createEdgeAppIdentity =
  (bindings?: Record<string, unknown>) => (): AppIdentity | undefined => {
    let env: Record<string, string | undefined> | undefined;
    try {
      env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
        .process?.env;
    } catch {
      env = undefined;
    }
    const metadata = ((): { id?: unknown; tag?: unknown } => {
      const value = bindings?.CF_VERSION_METADATA;
      return typeof value === 'object' && value !== null ? value : {};
    })();
    if (env === undefined && bindings === undefined) {
      return undefined;
    }
    const identity: AppIdentity = {};
    const version =
      trimmed(env?.BUGSEE_APP_VERSION) ??
      trimmed(bindings?.BUGSEE_APP_VERSION) ??
      trimmed(metadata.tag);
    if (version !== undefined) {
      identity.version = version;
    }
    const build =
      trimmed(env?.BUGSEE_APP_BUILD) ??
      trimmed(bindings?.BUGSEE_APP_BUILD) ??
      trimmed(metadata.id) ??
      trimmed(env?.VERCEL_GIT_COMMIT_SHA);
    if (build !== undefined) {
      identity.build = build;
    }
    return identity;
  };

/** Identity from the edge process environment only; see {@link createEdgeAppIdentity}. */
export const edgeAppIdentity = createEdgeAppIdentity();
