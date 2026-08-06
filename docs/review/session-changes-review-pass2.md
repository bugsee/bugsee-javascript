# Adversarial review pass 2 — the fixes (commit c941dbf)

**Reviewed:** 2026-07-28 · **Scope:** git d743d6e..c941dbf
**Verdict:** All nine pass-1 findings are genuinely closed — every one re-verified independently, most under mutation, and the headline fix (SEV1 #1) re-proven on real workerd in pass 1's own scenario shape, in both directions (fixed code keeps tenant secrets out of an owner-less incident bundle; reverting only that branch makes both secrets reappear in `logs.json`). Every new test added by the commit is load-bearing: all five targeted mutations were caught once actually applied (the first mutation round produced five FALSE survivors from a broken mutator — the exact trap this pass was warned about). The commit is safe to ship with eyes open on three things it introduces: a real, quantified unbounded-memory leak in the `evicted` set (~101 B of heap per churned tenant, forever — the same defect class SEV1 #2 was about, SEV2), an acceptance-e2e blind spot (the committed workerd suite passes 3/3 with the owner-scoped drain killed and the bundle stripped of all capture, SEV2 — unit tier does catch it), and a measured capture-fidelity cut that applies to **every** Cloudflare Worker, not just DO tenants (default ring 1.11 MB instead of 10 MB; a chatty 180 KB/s tenant now keeps ~5 s of history vs ~55 s pre-fix; typical log-rate tenants are unaffected, SEV3). Nothing found here leaks across tenants, crashes, or invalidates the fixes themselves.

Empirical basis: root unit suite 331 files / 3819 tests green; `tsc --noEmit` clean on core, vercel-edge, instrumentation-tests; DO e2e green on real workerd; 8 targeted mutations run with applied-mutation confirmation; capacity/heap numbers measured against the REAL `createMemoryCaptureStore` / `createPartitionedCaptureStore`; tree restored (`git status --short` empty but for this report).

## Did pass 1's findings actually get fixed?

| # | Finding | Fixed? | Evidence |
|---|---------|--------|----------|
| SEV1 1 | unscoped drain leaks every tenant partition | **YES** | `partitioned-capture-store.ts:108-111` (unscoped → default only). Mutation `partitionsFor(undefined)→allPartitions()` fails the new core regression test (`× an UNSCOPED snapshot sees no tenant data at all`). Re-ran pass 1's scenario on real workerd via a temp `/__frontfault` route: fixed code → owner-less incident bundle carries only `FRONT-LOG-MARK`, no `PROBE-SECRET-A/B`; same probe under the revert → `logs.json` contains BOTH secrets. Both directions proven. |
| SEV1 2 | 9 × maxDataSize ≈ 116 MB heap vs 128 MB isolate | **YES** | `launch.ts:238-241`: per-partition cap `max(1, floor(maxDataSize/(maxTenantPartitions+1)))`; divisor matches the store bound + default (verified: `maxPartitions: maxTenantPartitions` at `:243`, store retains N owned + 1 default). Measured total: 9 × 1,165,084 B ≈ 10.0 MB ≤ maxDataSize. Mutation (divide by 1) fails the new launch test. Cost quantified below (new-defect N2). |
| SEV1 3 | S5 co-location guard vacuous | **YES** | Replaced with the `/__owners` probe (3 distinct 64-hex DO ids from the ONE per-isolate client — genuinely isolate-scoped: the client is a per-`globalThis` carrier singleton, `owners()` is read-only, the probe request itself writes nothing owned). Mutation: dropping the A+B dispatches now FAILS the guard (`owners.length 1 ≠ 3`) — the old proxy stayed green under exactly this mutation. No spurious-pass path found (a split placement would yield <3 and fail). |
| SEV2 4 | assertion library's tests run in NO CI job | **YES** | `vitest.unit.config.ts` (globs `test/**/*.test.ts`) + `package.json` `test:unit` + `turbo.json` task + `.github/workflows/ci.yml:59-60` **in the `check` job**. `turbo run test:unit` runs 26 tests (verified live). Induced failure: reverting the apptoken-provenance change makes `turbo run test:unit --filter=@bugsee/instrumentation-tests` exit 1 with `test/bundle.test.ts (26 tests | 1 failed)` — the CI step would fail the build. |
| SEV2 5 | LRU-evicted tenant → silently empty bundle | **YES** (with a new cost) | `partitioned-capture-store.ts:50-52` (evicted keys retained), `:112-121` (onError at snapshot naming the tenant + remedy). Mutation (drop `evicted.add(lru)`) fails the new test. The retention set is unbounded — see N1. Message nit: it says "Raise `maxPartitions`" but the user-facing edge option is `maxTenantPartitions`. |
| SEV2 6 | explicit `captureStore` / `launchEdge` silently disables isolation | **PARTIAL** | The `captureStore` shape is fixed: `launch.ts:220-228` onErrors naming the consequence; mutation (skip the check) fails the new test. The finding's OTHER shape — `launchEdge(token)` called directly (re-exported by `@bugsee/cloudflare`), then the DO lazy launcher reusing the non-partitioned carrier client (`launch-config.ts:35-40`) — got NO new diagnostic: only the pre-existing generic "`launch() called more than once`" (`launch.ts:178`), which does not name the isolation loss, and nothing checks the reused client's store kind. See SEV3 #3 below. |
| SEV3 7 | `expect(provider ?? injected)` cannot fail | **YES** | Removed (`launch.test.ts` diff, both lines); the surrounding real assertions retained. |
| SEV3 8 | `apptoken` exemption keyed on name | **YES** | `bundle.ts:155-157`: exemption now `name === 'apptoken' && !declared.has(name)` (provenance). Negative test added; mutation back to name-keyed fails it via the CI step. Verified on a REAL workerd bundle: manifest declares only `[logs.json,crash.json]`, `apptoken` is an undeclared root entry holding the token, and `assertNoSecrets(bundle, ['e2e-do-token'])` passes. `assertBundleIntegrity`'s `STRUCTURAL_FILES` still keys on the name (`bundle.ts:42`, `:111`) but is semantically equivalent there: a *declared* `apptoken` already satisfies the declared-check, an *undeclared* one is the structural file by definition — no reachable behavioral difference. |
| SEV3 9 | fixture comment claimed a disabled tick | **YES** | `do-tenants-worker.ts:58-60` now states the tick runs; accurate — the config sets only `captureNetwork: false`. |

## SEV1

None.

## SEV2

### 1. The `evicted` Set grows without bound — one 64-hex string per churned tenant, forever
- **Where:** `packages/core/src/partitioned-capture-store.ts:52` (declaration), `:84` (`evicted.add(lru)`), `:76` (only pruning path: the owner returns)
- **What:** Every distinct owner that passes through the LRU bound leaves a permanent 64-char key in `evicted`. Nothing else prunes it: not `clear()` (`:161-165` clears partition contents only), not time, not a size cap. On an isolate churning through short-lived Durable Objects (per-user / per-session DO ids — the archetypal pattern), this is a monotone leak for the isolate's lifetime.
- **Why it matters:** Measured against real V8: **~101 B heap per owner** (1M owners → 96.3 MB heap, `Set` of `randomBytes(32).toString('hex')`, `--expose-gc`). That is ~10 MB at 100k churned tenants, ~50 MB at 500k, against the same 128 MB isolate ceiling SEV1 #2 was filed over. Slow, but it is the exact defect class the fix was written to remove, reintroduced by the fix. A cap (bounded set / LRU of evicted keys) is a one-line repair and loses only diagnostic precision.
- **Evidence:** code path above; heap measurement reproduced in this pass (see verdict paragraph).

### 2. The acceptance e2e passes with the owner-scoped drain killed and the bundle stripped of ALL capture
- **Where:** `packages/instrumentation-tests/test/durable-object-tenants.e2e.ts:45` (tenant C's logged secret IS the incident string `INCIDENT-IN-C`), `:70-79` (test 2 accepts the marker from ANY file — the report envelope alone satisfies it)
- **What:** Mutation `partitionsFor(owner) → []` (every tenant snapshot empty): the committed suite still passes 3/3 on real workerd, while the incident bundle contains **no `logs.json` at all** (verified by unzipping the mutated run's upload: `request.json`, `manifest.json`, `apptoken`, `crash.json` only). Test 1 passes (owner *stamping* still works), test 2 passes off the error text in `request.json`/`crash.json`, test 3 passes trivially. So the only real-workerd tier cannot see "the faulting tenant kept its own capture" — the exact blindness ("trading a leak for data loss") this pass was told to hunt.
- **Why SEV2 not SEV1:** the same mutation fails 3 core unit tests, so the defect class is covered — the blind spot is only to workerd-specific integration failures (e.g. report-time ALS context loss on workerd would keep `owners()` = 3 while draining empty, and would ship green). And the suite's headline claims (no cross-tenant leak; real co-location) ARE genuinely proven.
- **Repair sketch:** give C a secret distinct from its error string and assert `logs.json` contains it (this pass's probe did exactly that and the fixed code passes it: `FILE logs.json … marks=[C-OWN-LOG-SECRET]`).

## SEV3

### 3. The `launchEdge`-direct shape of pass-1 SEV2 #6 remains undiagnosed
- **Where:** `packages/cloudflare/src/index.ts` (re-exports `launchEdge`), `packages/vercel-edge/src/launch.ts:174-182` (carrier-reuse path, generic message), `packages/cloudflare/src/launch-config.ts:35-40` (DO launcher reuses whatever client the carrier holds)
- **What:** A user who calls `launchEdge(token)` on Cloudflare gets a non-partitioned client; the DO lazy launcher then reuses it. The later cloudflare-side launch *requests* `partitionCaptureByTenant: true` and does not get it, and the only diagnostic is "`launch() called more than once … ignored`" — nothing names the isolation loss, and no code inspects the reused client's store. The explicitly-filed sibling shape (explicit `captureStore`) was fixed; this one was in the same finding.

### 4. `maxTenantPartitions` accepts absurd values with silent capture-destroying or bound-removing results
- **Where:** `packages/vercel-edge/src/launch.ts:217` (no validation), `:238-243`; `packages/core/src/partitioned-capture-store.ts:46`, `:78`
- **What (all measured against the real stores through the exact launch expressions):**
  - `0` or `-1`: every owned partition is evicted the moment it is created (`while (owned.size > maxPartitions)`), so ALL tenant capture is silently dropped — `scoped(t3)=0` with entries added; the only signal is the eviction onError at incident time. `-1` additionally derives an `Infinity` byte cap for the rings (10 MB / 0).
  - `NaN` (reachable as `Number(env.UNSET_VAR)` in user config): BOTH bounds vanish — probe retained 53 of 53 owner partitions (`owned.size > NaN` is false) each with a `NaN` byte cap that never evicts (only the 60 s window trims), i.e. the unbounded-memory failure mode of SEV1 #2 comes back.
  - `1e9`: per-partition cap `max(1, …)` = 1 byte → each tenant retains only the current 1-second part (measured: 5 of 50 entries), and the partition-count bound is effectively unbounded.
  - Non-integer (`2.5`): retains 2 partitions but budgets for 3.5 — benign under-allocation.
- **Why SEV3:** requires invalid caller input; but the knob is security/memory-relevant and one `Number.isInteger(v) && v >= 1` guard closes all of it.

### 5. Per-partition budget division cuts capture headroom 9× for EVERY Cloudflare Worker — measured fidelity numbers
- **Where:** `packages/vercel-edge/src/launch.ts:238-241` with `packages/cloudflare/src/launch.ts:32` (`partitionCaptureByTenant: true` for every `@bugsee/cloudflare` launch, DOs or not)
- **What:** With defaults, every partition — including the default ring that holds ALL capture for a Worker with no DOs — gets 10 MB / 9 ≈ 1.11 MB. Measured against the real store (60 s window, ticked):
  - logs-only tenant (20 × 300 B/s = 6 KB/s): full ~60 s retained — **unaffected** (the suspicion of "uselessly small" is refuted for typical tenants);
  - moderate (25 KB/s of bodies): ~44 s vs 60 s;
  - chatty (180 KB/s — pass 1's fill-rate scenario): **~5 s of history vs ~55 s pre-fix**.
  So bundles are not near-empty, but a busy tenant's forensic window shrinks ~11×, and single-tenant Workers pay it for no isolation benefit. The static divisor is the simplest safe bound and the design doc documents it honestly (§4.5), but dividing by the LIVE partition count (or the doc's original global-pool proposal) would restore the common case. Tunable today via `maxDataSize` / `maxTenantPartitions`.

### 6. Pass-1's SEV1 #1 scenario has no committed e2e regression test
- **Where:** `packages/instrumentation-tests/test/durable-object-tenants.e2e.ts` (only DO-scoped incidents); no workerd fixture exercises an owner-less report on a multi-tenant isolate
- **What:** The unscoped-drain leak is guarded at unit level only (the new core regression test, verified load-bearing). This pass had to build the front-fault probe itself; it passed on fixed code and detected the leak under the revert, so it is a cheap, proven candidate to commit.

## My seven suspicions

1. **`evicted` Set unbounded — CONFIRMED.** SEV2 #1 above: ~101 B/owner measured, no pruning path but owner-return, `clear()` does not touch it. Growth needs distinct-tenant churn past the LRU bound; quantified at ~10 MB per 100k churned DOs.
2. **Uselessly small buffers — PARTLY REFUTED, measured.** 1.11 MB retains the FULL 60 s window for a logs-rate tenant; the cliff is real only for body-heavy tenants (5 s at 180 KB/s). A busy DO does not "evict its own data within seconds" at ordinary rates. The uncounted cost: single-tenant Workers also drop to 1.11 MB (SEV3 #5).
3. **Unscoped → default-only loses data it should keep — REFUTED for the mainline, CONFIRMED as designed for the edge cases.** On real workerd, the DO's OWN incident carries its own capture (`logs.json` with the C-only marker), and the owner-less front incident carries the default partition's capture (`FRONT-LOG-MARK`) — neither bundle is empty. What an owner-less report can no longer see is tenant-partition capture (constructor logs, DO floating-promise rejections) — the documented §4.4 trade, and the include-everything alternative is the leak itself. No realistic path found to an empty bundle for a DO's own mainline incident.
4. **`/__owners` fixture-only + probe soundness — CONFIRMED CLEAN.** `__owners` and `owners()` appear only in the fixture and tests (repo-wide grep); production exposes nothing new (the DI token pre-exists). The probe cannot pass spuriously: per-isolate carrier client, read-only `owners()`, unowned probe request; the one-tenant mutation makes it fail; the three values are distinct real DO ids.
5. **`maxTenantPartitions` plumbing — CORRECT for valid input, UNVALIDATED for absurd input.** Divisor `+1` matches the store's N-owned-plus-default shape exactly (unit-verified, mutation-verified). Absurd values: SEV3 #4.
6. **`assertNoSecrets` provenance — CONFIRMED WORKING on real bundles.** Real workerd bundle: `apptoken` undeclared root entry, token inside, manifest declares only payload files; `assertNoSecrets` with the real token passes; declared-`apptoken` smuggling now caught (negative test, mutation-verified). `assertBundleIntegrity`'s name-keyed `STRUCTURAL_FILES` is behaviorally equivalent (analysis in table row 8).
7. **CI wiring — CONFIRMED.** `test:unit` runs in the `check` job (`ci.yml:59-60`), resolves to a real command for the harness package (26 tests observed), and an induced assertion break fails `turbo run test:unit` with exit 1.

## New defects introduced by the fixes

- **N1 (SEV2 #1):** the unbounded `evicted` Set — the fix for "silently empty bundle" reintroduced the unbounded-per-tenant-memory class it sits next to.
- **N2 (SEV2 #2):** acceptance-e2e blind spot: the workerd suite cannot detect the isolation machinery destroying the very capture it must preserve (aliased C secret + envelope-satisfiable assertion).
- **N3 (SEV3 #4):** unvalidated `maxTenantPartitions` (0/-1 destroy tenant capture; NaN removes both memory bounds; 1e9 → 1-byte rings).
- **N4 (SEV3 #5):** 9× capture-headroom cut for all Cloudflare Workers including single-tenant ones (measured; documented; tunable).
- Also noted: the eviction diagnostic names the internal option (`maxPartitions`) rather than the user-facing `maxTenantPartitions` (`partitioned-capture-store.ts:118`).

## Checked and found clean

- **SEV1 #1 end-to-end, both directions** on real workerd (fixed → no secrets + own capture present; reverted → both secrets reappear). The revert is also caught by the core unit test and 3 further scoped-snapshot tests catch a scoped-drain kill.
- **All five commit-added tests are load-bearing** under applied-and-confirmed mutations (M1 unscoped revert, M2 division removal, M3 evicted-tracking removal, M4 captureStore-onError removal, M5 provenance revert → each exactly one targeted failure). First mutation round produced five false survivors (mutator crashed under the scratchpad's `"type": "module"`); every result above is from confirmed-applied mutations only.
- **Suites:** root `pnpm test` 331 files / 3819 tests green; harness `test:unit` 26/26; DO e2e 3/3 on real workerd; `tsc --noEmit` clean on core / vercel-edge / instrumentation-tests.
- **Total-memory bound:** 9 × 1,165,084 B ≈ 10.0 MB ≤ `maxDataSize` — SEV1 #2's 116 MB ceiling is gone; the non-partitioned branch (`launch.ts:246`) still gets the full, undivided budget.
- **Docs corrections match the code:** design §4.4 (both-directions fail-closed) and §4.5 (division as built, old proposal named), Cloudflare README build-vs-load mechanism (bundle builds, workerd fails at load), harness README's two claims about where the unit tests run.
- **`combinedSnapshot` edge cases:** empty-source snapshot streams nothing, drains an empty map, release is guarded; `tick`/`clear` still reach all partitions (unscoped read-narrowing did not leak into maintenance paths).
- **Turbo task shape:** `test:unit` mirrors the existing `test:coverage` convention (`dependsOn: ["^build"]`); CI runs on fresh checkouts, so caching cannot mask a failure there.
- **Repo hygiene:** working tree restored after every mutation/probe; `git status --short` empty apart from this report.
