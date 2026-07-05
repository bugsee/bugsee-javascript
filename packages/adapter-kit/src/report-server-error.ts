// @bugsee/adapter-kit — the server-error bridge (P4): stitch a framework's server-side throw to the
// active Bugsee session. Shared by every SSR meta-framework adapter (Next.js `onRequestError`, SvelteKit
// `handleError`, Remix `handleError`, Nuxt `nitroApp.hooks('error')`, Astro middleware catch) — each maps
// its framework's error context to a capture `event`, then delegates the reporting here.
//
// RUNTIME-PORTABLE (node + edge): uses only @bugsee/core APIs. Correlation to the session is automatic —
// `logException` snapshots the active per-request context. Fully defensive: never throws out of the hook.
import { type BugseeClient, getCarrierClient, type LogExceptionOptions } from '@bugsee/core';

export interface ReportServerErrorOptions {
  /** Resolve the Bugsee client. Default: the process/isolate carrier singleton. */
  getClient?: () => BugseeClient | undefined;
  /** A capture event stamping the framework's route attribution (name + params) onto the recording. */
  event?: { name: string; params?: Record<string, unknown> };
  /** `logException` mechanism. Default `'http-error'`. */
  mechanism?: NonNullable<LogExceptionOptions['mechanism']>;
}

/**
 * Report a framework server-side error to Bugsee, correlated to the active session. Optionally captures a
 * route-attribution `event` first. Never throws — safe to call from any framework error hook.
 */
export function reportServerError(error: unknown, options: ReportServerErrorOptions = {}): void {
  try {
    const client = (options.getClient ?? (() => getCarrierClient<BugseeClient>()))();
    if (client === undefined) return;
    if (options.event !== undefined) {
      client.event(options.event.name, options.event.params);
    }
    void client.logException(error, { mechanism: options.mechanism ?? 'http-error' });
  } catch {
    // Never replace / disrupt the framework's own error handling.
  }
}
