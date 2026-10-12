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
import { asInternalClient, getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  type BugseeEdgeLaunchOptions,
  DEFERRED_FLUSH_TIMEOUT_MS,
  type EdgeExecutionContext,
  launchEdge,
  resolveWaitUntil,
} from '@bugsee/vercel-edge';
import { relaunchEdge, rememberEdgeLaunch } from '@bugsee/vercel-edge/relaunch-edge';

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
  /**
   * Deadline in milliseconds for the incident flush held past the Response by `waitUntil`. Defaults to
   * the edge tier's `DEFERRED_FLUSH_TIMEOUT_MS`. Bounded on purpose: a bundle's retry ladder is
   * 10s + 20s + 40s in `createIssue` and again in the signed PUT, so an unbounded flush asks the isolate
   * to stay alive ~140 s — past any platform's extend-lifetime budget, so it is killed mid-flight anyway.
   */
  flushTimeoutMs?: number;
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
  const {
    appToken,
    launch = launchEdge,
    flushTimeoutMs = DEFERRED_FLUSH_TIMEOUT_MS,
    ...launchOptions
  } = options;
  const client = launch(appToken, launchOptions);
  rememberEdgeLaunch(launch, launchOptions.carrier); // the default for a plain relaunch()
  // The hook outlives this client: `relaunch()` stops it and starts another. Resolve the CURRENT client per
  // error (the carrier slot), keeping the launched one as the fallback while the slot is empty.
  const current = (): Bugsee => getCarrierClient<Bugsee>(launchOptions.carrier) ?? client;

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
          const target = current();
          await asInternalClient(target).logException(error, { mechanism: 'http-error' });
          // A non-finite deadline means NO deadline: `flush` races `sleep(timeout)`, and
          // `setTimeout(fn, Infinity)` coerces to 0 and fires at once, which would abandon immediately.
          const delivered = await target.flush(
            Number.isFinite(flushTimeoutMs) ? flushTimeoutMs : (undefined as unknown as number),
          );
          if (delivered === false) {
            // Abandoned on the deadline rather than completed. The edge tier has no durable queue, so
            // this incident is gone — reporting it is what makes that a tuning problem rather than an
            // invisible one.
            launchOptions.onError?.(
              new Error(
                `Bugsee: incident upload did not finish within ${flushTimeoutMs}ms and was abandoned; ` +
                  'raise flushTimeoutMs if your platform budget allows.',
              ),
            );
          }
        } catch {
          // swallow — the edge response is unaffected
        }
      })(),
    );
  });

  return client;
}

// API parity with the umbrella entries: the same VALUE surface, thin re-exports of the same functions.
export {
  addReportAttachment,
  BugseeStatus,
  getDefaultNetworkSanitizer,
  getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
} from '@bugsee/vercel-edge';

/** Options for the edge {@link relaunch}: the launch options plus the same launch seam as {@link InstallBugseeNitroEdgeOptions}. */
export interface NitroEdgeRelaunchOptions extends BugseeEdgeLaunchOptions {
  /** The edge launch to re-run. Default `@bugsee/vercel-edge` `launchEdge`. */
  launch?: (appToken: string, options: BugseeEdgeLaunchOptions) => Bugsee;
}

/**
 * Stop the running client and launch again with the remembered token through the SAME launch seam
 * `installBugseeNitroEdge` was installed with (default `launchEdge`), so a custom launch (e.g. Cloudflare's) is re-run
 * rather than silently replaced by the plain edge one the `@bugsee/vercel-edge` `relaunch` would use.
 * That install-time seam is remembered on the carrier and is the DEFAULT here; an explicit `launch`
 * argument wins and is remembered in turn. The installed Nitro hooks follow
 * the new client.
 * Bugsee options return to their defaults; integration seams are kept. Rejects when nothing was launched.
 */
export function relaunch(options: NitroEdgeRelaunchOptions = {}): Promise<Bugsee> {
  return relaunchEdge(options);
}
