import type { Bugsee, BugseeEdgeLaunchOptions } from '@bugsee/vercel-edge';
import { launch } from './launch';

// Shared launch config + a lazy per-isolate launcher (docs/design/edge-runtime.md C2). Because `env` (and thus
// the app token, a Worker SECRET) is NOT available at module scope on Cloudflare, the client must be launched
// from inside a handler/constructor where `env` exists. Both `withBugsee` (handler objects / WorkerEntrypoint
// classes) and `instrumentDurableObject` reuse this so the launch happens lazily on the first invocation/
// construction and is cached for the isolate's lifetime.

/** Launch config for a Cloudflare Worker: a CALLBACK that receives `env` (the usual case — the token is a
 *  Worker secret), or a static token string / options object when the token is a plain constant. */
export type BugseeWorkerConfig =
  | string
  | (BugseeEdgeLaunchOptions & { appToken: string })
  | ((env: unknown) => string | (BugseeEdgeLaunchOptions & { appToken: string }));

/** Resolve a config (invoking the callback with `env` when it is one) into `{ appToken, options }`. */
export function resolveConfig(
  config: BugseeWorkerConfig,
  env: unknown,
): { appToken: string; options: BugseeEdgeLaunchOptions } {
  const value = typeof config === 'function' ? config(env) : config;
  if (typeof value === 'string') {
    return { appToken: value, options: {} };
  }
  const { appToken, ...options } = value;
  return { appToken, options };
}

/** A per-isolate lazy launcher: launches the Cloudflare client on the first call (from `env`) and caches it, so
 *  later invocations/constructions in the same isolate reuse the one started client. */
export function createLazyLauncher(config: BugseeWorkerConfig): (env: unknown) => Bugsee {
  let client: Bugsee | undefined;
  return (env: unknown): Bugsee => {
    if (client === undefined) {
      const { appToken, options } = resolveConfig(config, env);
      client = launch(appToken, options);
    }
    return client;
  };
}
