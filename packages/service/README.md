# @bugsee/service

Per-Client service registry (design §4.4 / §7.4) — the Firebase `@firebase/component` pattern, renamed (Component → Service) and reduced to single-instance.

- `defineService(name, factory, mode?)` — `mode` is `LAZY` (default; instantiated on first access) or `EXPLICIT` (instantiated only via `initialize(options)`).
- `createServiceContainer()` → `addService(service)` / `getProvider<T>(name)`.
- `Provider`: `get()` (async; resolves on late registration / explicit init, rejects on `clearInstance`), `getImmediate()` (sync; throws or `{ optional: true }` → null), `initialize(options)`, `clearInstance()` (drops the instance, rejects a pending `get()`), `onInit(cb)` (immediate if already created), `isServiceSet`/`isInitialized`.

Generic and untyped — the `NameServiceMapping`-typed facade is layered on by `@bugsee/core`. Factory failures are cached; self-referential factories are detected as circular dependencies. Tier 0; depends only on `@bugsee/util` (`createDeferred`).
