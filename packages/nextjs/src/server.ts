// @bugsee/nextjs — server (Node runtime) composition.
//
// This module is the target of `await import('@bugsee/nextjs/server')` from the
// `NEXT_RUNTIME === 'nodejs'` branch of `register()` in `instrumentation.ts` (see
// docs/design/nextjs-adapter.md §3, hard-constraint 1: no Node code reachable from the edge/client
// graph). It composes the batteries-included node umbrella (`bugsee/node` = @bugsee/node launch +
// on-by-default performance/APM + the OpenTelemetry consume bridge) so the Next.js server gets full
// capture + reports + zero-config APM out of the box.
//
// OTel default-attach (design D4): `otelConsume` is turned ON so Next's native OTel spans, once they
// reach a TracerProvider, are assembled into native Bugsee transactions. The wired SpanProcessor is
// surfaced via `onSpanProcessor` so a user already running `@vercel/otel` can feed Next's spans into
// Bugsee with `registerOTel({ spanProcessors: [processor] })` (the Highlight coexistence pattern).
// Zero-config self-registration of a provider when none exists lands in N1b-2.
import {
  type Bugsee,
  type BugseeNodeLaunchOptions,
  type BugseeSpanProcessor,
  launch,
} from 'bugsee/node';

export type { Bugsee, BugseeSpanProcessor } from 'bugsee/node';

/**
 * Options for the Next.js server (Node) composition. Extends the batteries-included node umbrella
 * options (launch + performance + OTel); Next adds the `onSpanProcessor` seam.
 */
export interface NextjsServerOptions extends BugseeNodeLaunchOptions {
  /**
   * Receives the Bugsee OpenTelemetry `SpanProcessor` (the consume bridge). Register it on your
   * `TracerProvider`, or pass it to `@vercel/otel`'s `registerOTel({ spanProcessors: [processor] })`,
   * to feed Next.js's native spans into Bugsee. Called synchronously during launch. (Zero-config
   * self-registration when no provider exists lands in N1b-2.)
   */
  onSpanProcessor?: (processor: BugseeSpanProcessor) => void;
}

/**
 * Start Bugsee for the Next.js **server** (Node) runtime. Call from `register()` in
 * `instrumentation.ts` under the `NEXT_RUNTIME === 'nodejs'` branch (reached via `await import`) so
 * that no Node-only code is bundled into the edge or client graph. Returns the started client
 * (a per-process singleton — a repeat call under dev HMR returns the existing client).
 */
export function registerServer(appToken: string, options: NextjsServerOptions = {}): Bugsee {
  const { onSpanProcessor, ...launchOptions } = options;
  return launch(appToken, {
    // Default-attach the OTel consume bridge (D4); a caller may still override `otelConsume: false`.
    otelConsume: true,
    ...launchOptions,
    // Always own the span-processor seam so we can surface it (and, in N1b-2, self-register a provider).
    onOtelSpanProcessor: (processor) => {
      onSpanProcessor?.(processor);
    },
  });
}
