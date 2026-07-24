// @bugsee/nuxt — the Nitro server-error bridge (the moat's server half).
//
// Nuxt's server is the Nitro engine; a Nitro server plugin runs `installBugseeNitro(nitroApp, …)` at server
// startup: it launches the node SDK (whose node:http emit-patch opens a per-request context + http.server
// txn — no `--import` preload needed, unlike Sentry's IITM approach) and subscribes to Nitro's `error` hook
// (the `onRequestError` analog), reporting real crashes stitched to the session via the shared kit.
//
// The logic is a pure function over a structural `NitroAppLike` so it is fully unit-testable; the U3 runtime
// file wraps it with `defineNitroPlugin` (from `nitropack/runtime`) + `useRuntimeConfig()`.
import { reportServerError, traceMetaTag } from '@bugsee/adapter-kit';
import {
  type Bugsee,
  type BugseeNodeLaunchOptions,
  launch as nodeLaunch,
} from '@bugsee/bugsee/node';

/** The Nitro error-hook context subset we read (structural; no `nitropack` dep). */
export interface NitroErrorContext {
  /** The H3 event (its `path`/`method` identify the failing route). */
  event?: { path?: string; method?: string };
  /** Nitro source tags: `'request'` | `'response'` | `'plugin'` | `'unhandledRejection'` | … */
  tags?: string[];
}

/** The Nitro/Nuxt `render:html` context subset we mutate — `head` fragments concatenated into the SSR
 *  `<head>` (structural; no `nitropack`/`nuxt` dep). */
export interface NitroRenderHtmlContext {
  head: string[];
}

/** The Nitro app subset we use — its `hooks.hook(…)` seams for `error` (report) + `render:html` (trace
 *  `<meta>` injection) (structural; no `nitropack` dep). */
export interface NitroAppLike {
  hooks: {
    hook(event: 'error', handler: (error: unknown, context?: NitroErrorContext) => void): void;
    hook(event: 'render:html', handler: (html: NitroRenderHtmlContext) => void): void;
  };
}

export interface InstallBugseeNitroOptions extends BugseeNodeLaunchOptions {
  /** The Bugsee app token. */
  appToken: string;
  /** Test/advanced seam: the node launch. Default the batteries-included `bugsee/node` umbrella launch. */
  launch?: (appToken: string, options: BugseeNodeLaunchOptions) => Bugsee;
  /** Inject `<meta name="traceparent">` into the SSR `<head>` (via `render:html`) so the client pageload
   *  adopts the server-request trace (FE↔BE join, the moat's correlation capstone). Default `true`. */
  injectTraceMeta?: boolean;
}

/** An H3Error carries a numeric `statusCode`; a <500 status is an expected client error (404/422/…), not a
 *  crash worth reporting. */
function isExpectedClientError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  return typeof statusCode === 'number' && statusCode < 500;
}

/**
 * Launch Bugsee for the Nuxt/Nitro server and wire the `error` hook (report) + `render:html` hook (trace
 * `<meta>` injection). Returns the launched client. Call from a Nitro server plugin:
 * `export default defineNitroPlugin((nitroApp) => installBugseeNitro(nitroApp, …))`.
 */
export function installBugseeNitro(
  nitroApp: NitroAppLike,
  options: InstallBugseeNitroOptions,
): Bugsee {
  const { appToken, launch = nodeLaunch, injectTraceMeta = true, ...launchOptions } = options;
  const client = launch(appToken, launchOptions);

  nitroApp.hooks.hook('error', (error, context) => {
    if (isExpectedClientError(error)) return;
    const tags = context?.tags;
    reportServerError(error, {
      getClient: () => client,
      event: {
        name: 'nuxt.request-error',
        params: {
          ...(context?.event?.method !== undefined ? { method: context.event.method } : {}),
          ...(context?.event?.path !== undefined ? { path: context.event.path } : {}),
          ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
        },
      },
      mechanism: 'http-error',
    });
  });

  // FE↔BE trace join: inject the active request's `<meta name="traceparent">` into the SSR `<head>` so the
  // browser pageload adopts the server trace. `render:html` runs inside the run-scoped request context, so
  // `traceMetaTag` sees the active trace; it yields `''` (nothing injected) when no trace is active.
  if (injectTraceMeta) {
    nitroApp.hooks.hook('render:html', (html) => {
      // Best-effort: trace injection must NEVER break SSR rendering (interceptors must not alter app
      // behavior). traceMetaTag is already total; this guards the `head.push` against a non-conformant host.
      try {
        const tag = traceMetaTag({ getClient: () => client });
        if (tag !== '') html.head.push(tag);
      } catch {
        // swallow — a page renders fine without the trace meta
      }
    });
  }

  return client;
}
