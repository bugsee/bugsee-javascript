# Adversarial review pass 3 — the pass-2 fixes (commit 171d766)

**Reviewed:** `171d766` ("fix: close review pass 2 — bound the eviction set, un-blind the workerd e2e"), the third round of fixes-on-fixes. Read-only; every mutation was verified APPLIED before its result was trusted, and every mutated file was restored from a `cp` backup (`git status --short` empty but for this report).

## Verdict

**No SEV1. One SEV2, two SEV3 — and the SEV2 is the session's signature defect class again: a fix applied to ONE of two computation sites.** The commit's four load-bearing claims (bounded set, un-blinded e2e, working diagnostic, honest README) all verify empirically. But claim #4 in the commit message — *"maxTenantPartitions accepted 0, negatives, NaN, Infinity and fractions … Coerced to a sane integer"* — is an overclaim: the coercion was added only to the **store** (`packages/core/src/partitioned-capture-store.ts:52-53`), while the **per-partition byte budget** in `packages/vercel-edge/src/launch.ts:260-263` still divides by the RAW value. The two sites disagree for every bad input, and the new unit test can never see it because it tests only the store side.

## Did 171d766 fix what it claimed?

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | `evicted` Set bounded at `maxPartitions × 4` | **YES** | Bound `partitioned-capture-store.ts:66` is computed from the *coerced* value, so it is always ≥ 4 (never 0/negative). Behavioral probe on the real store (maxPartitions 2, 100 churned tenants): long-ago tenant `t0` → 0 diagnostics (key dropped, accepted loss), recent `t97` → 1 diagnostic, `t97` cycled back in → live again, 0 diagnostics, `ownerCount()` still 2. `owned ∩ evicted = ∅` invariant holds (`evicted.delete(owner)` at :90 before every `owned.set`), so `evicted.add(lru)` at :98 never re-adds an existing key and FIFO order is honest. A **live-but-idle** tenant is in `owned`, not `evicted` — dropping old evicted keys cannot cost it a diagnostic. Worst case at the default: 32 keys ≈ 3.2 KB — genuinely bounded. Mutation M1 (inner `while` at :99-103 deleted, applied-verified) → `× bounds the evicted-owner set instead of growing it forever` fails. Caveat: for a *user-supplied* large-but-finite value (e.g. `1e9`) the bound is `4e9` keys — but `owned` itself dwarfs it; see SEV2 #1. |
| 2 | `maxPartitions` validated | **HALF** | Store side: verified for `0, -5, NaN, Infinity, 2.7` and mutation-caught (M2: coercion replaced by `const maxPartitions = requested;`, applied-verified → `× coerces an absurd maxPartitions…` fails). Launch side: **NOT fixed** — see SEV2 #1. `1e9` is finite ≥ 1 and passes the store coercion untouched. |
| 3 | Workerd e2e un-blinded | **YES** | Baseline 4/4 green on real workerd. Mutation M3 (owner-scoped drain killed: `client.ts:350-352` → `captureExporter.drain(undefined)`, applied-verified) → exactly the NEW test fails (`× the faulting tenant KEPT its own capture`, 1 failed \| 3 passed) — which simultaneously re-proves pass 2's point that the other three assertions alone are blind to it. Token disjointness holds: `OWN_LOG_C` appears only via `console.log(secret)` (`app/do-tenants-worker.ts:46`); the error string is hard-coded `INCIDENT-IN-C` (:48), so `INCIDENT_C` (test 2) still comes from the report path and `OWN_LOG_C` (test 4) only from captured logs. The assertion targets `b.files['logs.json']` specifically (`durable-object-tenants.e2e.ts:92-96`), so the request-URL's `secret=` query param leaking into `request.json` cannot satisfy it. Test 3 (no `SECRET_A`/`SECRET_B` in any upload) is untouched and unweakened. Restored tree: 4/4 green again. |
| 4 | Reuse diagnostic | **YES, with a latent hazard** | Both directions unit-covered and green (`launch.test.ts:428-442` fires on non-partitioned reuse; :444-453 stays quiet on partitioned reuse — no false positive). Token lookup is name-keyed (`service/src/index.ts:37` `serviceToken = (name) => ({name})`, :227 `Map<string, …>`), so a duplicated-module-copy client resolves correctly. But the call is unguarded — see SEV3 #1. |
| 5 | README trade-off doc | **YES** | `packages/cloudflare/README.md:110-120`; the numbers are real: 10 MB / 9 = 1 165 084 B ≈ 1.16 MB/ring, matching the empirical budget computation. |

## New defects introduced

### SEV2

**1. The `maxTenantPartitions` coercion exists on only ONE of the two sites that consume the value — the budget divisor still uses the raw input, and the two silently disagree.**
- **Where:** `packages/vercel-edge/src/launch.ts:239` (`const maxTenantPartitions = options.maxTenantPartitions ?? DEFAULT…` — raw, uncoerced) feeding **both** `:260-263` (per-partition budget `Math.max(1, Math.floor(maxDataSizeBytes / (maxTenantPartitions + 1)))` — raw) **and** `:265` (`maxPartitions: maxTenantPartitions` — coerced later, independently, at `packages/core/src/partitioned-capture-store.ts:52-53`).
- **Measured on the real modules** (10 MB `maxDataSize`, partitioning on):

  | `maxTenantPartitions` | budget/ring (launch) | rings kept (store) | resulting behavior |
  |---|---|---|---|
  | `0` | **10 485 760 B (FULL)** | 8 (+1 default) | **worst case 90 MB** against the 128 MB isolate — the SEV1 #2 memory blowup resurrected |
  | `NaN` | **NaN** (`Math.max(1, NaN)` = NaN) | 8 (+1) | **byte cap silently DEAD**: `totalBytes > NaN` is always false in `enforceByteCap` (`chunk-capture-store.ts:64`) — empirically 600 KB written, 600 KB retained; only the 60 s window bounds memory |
  | `-5`, `Infinity` | **1 B** | 8 (+1) | every ring evicts every closed part — empirically 20 of 600 entries retained (~ the open 1-second part). Capture silently destroyed |
  | `1e9` | **1 B** | **1e9** (finite ≥ 1 → accepted) | zero-capacity rings AND an effectively unbounded partition map (plus a 4e9-key evicted bound) |
  | `2.7` | 2 833 989 B | 2 (+1) | 8.11 MB total vs the 10 MB intent — mild under-allocation |
- **Why the new tests can't see it:** the 171d766 test (`partitioned-capture-store.test.ts:296-307`) constructs the store directly and asserts only `ownerCount()` — it never goes through `launchEdge`, where the only real user entry point computes the budget. `1e9` is not in its bad-values list either.
- **What "fixed" should mean here:** coerce ONCE in `launchEdge` (or export the store's coercion and reuse it) so the divisor and the bound cannot disagree. As shipped, the commit-message claim "coerced to a sane integer" is true only for the partition COUNT, not the budget.
- (Not SEV1 because every row requires an invalid user-supplied option; but this is precisely the input class the commit claims was neutralized, and the `0` row re-creates the 116 MB-class failure that pass 1 filed as SEV1 #2.)

### SEV3

**1. The reuse diagnostic dereferences the carrier client unguarded — a throwing or non-callable `getService` crashes `launch()` itself.**
- **Where:** `packages/vercel-edge/src/launch.ts:187-191`.
- **Empirical:** with a carrier object whose `getService` throws, `launchEdge('tok', {carrier, partitionCaptureByTenant: true})` **threw** (`Error: container torn down` propagated to the caller); with `getService` present but non-callable, it threw `TypeError: alreadyLaunched.getService?.call is not a function` — the `store?.call(…)` optional chain guards only null/undefined, not non-callability.
- **Reachability:** no current SDK path produces such a client — tokens are name-keyed, every `createClient` registers `captureStore` (`core/src/client.ts:297`, instantiated at launch so `getImmediate` cannot throw later), `getProvider` never throws (auto-creates, `service/src/index.ts:229-236`), and `stop()` removes the client from the carrier (`launch.ts:322`). So this is latent, not live — but it is the ONLY place `launchEdge` calls into an arbitrary carrier-stored object without a guard, in a path that exists precisely because "someone launched differently than expected". A `try/catch` around :187-201 (fall through to the generic warning) costs nothing. The binding rule is "the SDK must never crash the host app"; a diagnostic must never be able to.

**2. Dead guard:** `Math.max(1, maxPartitions)` at `partitioned-capture-store.ts:66` is unreachable armor — the coercion at :52-53 already guarantees `maxPartitions >= 1`. Harmless; remove or fold into the coercion for clarity.

## SEV1

None found.

## Checked and found clean

- **Pass-1 SEV1 #1 (symmetric fail-closed) still holds.** `partitionsFor` (`partitioned-capture-store.ts:127-143`) is untouched by 171d766 except the diagnostic branch, which still returns `[]` for an evicted owner (fail-closed preserved; the `onError` is advisory only). Unscoped → default-partition-only intact; core suite incl. the unscoped-regression test green (713/713). The M3 workerd run doubles as a live re-proof: with scoping killed, C's bundle contained no tenant partition data and A/B secrets still did not leak (test 3 stayed green).
- **Single-tenant behaviour byte-identical.** The diff touches only the coercion (identical output for every valid value), the `evicted` bookkeeping (unreachable when no owner exists — `evicted` only populates via LRU eviction of *owned* partitions), and comments. Full core (713), vercel-edge (73), cloudflare (55) suites green.
- **Both new unit tests are load-bearing**, not theater: each fails against its fix removed (M1, M2 — both mutations grep-verified as applied before the run).
- **The e2e's new test cannot be satisfied from the report path**: it reads `logs.json` members only, and requires the token that exists nowhere else.
- **Set-ordering subtlety**: `evicted.add()` of an already-present key would NOT refresh insertion order, but the `owned ∩ evicted = ∅` invariant makes that case unreachable.
- **Diagnostic false-positive**: none — a partitioned first client exposes `owners` and the check stays quiet (unit-verified, `launch.test.ts:444-453`).
- **Diagnostic-precision loss quantified**: at the default bound (32 tracked keys) a tenant evicted more than 32 evictions ago loses its empty-bundle diagnostic; in the high-churn scenario that motivated the bound this window is short — an accepted, documented trade-off (comment at `partitioned-capture-store.ts:60-64`), not a defect, since the partition data is gone either way and the diagnostic is advisory.
- **Pre-existing, unchanged by 171d766** (noted, not filed): e2e test 2 is titled "produced exactly one incident bundle" but asserts only `uploads.length > 0` (`durable-object-tenants.e2e.ts:77`).

## Method note

Baselines: core `partitioned-capture-store.test.ts` 19/19, vercel-edge `launch.test.ts` 22/22, workerd e2e 4/4 — all green before mutating. Mutations M1/M2/M3 each grep-verified as applied before their run; each was caught by exactly the test the commit added for it. All files restored from `cp` backups; final `git status --short` empty (this report is the only new file). Divisor/budget table produced by executing the real `createPartitionedCaptureStore` / `createMemoryCaptureStore` / `launchEdge` modules, not by inspection.
