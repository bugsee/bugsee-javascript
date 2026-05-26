// @bugsee/integration-shims — no-op stand-ins for DOM-less runtimes (design §5, §6 line 372).
//
// Deferred to the core tier: its typed no-op exports (viewHierarchyProvider/xhrInterceptor/…) must
// implement @bugsee/core's Interceptor/CaptureProvider/Client contracts (tier 1, §5/§16.2), and a
// tier-0 package cannot depend on tier 1. The only runtime-agnostic primitive needed (warn-once)
// already lives in @bugsee/logger. Implemented once @bugsee/core defines those contracts; until
// then this is an empty module with no runtime side effects (§5.1). See README.md.
export {};
