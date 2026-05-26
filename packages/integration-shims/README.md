# @bugsee/integration-shims

No-op stand-ins for DOM-less runtimes (design §5, §6 line 372).

**Status:** deferred to the core tier (intentional stub).

Its job is to export *typed* no-op versions of user-referenced integrations
(`viewHierarchyProvider`, `xhrInterceptor`, etc.) that non-browser platform
packages re-export, so code referencing them on e.g. Cloudflare still
type-checks and emits a friendly one-time `debug.warn("… is a no-op on <rt>;
ignored")` instead of crashing.

Those no-op exports must structurally implement `Interceptor` / `CaptureProvider`
(and reference `Client`), which the design assigns to **tier-1 `@bugsee/core`**
(§5 layout, §16.2). A tier-0 package cannot depend on tier-1 without inverting
the dependency DAG, and the one runtime-agnostic primitive these shims need —
warn-once — already lives in `@bugsee/logger` (`warnOnce`). There is therefore
no honest tier-0 surface to build here ahead of `@bugsee/core`; defining those
contracts now would pre-empt core and risk divergence.

This package is implemented once `@bugsee/core` defines the provider/interceptor
contracts. Until then it is an empty module (no runtime side effects, per §5.1).

Implementation follows `docs/implementation-standards.md`.
