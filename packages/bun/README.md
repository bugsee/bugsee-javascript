# @bugsee/bun

Bun platform (tier 2, design §5). Bun runs on a node-compatible API surface, so this package re-exports
the entire `@bugsee/node` composition and overrides only the Bun-specific bits:

- **Runtime identity** — `launch()`/`launchCore()` default the system probe to `bunSystemProbe`, so the
  environment envelope reports `platform.type: 'bun'` and the Bun version (`process.versions.bun`).
- **System metrics** — the shared guarded `perf_hooks` sampler (`createGuardedSystemMetricsSampler`, in
  `@bugsee/node`) that degrades the event-loop metrics to zero rather than crashing on Bun's partial
  `perf_hooks` support.

Both defaults stay overridable. `launch`/`launchCore` shadow the same-named `@bugsee/node` exports.

```ts
import { launch } from '@bugsee/bun';
const bugsee = launch(appToken, { appVersion: '1.0.0' });
```

**Status:** implemented. Built test-first per `docs/implementation-standards.md`.
