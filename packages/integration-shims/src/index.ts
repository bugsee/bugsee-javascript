// @bugsee/integration-shims — no-op stand-ins for DOM-only integrations on DOM-less runtimes
// (design §5, §6 line 372). Some capture integrations exist only with a DOM: viewHierarchyProvider
// (DOM snapshot), breadcrumbsProvider (clicks/keys/history), xhrInterceptor. On Cloudflare / Vercel
// Edge / workers / Node / bun / deno those can't run, so the non-browser platform packages re-export
// these typed no-ops: user code that references e.g. `viewHierarchyProvider` still type-checks, and
// instead of an opaque crash the SDK emits a friendly ONE-TIME debug.warn when the feature is actually
// used. Each shim is a structurally-valid CaptureProvider / Interceptor that does nothing but warn.
//
// Importing/constructing a shim is side-effect-free (keeps `sideEffects: false` honest): the warning
// fires lazily on ACTIVATION (a provider's start, or an interceptor's start / first subscriber), and
// at most once per integration name (Logger.warnOnce). The diagnostic logger and the runtime label
// are injected by the platform that builds the shim — this package is runtime-agnostic.
//
// NOTE: `replay` is intentionally NOT a shim here (design §372). Replay is option-driven, not a
// user-constructed integration; the `replay` option is simply ignored with a warn on non-browser
// runtimes, handled where options are resolved — not via a no-op export.

import {
  type CaptureProvider,
  CaptureProviderBase,
  type Interceptor,
  InterceptorBase,
} from '@bugsee/core';
import type { Logger } from '@bugsee/logger';

/** The minimal diagnostic-logger surface a shim needs (the platform passes its `debug` logger). */
export type ShimLogger = Pick<Logger, 'warnOnce'>;

/** Common options every no-op shim takes. */
export interface NoopShimOptions {
  /** The integration's public name (e.g. 'viewHierarchyProvider'); also the warn-once key. */
  name: string;
  /** Runtime label for the message (e.g. 'cloudflare'). */
  runtime: string;
  /** Diagnostic logger the one-time warning is emitted through. */
  logger: ShimLogger;
}

/** No-op capture-provider options: a {@link NoopShimOptions} plus the optional gating launch option. */
export interface NoopCaptureProviderOptions extends NoopShimOptions {
  /** Launch option that gates this provider, so it only warns when the user enabled the feature. */
  controllingOption?: string;
}

/** Emit the one-time "no-op on <runtime>" warning, keyed by the integration name. */
const warnNoop = ({ name, runtime, logger }: NoopShimOptions): void => {
  logger.warnOnce(`shim:${name}`, `${name} is a no-op on ${runtime}; ignored`);
};

class NoopCaptureProvider extends CaptureProviderBase {
  readonly name: string;
  readonly controllingOption?: string;
  readonly #options: NoopShimOptions;

  constructor(options: NoopCaptureProviderOptions) {
    super();
    this.name = options.name;
    this.#options = options;
    if (options.controllingOption !== undefined) {
      this.controllingOption = options.controllingOption;
    }
  }

  // Warn lazily when the platform actually starts the (gated) provider; capture nothing.
  protected onStart(): void {
    warnNoop(this.#options);
  }
}

class NoopInterceptor extends InterceptorBase<Record<never, never>> {
  readonly name: string;
  readonly #options: NoopShimOptions;

  constructor(options: NoopShimOptions) {
    super();
    this.name = options.name;
    this.#options = options;
  }

  // Activation (explicit start or first subscriber) warns; no global is ever patched.
  protected onActivate(): void {
    warnNoop(this.#options);
  }
}

/** A no-op {@link CaptureProvider} that captures nothing and warns once when started. */
export function createNoopCaptureProvider(options: NoopCaptureProviderOptions): CaptureProvider {
  return new NoopCaptureProvider(options);
}

/** A no-op {@link Interceptor} that patches no global and warns once when activated. */
export function createNoopInterceptor(options: NoopShimOptions): Interceptor {
  return new NoopInterceptor(options);
}

/** No-op stand-in for the browser `viewHierarchyProvider` (DOM snapshot). */
export function createViewHierarchyProviderShim(
  options: Omit<NoopCaptureProviderOptions, 'name'>,
): CaptureProvider {
  return createNoopCaptureProvider({ ...options, name: 'viewHierarchyProvider' });
}

/** No-op stand-in for the browser `breadcrumbsProvider` (clicks/keys/history). */
export function createBreadcrumbsProviderShim(
  options: Omit<NoopCaptureProviderOptions, 'name'>,
): CaptureProvider {
  return createNoopCaptureProvider({ ...options, name: 'breadcrumbsProvider' });
}

/** No-op stand-in for the browser `xhrInterceptor`. */
export function createXhrInterceptorShim(options: Omit<NoopShimOptions, 'name'>): Interceptor {
  return createNoopInterceptor({ ...options, name: 'xhrInterceptor' });
}
