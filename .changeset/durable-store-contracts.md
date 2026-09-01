---
'@bugsee/core': minor
'@bugsee/browser-utils': minor
'@bugsee/node-utils': minor
'@bugsee/vercel-edge': minor
'@bugsee/webworker': minor
'@bugsee/cloudflare': minor
'@bugsee/nuxt': minor
'@bugsee/util': patch
---

Durable-storage contracts now report whether a write actually succeeded, and the SDK acts on the answer.

**Breaking, but only if you supply your own store.** `BundleStore.put` and `ReportMarkerStore.put`
return `void | Promise<void>` instead of `void`. TypeScript's return-type-`void` exemption applies only
when the return type is exactly `void`, so an expression-bodied arrow that happens to return something
no longer compiles:

```ts
// before — compiled, because `() => void` accepts any return value
put: (id, bytes) => map.set(id, bytes),

// after — use a block body, or return a promise that settles when the write is durable
put: (id, bytes) => { map.set(id, bytes); },
```

Nothing else changes for a synchronous store: return nothing, throw on failure, as before. A store that
persists asynchronously should now return a promise that REJECTS if the write does not land — the SDK
uses that to decide whether an incident is safe.

**Why.** The durable queue reports `UploadResult.retained` to say "I own delivery of this incident from
here", and the client retires the incident's report marker on the strength of it. That could only ever
observe a failure that threw *synchronously*, and IndexedDB cannot: it accepts the write into a mirror
and persists off the hot path. On the one tier where quota exhaustion is routine, `retained: true` was
therefore unconditional, and markers were retired with nothing durable behind them.

Fixed alongside it:

- IndexedDB writes now resolve on transaction **commit**, not on request success. A transaction can
  report every request successful and still abort at commit, so a bundle could be reported staged and
  then rolled back.
- Node stages bundles **atomically** (temp file, fsync, rename). `writeFileSync` truncates before
  writing, so a crash part-way left a parseable frame header over a truncated body — which recovery
  then uploaded as though it were a valid bundle.
- An incident that neither uploaded nor left any durable trace is now reported through `onError`
  instead of failing silently.
- `flush()` is bounded wherever the SDK awaits it on your behalf (Vercel/Cloudflare edge, Service
  Workers, Nuxt nitro-edge). It previously had no deadline, and a bundle's retry ladder runs ~140s —
  on Cloudflare Durable Objects that was holding your HTTP response open for the duration. Defaults are
  3s when the response is blocked and 15s off the response path, both overridable via `flushTimeoutMs`;
  a non-finite value restores unbounded behaviour. An abandoned flush now reports through `onError`
  rather than dropping the report in silence.
- `withBugseeEvent`'s third argument accepts `{ onError, flushTimeoutMs }` as well as the original bare
  `onError` function.
