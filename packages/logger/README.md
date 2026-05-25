# @bugsee/logger

The SDK's internal diagnostic logger — the `debug.*` channel used across the SDK, gated by `__BUGSEE_DEBUG__`. Distinct from the captured-log pipeline (these are SDK self-diagnostics, not user log entries).

`createLogger(initialLevel = 'error')` returns a `Logger` with levels `silent < error < warn < info < debug`:

- `setLevel` / `getLevel`
- `addHandler(handler)` → returns an unsubscribe function
- level-gated `error` / `warn` / `info` / `debug`
- `warnOnce(key, ...)` for one-time diagnostics (consumes the key only on actual delivery)

A throwing handler can't break delivery or starve other sinks; args are frozen and the handler set is snapshotted per emit. Standalone, zero-dependency. Tier 0 (design §5).
