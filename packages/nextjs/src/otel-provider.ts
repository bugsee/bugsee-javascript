// @bugsee/nextjs — zero-config OpenTelemetry provider self-registration (N1b-2).
//
// N1b-1 already exposes the Bugsee SpanProcessor for coexistence (pass it to `@vercel/otel`'s
// `registerOTel({ spanProcessors })`). N1b-2 adds the TRULY zero-config path: when NO OTel provider is
// registered, stand up our own with the Bugsee processor so Next.js emits its built-in spans and we
// consume them — no user OTel setup at all (the D4 differentiator; beats Sentry's manual opt-in).
//
// Competitor-grounded mechanism (design D4.1): the OTel global tracer-provider slot is single-owner /
// FIRST-WINS (`setGlobalTracerProvider` returns `false` if one exists) and `getTracerProvider()` hands
// back a Proxy with no `addSpanProcessor` — so we register ONLY when the slot is free and NEVER clobber a
// pre-existing `@vercel/otel`. Mirrors @vercel/otel's own choice of `BasicTracerProvider`. The OTel SDK is
// an OPTIONAL peer (install-lean, matching @bugsee/opentelemetry) — lazy-imported and skipped if absent.
//
// SERVER-only (node OTel SDK) → reached only from `./server`; never the portable `.` graph.
import type { BugseeSpanProcessor } from 'bugsee/node';

/** The minimal OTel surface we use — resolved from the optional peers by {@link defaultLoad}, or injected. */
export interface OtelTracerModules {
  /** `@opentelemetry/api` `trace.setGlobalTracerProvider` — returns `false` if a provider already exists. */
  setGlobalTracerProvider(provider: unknown): boolean;
  /** Build a concrete provider (`@opentelemetry/sdk-trace-base` `BasicTracerProvider`) with our processors. */
  createProvider(spanProcessors: unknown[]): unknown;
}

/** Outcome of the self-registration (returned for tests / diagnostics). */
export type OtelProviderOutcome =
  | 'registered' // became the global provider → Next emits + Bugsee consumes (zero-config tracing)
  | 'existing-provider' // a provider was already registered (first-wins) → left it untouched
  | 'unavailable' // the optional OTel SDK peers are not installed → skipped
  | 'disabled' // `setupOtelProvider: false`
  | 'error'; // provider construction / registration threw

export interface AttachOtelProviderOptions {
  /** Turn OFF Bugsee's zero-config provider self-registration (e.g. you run your own OTel). Default on. */
  setupOtelProvider?: boolean;
  /** Diagnostic sink for the coexistence notice + any failure. */
  onError?: (error: unknown) => void;
  /** Test/advanced seam: resolve the OTel modules. Default dynamic-imports the optional peers. */
  load?: () => Promise<OtelTracerModules | undefined>;
}

/** Dynamic-import the OPTIONAL OTel peers; returns `undefined` when they are not installed. */
async function defaultLoad(): Promise<OtelTracerModules | undefined> {
  try {
    const [api, sdk] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/sdk-trace-base'),
    ]);
    return {
      setGlobalTracerProvider: (provider) => api.trace.setGlobalTracerProvider(provider as never),
      createProvider: (spanProcessors) =>
        new sdk.BasicTracerProvider({ spanProcessors: spanProcessors as never }),
    };
  } catch {
    /* v8 ignore next -- optional-peer-absent path: unreachable when the OTel peers are installed (as they
       are, as devDeps, in the test env); the 'unavailable' outcome is covered via the injected `load` seam. */
    return undefined; // peers absent → the coexistence path (onSpanProcessor) still stands
  }
}

/**
 * Zero-config self-register an OTel provider carrying `processor`, but ONLY when the global slot is free.
 * Fully defensive — never throws; returns the {@link OtelProviderOutcome}. Fired (fire-and-forget) by
 * `registerServer`; also exported for advanced/manual use.
 */
export async function attachBugseeOtelProvider(
  processor: BugseeSpanProcessor,
  options: AttachOtelProviderOptions = {},
): Promise<OtelProviderOutcome> {
  if (options.setupOtelProvider === false) return 'disabled';

  let mods: OtelTracerModules | undefined;
  try {
    mods = await (options.load ?? defaultLoad)();
  } catch (error) {
    options.onError?.(error);
    return 'unavailable';
  }
  if (mods === undefined) return 'unavailable';

  try {
    const provider = mods.createProvider([processor]);
    if (mods.setGlobalTracerProvider(provider)) return 'registered';
    // First-wins: someone (e.g. @vercel/otel) already owns the slot. Don't clobber — tell the user how to
    // feed Next's spans into Bugsee via their existing provider instead.
    options.onError?.(
      new Error(
        'Bugsee: an OpenTelemetry TracerProvider is already registered — kept it and did not register a ' +
          "second. Add Bugsee's SpanProcessor to your provider (e.g. registerOTel({ spanProcessors: " +
          '[processor] })) — get it via registerServer({ onSpanProcessor }).',
      ),
    );
    return 'existing-provider';
  } catch (error) {
    options.onError?.(error);
    return 'error';
  }
}
