// @bugsee/nextjs — the client↔server trace channel (the moat's correlation capstone).
//
// `getBugseeTraceData()` reads the ACTIVE server-request trace and returns it as a W3C `traceparent`,
// for injection into the SSR'd HTML via `generateMetadata()`. The `@bugsee/browser` client reads
// `<meta name="traceparent">` on pageload and adopts that trace id — so the initial page's CLIENT session
// and the SSR SERVER request become ONE trace (BE→FE continuation). Combined with the FE→BE header
// propagation the platform launches already wire, this closes the loop: the client session and the server
// throw the N3 `onRequestError` bridge reports share a single trace.
//
// RUNTIME-PORTABLE: runs in `generateMetadata()` on the node OR edge server runtime, so it reads the trace
// through the portable core `ContextProvider` (`RequestContext.trace`) — never the node-only context store
// or the DOM-touching performance extension. Fully defensive — never throws out of `generateMetadata`.
import { type BugseeClient, ContextProviderToken, getCarrierClient } from '@bugsee/core';

/** W3C trace-context version (`traceparent` = `<version>-<traceId>-<spanId>-<flags>`). */
const W3C_VERSION = '00';

export interface GetBugseeTraceDataOptions {
  /** Resolve the Bugsee client. Default: the process/isolate carrier singleton. */
  getClient?: () => BugseeClient | undefined;
}

/**
 * Read the active server-request trace as Next.js `Metadata.other` entries — spread the result into
 * `generateMetadata()`'s `other` so Next renders `<meta name="traceparent" content="…">` and the browser
 * client adopts the SSR trace. Returns `{}` when no trace is active (no `<meta>` emitted).
 *
 * ```ts
 * // app/layout.tsx (App Router)
 * import { getBugseeTraceData } from '@bugsee/nextjs';
 * export function generateMetadata() {
 *   return { other: getBugseeTraceData() };
 * }
 * ```
 */
export function getBugseeTraceData(
  options: GetBugseeTraceDataOptions = {},
): Record<string, string> {
  try {
    const client = (options.getClient ?? (() => getCarrierClient<BugseeClient>()))();
    if (client === undefined) return {};
    const provider = client
      .getServiceProvider(ContextProviderToken)
      .getImmediate({ optional: true });
    const trace = provider?.getCurrent()?.trace;
    if (trace === undefined) return {};
    const flags = trace.sampled ? '01' : '00';
    return { traceparent: `${W3C_VERSION}-${trace.traceId}-${trace.spanId}-${flags}` };
  } catch {
    // Never break generateMetadata — a missing context/provider just yields no continuation.
    return {};
  }
}
