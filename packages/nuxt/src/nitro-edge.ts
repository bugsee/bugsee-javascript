// @bugsee/nuxt — the Nitro server-error bridge for EDGE presets (`vercel-edge`/`cloudflare*`/`*-edge`). The
// U6 Nuxt Module ships this runtime plugin instead of the node one when `nuxt.options.nitro.preset` is an
// edge preset — so the edge SDK (`@bugsee/vercel-edge`, incident-driven, WinterCG fetch transport) gets
// bundled, never `bugsee/node`.
//
// Edge model: an isolate freezes the instant the Response returns, so an incident upload must be kept alive
// by `ctx.waitUntil`. Nitro owns the fetch entry (no per-request `run()` wrap exposed to a plugin), so this
// v1 reports on the `error` hook and flushes under the resolved `waitUntil` — Cloudflare's ExecutionContext
// (on `event.context.cloudflare.context`) or Vercel Edge's global request-context symbol. This delivers the
// moat's edge value (server errors reported from Nuxt-on-edge — a differentiator Sentry lacks). Full
// per-request context/trace correlation on edge needs Nitro fetch-entry wrapping — a documented v2.
import {
  type Bugsee,
  type BugseeEdgeLaunchOptions,
  type EdgeExecutionContext,
  launchEdge,
  resolveWaitUntil,
} from '@bugsee/vercel-edge';

/** The Nitro edge error-hook context subset we read (structural; no `nitropack` dep). On the Cloudflare
 *  preset, Nitro exposes the platform `ExecutionContext` (with `waitUntil`) at `event.context.cloudflare.context`. */
export interface EdgeNitroErrorContext {
  event?: {
    path?: string;
    method?: string;
    context?: { cloudflare?: { context?: EdgeExecutionContext } };
  };
  tags?: string[];
}

/** The Nitro app subset we use on edge — its `error` hook seam (structural; no `nitropack` dep). */
export interface EdgeNitroAppLike {
  hooks: {
    hook(event: 'error', handler: (error: unknown, context?: EdgeNitroErrorContext) => void): void;
  };
}

export interface InstallBugseeNitroEdgeOptions extends BugseeEdgeLaunchOptions {
  /** The Bugsee app token. */
  appToken: string;
  /** Test/advanced seam: the edge launch. Default `@bugsee/vercel-edge` `launchEdge`. */
  launch?: (appToken: string, options: BugseeEdgeLaunchOptions) => Bugsee;
}

/** An H3Error carries a numeric `statusCode`; a <500 status is an expected client error (404/422/…), not a
 *  crash worth reporting. (Edge-local copy — importing the node `nitro.ts` would pull `bugsee/node` into the
 *  edge bundle.) */
function isExpectedClientError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof statusCode === 'number' && statusCode < 500;
}

/**
 * Launch Bugsee for a Nuxt/Nitro EDGE server and wire the `error` hook to report incidents, keeping the
 * isolate alive for the upload via the resolved `waitUntil`. Returns the launched client. Call from a Nitro
 * server plugin: `export default defineNitroPlugin((nitroApp) => installBugseeNitroEdge(nitroApp, …))`.
 */
export function installBugseeNitroEdge(
  nitroApp: EdgeNitroAppLike,
  options: InstallBugseeNitroEdgeOptions,
): Bugsee {
  const { appToken, launch = launchEdge, ...launchOptions } = options;
  const client = launch(appToken, launchOptions);

  nitroApp.hooks.hook('error', (error, context) => {
    if (isExpectedClientError(error)) return;
    // Cloudflare passes the ExecutionContext on the event; Vercel Edge has none (resolveWaitUntil reads its
    // global request-context symbol instead).
    const ctx = context?.event?.context?.cloudflare?.context;
    const waitUntil = resolveWaitUntil(ctx);
    // Assemble + upload the incident, held past the Response by waitUntil. Best-effort — never break the edge
    // response.
    waitUntil(
      (async () => {
        try {
          await client.logException(error, { mechanism: 'http-error' });
          await client.flush();
        } catch {
          // swallow — the edge response is unaffected
        }
      })(),
    );
  });

  return client;
}
