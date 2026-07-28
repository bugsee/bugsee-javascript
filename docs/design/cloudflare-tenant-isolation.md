# Durable Object tenant isolation — design (Wave 0.1)

**Status:** **BUILT + verified on real workerd** (S0–S5 complete, 2026-07-28). Fixes `docs/review/cloudflare.md` **SEV1 #2** — the most severe finding in
the 53-package review. Depends on Wave 0.1a (`0391acc`), which made a working `AsyncLocalStorage`
supplyable on Cloudflare.

---

## 1. The problem

Durable Objects are Cloudflare's canonical **per-user / per-room / per-tenant** primitive; "one DO per
customer" is the archetypal usage. Multiple DO instances with different IDs are hosted **in the same JS
isolate**, and today they share one Bugsee client, one set of global interceptors, and **one in-memory
capture ring**. An incident in one DO uploads a bundle containing every other DO's captured data.

This was proven, not inferred — real `workerd`, three DOs via `idFromName`, all in isolate `5dylil`; A and
B each logged a secret and returned cleanly, C threw. The real signed-PUT bundle was unzipped:

```
upload#0  contains SECRET-OF-A: YES | SECRET-OF-B: YES | SECRET-OF-C: YES
```

Tenant C's incident bundle carried A's and B's secrets off the customer's infrastructure.

**Root cause:** `createLazyLauncher` (`launch-config.ts:32-41`) caches one client in a closure that lives
for the isolate; `instrument-durable-object.ts:39` evaluates one launcher at module scope.

---

## 2. Verified constraints

Established by reading the code, not assumed. These rule out most of the obvious fixes.

| # | Constraint | Evidence |
|---|---|---|
| **C1** | **One client per isolate is enforced.** `launchEdge` returns the already-launched client and reports an error on a repeat call. | `vercel-edge/src/launch.ts:151-159` |
| **C2** | **Interceptors are isolate-global and deduped by name** on the carrier, independent of client count. | `core/src/carrier.ts:71-83` |
| **C3** | **`StoredEntry` has no owner field.** `context_id` is stamped *inside* `entry.data` and then serialized; the store only sees `{type, timestamp, serialized}`. The `timestamp` comment states the precedent explicitly: kept out-of-band "so ordering/time-bounds need no deserialize". | `core/src/contracts.ts:81-88`, `core/src/capture-aggregator.ts:37-56` |
| **C4** | **Context is per-invocation**, minted in `runInEdgeContext`, and only propagates across `await` when a real ALS is supplied (Wave 0.1a). | `vercel-edge/src/edge-context.ts:44-58` |
| **C5** | **DO identity is available at construction** — `DurableObjectState.id`, constructor arg 0. | `instrument-class.ts:81` |

---

## 3. Options considered

### A. One client per DO instance — **rejected, architecturally impossible**

Blocked by **C1**: the carrier returns the existing client. Even if that were relaxed, **C2** means the
console/fetch interceptors are shared regardless, so N clients would either double-capture (N patches over
the same globals) or all feed whichever store the single interceptor was bound to. Per-client isolation
cannot work while interceptors are isolate-global.

### B. Filter at bundle time by `context_id` — **rejected, wrong cost and wrong granularity**

Blocked by **C3**: `context_id` lives inside the serialized blob, so filtering would deserialize **every
entry in the ring** on every incident — on the hot path of an already-degraded runtime, and against an
explicit design decision that reads must not deserialize. It is also per-*invocation*, not per-*tenant*, and
it leaves unattributed entries with no defined home.

### C. Partition the capture store by owner, routed at `add()` — **recommended**

The store becomes a map of rings keyed by an **owner key**, resolved synchronously at `add()` from the
active context. An incident drains **only the faulting owner's** partition.

- No deserialization (**C3** respected): the owner is known at write time, out-of-band, like `timestamp`.
- Fixes a **second, unreported defect**: today one noisy tenant's traffic evicts another's data from the
  shared ring. Per-partition rings make eviction fair.
- Degrades to exactly today's behaviour when no owner is ever set — so the single-tenant `fetch` path, the
  Vercel Edge path, and every non-DO consumer are **unchanged**.

### D. Per-invocation capture only (no rolling window inside DOs) — **fallback**

Strictly safe and much simpler: an incident bundle carries only the faulting invocation's capture. But it
discards the rolling-window fidelity that is a core SDK value proposition, and it still needs the same
write-time routing to implement. C subsumes it.

### E. Refuse to run more than one DO per isolate — **not viable.** Placement is Cloudflare's, not ours.

---

## 4. Recommended design (Option C)

### 4.1 Owner key

The owner is the **tenant boundary**, not the invocation: for a DO, `ctx.id.toString()` (**C5**), captured
in the instrumented constructor and carried on the `RequestContext` opened for every method call on that
instance. `contextId` stays per-invocation and unchanged.

### 4.2 Write path

`StoredEntry` gains an optional out-of-band `owner?: string` — mirroring `timestamp`'s rationale. The
aggregator, which already resolves the context to stamp `context_id`, also reads the owner and passes it to
`store.add()`. No new context lookups, no new hot-path cost.

### 4.3 Read path

`snapshot()` gains an optional owner filter. The bundle assembler passes the faulting report's owner. With
no owner (single-tenant), behaviour is byte-identical to today.

### 4.4 Unattributed entries — **fail closed**

Entries captured with no active context (module scope, the DO constructor, background timers) have no
owner. Policy: **an unattributed entry is included only when the isolate has never seen an owner.** Once
any owner exists — i.e. the isolate is known to be multi-tenant — unattributed entries are excluded from
every bundle.

This deliberately loses some genuinely-relevant capture in exchange for never leaking across tenants. The
alternative (include everywhere) *is* the current bug.

### 4.5 Memory

N partitions must not multiply the byte cap. Proposal: keep **one global cap**, evict from the largest
partition first so a noisy tenant cannot starve a quiet one. Partitions are reclaimed **LRU** — a DO
evicted by Cloudflare must not leak its ring for the isolate's lifetime.

---

## 5. Slices

| Slice | Work | Package |
|---|---|---|
| **S1** | `StoredEntry.owner` + aggregator passes it; `CaptureStore.add` accepts it | `core` |
| **S2** | Partitioned memory capture store: per-owner rings, global cap, largest-first eviction, LRU reclaim | `core` (used by edge) |
| **S3** | `snapshot({ owner })` + bundle assembler passes the faulting owner; fail-closed unattributed policy | `core` |
| **S4** | DO instrumentation sets the owner from `ctx.id` onto the per-invocation context | `cloudflare` |
| **S5** | **Real-workerd e2e reproducing the leak first**, then proving it fixed: three DOs, secrets in A and B, incident in C, assert C's bundle contains neither | `instrumentation-tests` |

**S5 is written first.** The review's own reproduction is the acceptance test, and per the plan's Wave 3b
the harness had no workerd coverage at all — this adds the first.

---

## 6. Open questions

1. **Is per-tenant the right boundary, or per-invocation?** C uses the DO id, so an incident carries that
   tenant's rolling window. D (per-invocation) is stricter and simpler. Per-tenant matches the SDK's
   rolling-window value; per-invocation is safer if DO ids ever prove non-unique across isolates.
2. **Does `owner` belong in `core`, or should partitioning live entirely in the edge tier?** Core is the
   right home if Electron renderers or Web Workers ever need the same isolation; edge-only is a smaller
   blast radius. I lean core for `StoredEntry.owner` (a two-line contract change) with the partitioned
   store in the edge tier.
3. **Should the fail-closed policy be configurable?** A single-tenant DO deployment might legitimately want
   unattributed entries. Default closed; option to open.
4. ~~**Wave 0.1a default.**~~ **RESOLVED (2026-07-28): make it seamless — the user writes no code.** See §7.

Questions 1–3 can be settled during implementation.

---

## 7. Resolved: automatic AsyncLocalStorage on Cloudflare (decision, 2026-07-28)

**Decision:** `@bugsee/cloudflare` acquires `AsyncLocalStorage` itself and wires it into the context store.
The user writes **no SDK code** for it — `launch(token)` is enough. Wave 0.1a's `asyncLocalStorage` option
stays as an explicit override (tests, exotic runtimes), but nobody needs it on the happy path.

**Mechanism:** a static `import { AsyncLocalStorage } from 'node:async_hooks'` in the Cloudflare package,
which makes **`nodejs_compat` a required compatibility flag** for `@bugsee/cloudflare`.

**Precedent — this is the industry norm, not a novel demand.** `@sentry/cloudflare` does exactly this:

```ts
// sentry-javascript/packages/cloudflare/src/async.ts:2-3
// Note: Because we are using node:async_hooks, we need to set `node_compat` in the wrangler.toml
import { AsyncLocalStorage } from 'node:async_hooks';
```

There is no flagless route: the review's workerd matrix confirms `globalThis.AsyncLocalStorage` is absent
under every flag, and ALS is reachable *only* through `node:async_hooks`. So per-request context on
Cloudflare requires the flag no matter who implements it. The only real choice is **how the requirement
surfaces**.

**The tradeoff, stated plainly.** A static import means a project without `nodejs_compat` fails at **build**
with a resolver error, instead of building fine and silently degrading. That is a breaking change for any
existing flagless deployment — but such a deployment gets **no working context isolation today anyway**, so
nothing functional is lost; what changes is that the problem becomes visible instead of silent. Given the
package is pre-1.0 and today's behaviour is "silently broken while the README claims otherwise", a loud
build error is the better failure mode.

**Why not the `/node-als` subpath** (the option this question originally proposed): it is not seamless. The
user must know to import a different entry point — precisely the friction this decision rejects. It is
retained only as a possible escape hatch (§7.1) if a flagless consumer ever turns up.

### 7.1 Escape hatch (only if needed)

If a real consumer cannot enable `nodejs_compat`, add a `@bugsee/cloudflare/no-node-compat` entry that omits
the import and degrades to the single-slot store with the corrected warning. Do **not** build this
speculatively — ship the seamless path first and add it on demand.

### 7.2 Slice impact

Adds **S0**, before S1:

| Slice | Work | Package |
|---|---|---|
| **S0** | Static-import `AsyncLocalStorage`, wire it into `launchEdge` by default; `nodejs_compat` documented as required; README + warning updated again to say "required" rather than "pass it yourself"; verify a real `wrangler`/`workerd` build both with and without the flag | `cloudflare` |

S0 makes S1–S5 meaningful: without it, `owner` is never populated and the tenant fix is inert.

---

## 8. Outcome (2026-07-28)

All slices landed, plus one the design did not anticipate.

| Slice | Commit | Note |
|---|---|---|
| S0 automatic AsyncLocalStorage | `cf9533e` | `nodejs_compat` now required; zero user code |
| S1 `StoredEntry.owner` | `ac998b2` | out-of-band, never on the wire |
| S2 partitioned store | `76fc4e0` | also fixes noisy-tenant eviction |
| S3 owner-scoped drain | `70d45c9` | |
| **S4.5 wire the store in** | `a63eb6c` | **not in the original plan — see below** |
| S4 DO stamps its id | `3be6fce` | |
| S5 real-workerd e2e | this | miniflare + three co-located DOs |

**S4.5 is the lesson.** S1–S4 all landed green, each with its own mutation loop, and the fix was still
**inert**: nothing selected the partitioned store, so `launchEdge` kept using the plain memory one. 832
passing tests and full per-slice mutation coverage did not notice, because every slice verified its own unit
and nothing verified that the units were connected. It was caught by checking the wiring by hand before
writing S5 — exactly the "components verified in isolation, integration unverified" gap the original review
kept finding, reproduced while fixing it.

**S5 is what makes that impossible to repeat.** `test/durable-object-tenants.e2e.ts` boots the real SDK,
bundled as wrangler would, inside real `workerd` via miniflare, with three Durable Objects for three tenants
co-located in one isolate. It asserts:

1. the three tenants really did share one isolate (otherwise a green result would be vacuous);
2. exactly one incident bundle, from the tenant that faulted;
3. that bundle carries **neither** other tenant's secret.

**Verified to have teeth, not merely green:** with `partitionCaptureByTenant` reverted to `false`, assertion
3 fails with tenant C's real bundle containing `SECRET-OF-TENANT-A` and `SECRET-OF-TENANT-B` — the review's
finding, reproduced end to end. It passes only because the fix is present and wired.

This is the repo's first real-`workerd` coverage. `@edge-runtime/vm` cannot substitute: it has no Durable
Object placement, so co-located tenants are not representable there.

### Still open

- §6 Q3 (configurable fail-closed policy) — left at the safe default; no consumer has asked.
- The LRU partition bound (default 8) is untested against a workload with many short-lived DOs.
