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
// Bugsee with `registerOTel({ spanProcessors: [processor] })` (the Highlight coexistence pattern). AND
// (N1b-2) when NO OTel provider is registered, we zero-config self-register one carrying that processor
// (fire-and-forget, first-wins) so Next emits its spans with no user OTel setup — see ./otel-provider.

import {
  type Bugsee,
  type BugseeNodeLaunchOptions,
  type BugseeSpanProcessor,
  launch,
} from '@bugsee/bugsee/node';
import { relaunchWith } from '@bugsee/core';
import { attachBugseeOtelProvider } from './otel-provider';

export type { Bugsee, BugseeSpanProcessor } from '@bugsee/bugsee/node';
// The built-in network redaction, for composing with a custom `setNetworkEventFilter` (which REPLACES the
// default sanitizer rather than layering on it).
export { type DefaultNetworkSanitizer, getDefaultNetworkSanitizer } from '@bugsee/bugsee/node';
export {
  type AttachOtelProviderOptions,
  attachBugseeOtelProvider,
  type OtelProviderOutcome,
} from './otel-provider';

/**
 * Options for the Next.js server (Node) composition. Extends the batteries-included node umbrella
 * options (launch + performance + OTel); Next adds the `onSpanProcessor` seam.
 */
export interface NextjsServerOptions extends BugseeNodeLaunchOptions {
  /**
   * Receives the Bugsee OpenTelemetry `SpanProcessor` (the consume bridge). Register it on your
   * `TracerProvider`, or pass it to `@vercel/otel`'s `registerOTel({ spanProcessors: [processor] })`,
   * to feed Next.js's native spans into Bugsee. Called synchronously during launch.
   */
  onSpanProcessor?: (processor: BugseeSpanProcessor) => void;
  /**
   * Zero-config OTel (N1b-2): when NO OpenTelemetry provider is registered, Bugsee stands up its own
   * (carrying the consume-bridge processor) so Next.js emits + Bugsee consumes its spans with no user
   * OTel setup. First-wins — it never clobbers a pre-existing `@vercel/otel`. Requires the optional peers
   * `@opentelemetry/api` + `@opentelemetry/sdk-trace-base` (skipped if absent). Set `false` to opt out
   * (e.g. you manage OTel yourself). Default `true`. It installs a process-wide provider that consumes every span,
   * so an INVALID value (`'false'`, `0`, `null`, `1`) is treated as OFF and reported through `onError`.
   */
  setupOtelProvider?: boolean;
}

/**
 * The ONE span processor a Next process ever hands to OpenTelemetry. The OTel provider slot is first-wins,
 * so a processor registered at first launch can never be swapped; it therefore delegates to whichever
 * client's processor is CURRENT, and `relaunch()` only swaps the target (R3P-2). Stored on the carrier so
 * a duplicated module instance (HMR, bundler split) shares it.
 */
interface SpanProcessorDelegate {
  processor: BugseeSpanProcessor;
  /** The CURRENT client's processor; `undefined` once that client has stopped (spans are then dropped). */
  target: BugseeSpanProcessor | undefined;
  attached: boolean;
}
const DELEGATE_KEY = Symbol.for('@bugsee/nextjs.spanProcessorDelegate');

function bindSpanProcessor(carrier: object, target: BugseeSpanProcessor): SpanProcessorDelegate {
  const slot = carrier as { [DELEGATE_KEY]?: SpanProcessorDelegate };
  const delegate: SpanProcessorDelegate = slot[DELEGATE_KEY] ?? {
    target,
    attached: false,
    processor: {
      onStart: () => delegate.target?.onStart(),
      onEnd: (span) => delegate.target?.onEnd(span),
      forceFlush: () => delegate.target?.forceFlush() ?? Promise.resolve(),
      shutdown: () => delegate.target?.shutdown() ?? Promise.resolve(),
    },
  };
  slot[DELEGATE_KEY] = delegate;
  delegate.target = target; // the previous processor is unreferenced from here and is collected
  // `client.stop()` calls `shutdown()` on THIS object (the umbrella's wire composes it that way), so a
  // stopped client releases the delegate here (R4H-9): nothing keeps it reachable and late spans are dropped.
  // Only while it is still the current target, so a late teardown of an OLD client cannot unbind its successor.
  const shutdown = target.shutdown.bind(target);
  target.shutdown = () => {
    if (delegate.target === target) delegate.target = undefined;
    return shutdown();
  };
  return delegate;
}
/**
 * Start Bugsee for the Next.js **server** (Node) runtime. Call from `register()` in
 * `instrumentation.ts` under the `NEXT_RUNTIME === 'nodejs'` branch (reached via `await import`) so
 * that no Node-only code is bundled into the edge or client graph. Returns the started client
 * (a per-process singleton — a repeat call under dev HMR returns the existing client).
 */
export function registerServer(appToken: string, options: NextjsServerOptions = {}): Bugsee {
  const { onSpanProcessor, setupOtelProvider, ...launchOptions } = options;
  return launch(appToken, {
    // Default-attach the OTel consume bridge (D4); a caller may still override `otelConsume: false`.
    otelConsume: true,
    ...launchOptions,
    // Own the span-processor seam: surface it (coexistence) AND zero-config self-register a provider when
    // the OTel slot is free (N1b-2). The attach is fire-and-forget + fully defensive (never throws/rejects).
    onOtelSpanProcessor: (current) => {
      // Always the SAME processor (late-bound to the current client): see SpanProcessorDelegate.
      const delegate = bindSpanProcessor(launchOptions.carrier ?? globalThis, current);
      onSpanProcessor?.(delegate.processor);
      // Register with OpenTelemetry once per process: the slot is first-wins and a relaunch only re-targets.
      if (delegate.attached) return;
      delegate.attached = true;
      void attachBugseeOtelProvider(delegate.processor, {
        ...(setupOtelProvider !== undefined ? { setupOtelProvider } : {}),
        ...(launchOptions.onError !== undefined ? { onError: launchOptions.onError } : {}),
      });
    },
  });
}

// API parity with the umbrella entries (review R2D-4): the same VALUE surface, thin re-exports of the same functions.
export {
  addReportAttachment,
  BugseeStatus,
  getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
} from '@bugsee/bugsee/node';

/**
 * Stop the running client and launch again with the same token through `registerServer`, NOT the plain node
 * umbrella launch the `@bugsee/bugsee/node` `relaunch` would run: `registerServer` is what turns `otelConsume`
 * on by default and wires the OpenTelemetry span-processor seam. The OpenTelemetry provider slot is
 * first-wins, so the processor registered at FIRST launch stays registered for the life of the process: it is
 * late-bound, and a relaunch only re-points it at the new client (it is NOT registered again, so
 * `setupOtelProvider` is decided by the first launch). `onSpanProcessor` receives that same stable processor
 * again. Bugsee options return to their defaults (then Next's defaults apply on top) and integration seams are
 * kept; `onSpanProcessor` / `setupOtelProvider` are Next options and are NOT remembered, pass them again if
 * you need them. Rejects when nothing was launched yet.
 */
export const relaunch = (options?: NextjsServerOptions): Promise<Bugsee> =>
  relaunchWith(registerServer, options, options?.carrier);
