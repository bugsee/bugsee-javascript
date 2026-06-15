# @bugsee/deno

Deno platform (tier 2, design §5). Deno 2 runs on a node-compatible API surface, so this package re-exports
the entire `@bugsee/node` composition and overrides only the Deno-specific bits:

- **Runtime identity** — `launch()`/`launchCore()` default the system probe to `denoSystemProbe`, so the
  environment envelope reports `platform.type: 'deno'` and the Deno version (`Deno.version.deno`).
- **System metrics** — the shared guarded `perf_hooks` sampler (`createGuardedSystemMetricsSampler`, in
  `@bugsee/node`) that degrades the event-loop metrics to zero rather than crashing on Deno's partial
  `perf_hooks` support.

Everything else — transport, fs storage, `node:http` capture, crash detection, durable queue + capture
recovery, CPU profiling, ANR/hang detection — is inherited from `@bugsee/node` and capability-guarded, so a
diagnostic that touches a partially-supported Deno API self-disables rather than breaking. Both defaults stay
overridable. `launch`/`launchCore` shadow the same-named `@bugsee/node` exports.

```ts
import { launch } from '@bugsee/deno';
const bugsee = launch(appToken, { appVersion: '1.0.0' });
```

**Deno permissions.** The SDK uses Deno's `node:` compatibility, which is subject to Deno's permission
model: report upload needs `--allow-net`, file-backed capture/recovery (`dataDir`) needs
`--allow-read`/`--allow-write`, and the ANR watchdog spawns a worker. The ANR watchdog and CPU profiler are
capability-guarded (they degrade to a no-op if their API is unavailable); under denied network/fs
permissions the corresponding paths surface errors via the `onError` sink rather than the bundle.

**Status:** implemented. Built test-first per `docs/implementation-standards.md`.
