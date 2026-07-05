// @bugsee/adapter-kit — the trace-data primitive (P5): read the active server-request trace as a W3C
// `traceparent`, for injecting into the SSR HTML (`<meta name="traceparent">`) so the client pageload
// adopts the server trace (BE→FE continuation, the moat's correlation capstone). Shared by every SSR
// meta-framework adapter (Next.js `generateMetadata`, SvelteKit `transformPageChunk`, Nuxt `render:html`,
// Remix `getMetaTagTransformer`, Astro middleware HTML rewrite).
//
// RUNTIME-PORTABLE (node + edge): reads the trace through the core `ContextProvider` (`RequestContext.trace`)
// — never a node-only store or the DOM performance ext. Fully defensive — never throws.
import { type BugseeClient, ContextProviderToken, getCarrierClient } from '@bugsee/core';

/** W3C trace-context version (`traceparent` = `<version>-<traceId>-<spanId>-<flags>`). */
const W3C_VERSION = '00';

export interface TraceDataOptions {
  /** Resolve the Bugsee client. Default: the process/isolate carrier singleton. */
  getClient?: () => BugseeClient | undefined;
}

/** The active server-request trace as a W3C `traceparent` string, or `undefined` when none is active. */
export function getTraceparent(options: TraceDataOptions = {}): string | undefined {
  try {
    const client = (options.getClient ?? (() => getCarrierClient<BugseeClient>()))();
    if (client === undefined) return undefined;
    const provider = client
      .getServiceProvider(ContextProviderToken)
      .getImmediate({ optional: true });
    const trace = provider?.getCurrent()?.trace;
    if (trace === undefined) return undefined;
    return `${W3C_VERSION}-${trace.traceId}-${trace.spanId}-${trace.sampled ? '01' : '00'}`;
  } catch {
    return undefined;
  }
}

/** The active trace as `{ traceparent }` meta entries (or `{}`) — spread into a framework's SSR `<meta>`
 *  injection / metadata surface. */
export function traceMetaEntries(options: TraceDataOptions = {}): Record<string, string> {
  const traceparent = getTraceparent(options);
  return traceparent === undefined ? {} : { traceparent };
}
