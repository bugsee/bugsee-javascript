// @bugsee/nextjs — zero-config OpenTelemetry provider self-registration (N1b-2).
//
// N1b-1 already exposes the Bugsee SpanProcessor for coexistence (pass it to `@vercel/otel`'s
// `registerOTel({ spanProcessors })`). N1b-2 adds the TRULY zero-config path: when NO OTel provider is
// registered, stand up our own with the Bugsee processor so Next.js emits its built-in spans and we
// consume them — no user OTel setup at all (the differentiator; beats Sentry's manual opt-in).
//
// Competitor-grounded mechanism: the OTel global tracer-provider slot is single-owner /
// FIRST-WINS (`setGlobalTracerProvider` returns `false` if one exists) and `getTracerProvider()` hands
// back a Proxy with no `addSpanProcessor` — so we register ONLY when the slot is free and NEVER clobber a
// pre-existing `@vercel/otel`. Mirrors @vercel/otel's own choice of `BasicTracerProvider` (`TracerProvider` on
// OTel JS 3, which removed sdk-trace-base). The OTel SDK is
// an OPTIONAL peer (install-lean, matching @bugsee/opentelemetry) — lazy-imported and skipped if absent.
//
// SERVER-only (node OTel SDK) → reached only from `./server`; never the portable `.` graph.
import type { BugseeSpanProcessor } from '@bugsee/bugsee/node';
import { describeValue, reportGuarded, resolveFailClosedBoolean } from '@bugsee/core';

/** The minimal OTel surface we use — resolved from the optional peers by {@link defaultLoad}, or injected. */
export interface OtelTracerModules {
  /** `@opentelemetry/api` `trace.setGlobalTracerProvider` — returns `false` if a provider already exists. */
  setGlobalTracerProvider(provider: unknown): boolean;
  /** Build a concrete provider (`sdk-trace-base`'s `BasicTracerProvider` on OTel 1.x/2.x, `sdk-trace`'s `TracerProvider` on 3.x) with our processors. */
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
  /** Turn OFF Bugsee's zero-config provider self-registration (e.g. you run your own OTel). Default on; an INVALID value (not a boolean) is OFF and reported. */
  setupOtelProvider?: boolean;
  /** Diagnostic sink for the coexistence notice + any failure. */
  onError?: (error: unknown) => void;
  /** Test/advanced seam: resolve the OTel modules. Default dynamic-imports the optional peers. */
  load?: () => Promise<OtelTracerModules | undefined>;
}

/** A provider class: `BasicTracerProvider` (sdk-trace-base 1.x/2.x) or `TracerProvider` (sdk-trace 3.x). */
type ProviderCtor = new (options: { spanProcessors: unknown[] }) => unknown;

/** The module loaders {@link loadOtelModules} uses — injectable so every install shape is testable. */
export interface OtelImporters {
  api(): Promise<{ trace: { setGlobalTracerProvider(provider: never): boolean } }>;
  /** OTel JS 1.x/2.x. */
  sdkTraceBase(): Promise<{ BasicTracerProvider?: ProviderCtor }>;
  /** OTel JS 3.x (which removed `sdk-trace-base` and renamed `BasicTracerProvider` to `TracerProvider`). */
  sdkTrace(): Promise<{ TracerProvider?: ProviderCtor }>;
}

/**
 * Resolve the OTel modules from whichever optional SDK package is installed: `sdk-trace-base` first (OTel
 * 1.x/2.x, unchanged behaviour), then `sdk-trace` (OTel 3.x). `undefined` when `@opentelemetry/api` or every
 * SDK package is absent.
 */
export async function loadOtelModules(
  imports: OtelImporters,
): Promise<OtelTracerModules | undefined> {
  try {
    const api = await imports.api();
    let Provider: ProviderCtor | undefined;
    try {
      Provider = (await imports.sdkTraceBase()).BasicTracerProvider;
    } catch {
      // not installed (OTel 3 removed it) — try its replacement
    }
    if (Provider === undefined) {
      try {
        Provider = (await imports.sdkTrace()).TracerProvider;
      } catch {
        // not installed either
      }
    }
    if (Provider === undefined) return undefined;
    const ProviderClass = Provider;
    return {
      setGlobalTracerProvider: (provider) => api.trace.setGlobalTracerProvider(provider as never),
      createProvider: (spanProcessors) => new ProviderClass({ spanProcessors }),
    };
  } catch {
    return undefined; // peers absent → the coexistence path (onSpanProcessor) still stands
  }
}

/** Dynamic-import the OPTIONAL OTel peers; returns `undefined` when they are not installed. */
function defaultLoad(): Promise<OtelTracerModules | undefined> {
  return loadOtelModules({
    api: () => import('@opentelemetry/api'),
    sdkTraceBase: () => import('@opentelemetry/sdk-trace-base') as never,
    sdkTrace: () => import('@opentelemetry/sdk-trace') as never,
  });
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
  // Zero-config OTel installs a process-wide provider that consumes every span, so only boolean `true` (or absent)
  // sets it up: `'false'`, `0`, `null`, `1` are OFF and reported, never read as "on".
  if (!resolveFailClosedBoolean(options.setupOtelProvider, true)) {
    if (options.setupOtelProvider !== false) {
      reportGuarded(
        options.onError,
        new Error(
          `Bugsee: setupOtelProvider must be a boolean (got ${describeValue(options.setupOtelProvider)}); the zero-config OpenTelemetry provider stays OFF`,
        ),
      );
    }
    return 'disabled';
  }

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
