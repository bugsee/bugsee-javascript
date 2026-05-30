# @bugsee/integration-shims

No-op stand-ins for DOM-only integrations on DOM-less runtimes (design §5, §6 line 372).

**Status:** implemented (slice #13).

Some capture integrations exist only with a DOM — `viewHierarchyProvider` (DOM
snapshot), `breadcrumbsProvider` (clicks/keys/history), `xhrInterceptor`. On
Cloudflare / Vercel Edge / workers / Node / bun / deno they can't run. This
package exports *typed* no-op versions that the non-browser platform packages
re-export, so user code referencing them still type-checks and — instead of an
opaque crash — emits a friendly one-time
`debug.warn("viewHierarchyProvider is a no-op on cloudflare; ignored")` when the
feature is actually used.

## API

- `createNoopCaptureProvider({ name, runtime, logger, controllingOption? })` —
  a structurally-valid `CaptureProvider` that captures nothing and warns once
  (via `logger.warnOnce`, keyed by `name`) when **started**.
- `createNoopInterceptor({ name, runtime, logger })` — a valid `Interceptor`
  that patches no global and warns once when **activated** (explicit `start()`
  or first subscriber).
- Named convenience shims fixing the integration name:
  `createViewHierarchyProviderShim`, `createBreadcrumbsProviderShim` (providers),
  `createXhrInterceptorShim` (interceptor).

The diagnostic `logger` (`Pick<Logger, 'warnOnce'>`) and the `runtime` label are
**injected by the platform** that builds the shim, so this package stays
runtime-agnostic. Constructing a shim is side-effect-free (no import-time work);
the warning fires lazily on activation, at most once per integration per process.

## Not a shim: `replay`

Per design §372, **replay is intentionally excluded** here. Replay is
option-driven, not a user-constructed integration — the `replay` option is simply
ignored with a warn on non-browser runtimes, handled where options are resolved,
not via a no-op export.

Implementation follows `docs/implementation-standards.md`.
