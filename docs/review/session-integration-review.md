# Session integration review — final adversarial pass (composition + coherence)

**Reviewed:** 2026-07-28 · **Scope:** `git diff 5fb6fe3..HEAD -- packages/ .github/ turbo.json pnpm-workspace.yaml` (24 commits), reviewed as a WHOLE — cross-cutting integration, untouched-platform regression, doc-vs-code truth, CI coherence. Deliberately does **not** re-audit what the four prior passes covered (`session-changes-review.md`, `session-changes-review-pass2.md`, `pass2-fixes-review.md`, `electron-wave02-review.md`); their verdicts were read, their findings spot-confirmed as fixed, and this pass looked at the seams between their scopes.

**Empirical basis (all run fresh in this pass):**
- `pnpm typecheck` — 83 tasks clean.
- Root unit suite — **331 files / 3839 tests, all green** (includes every untouched platform: node, browser, electron, webworker, webview, bun, deno, capture, node-utils, browser-utils).
- Harness unit (`turbo run test:unit --filter=@bugsee/instrumentation-tests`) — 26/26 green.
- Full harness e2e (`turbo run test:e2e --filter=@bugsee/instrumentation-tests`) — **7 files / 89 tests green** on real bun 1.3.14, real deno 2.8.3, and real workerd (miniflare), including `durable-object-tenants.e2e.ts` (4 tests, 3 real tenants in one real isolate).
- `pnpm lint` — clean (4 warnings, 2 infos, no errors).
- **5 targeted mutations, every one applied-verified (grep after edit) and every one KILLED** (see Contract-migration audit). All rolled back via `cp` backups; `git status --short` empty at finish.

## Verdict

**The session's work is coherent and safe to build on.** The `StoredEntry.owner` / `snapshot(options)` contract change composes correctly end-to-end (aggregator → partitioned store → exporter → client drain → cloudflare wiring → real-workerd e2e), every mutation at every link of that chain is killed by a unit test, no untouched platform regressed, CI genuinely gates every suite that exists, and the four audited docs tell the truth — with one bounded test-net gap (SEV2 #1) and three hygiene items.

## Contract-migration audit (`owner` + `snapshot(options)` across every store impl and caller)

### The chain, link by link (all verified, mutations in brackets)

| Link | Where | Behaviour | Mutation result |
|---|---|---|---|
| Producer | `packages/vercel-edge/src/edge-context.ts:58` (`runInEdgeContext`) — the **only** place in the repo that sets `RequestContext.owner` | DO id → context | **KILLED** (M2: line replaced with `...({})` → 2 failures in `edge-context.test.ts`) |
| Cloudflare pass-through | `packages/cloudflare/src/instrument-class.ts:88,102`; `instrument-durable-object.ts:15-23` (`durableObjectOwner`, defensive) | owner resolved once per DO instance, passed per invocation | **KILLED** (M3: `:102` spread removed → 1 failure in cloudflare suite) |
| Stamp | `packages/core/src/capture-aggregator.ts:63-68` — owner read from the SAME context read as the trace stamp, passed out-of-band | `store.add({..., owner?})` | **KILLED** (M4: `owner = undefined` → aggregator test fails) |
| Store | `packages/core/src/partitioned-capture-store.ts` — routing `:89-125`, fail-closed-both-directions `:129-155`, bounded evicted-set `:80-84`, shared coercion `resolveMaxPartitions` `:58-62` | only instantiation site: `packages/vercel-edge/src/launch.ts:267-278` (budget ÷ `maxTenantPartitions + 1`, same coercion both sides) | covered by prior passes' mutations (re-confirmed green) |
| Exporter | `packages/core/src/capture-exporter.ts:31` (stream) and `:54` (drain) pass `options` through to `store.snapshot(options)` | | **KILLED ×2** (M1a drain `:54` → 1 failure; M1b stream `:31` → 1 failure in `capture-exporter.test.ts`) |
| Client drain | `packages/core/src/client.ts:349-352` — scoped iff `reportContexts.get(request)?.owner` defined; `reportContexts` is the pre-existing WeakMap (`client.ts:314`), so the owner survives detached assembly | | mutated by pass 2 (their M3, real-workerd re-proof); not repeated |
| Acceptance | `packages/instrumentation-tests/test/durable-object-tenants.e2e.ts` on real workerd — un-blinded (`OWN_LOG_C` distinct from the fault string, per pass-2 SEV2 #2) | green in this pass | — |

### Every store implementation, one by one

- `partitioned-capture-store.ts:196-198` — honours `options.owner`; scoped → that tenant only, unscoped → default partition only (fail closed both ways, matching design §4.4).
- `chunk-capture-store.ts:101` — `snapshot()` takes no options, i.e. **ignores** a scope. Correct today: it is never composed with partitioning (partitions are `createMemoryCaptureStore` instances, `vercel-edge/src/launch.ts:271`), and no platform that uses the chunk store ever produces an `owner` (see SEV3 #1 for the latent half of this).
- `memory-capture-store.ts` — used AS the partition; snapshot unscoped by design (a partition is single-tenant).
- `streaming-capture-store.ts:94` — snapshot is always empty (electron renderer / webview stream up, no local bundle); ignoring a scope is vacuously correct. Its `add` (`:73-85`) picks fields **explicitly**, so an `owner` on the record would be dropped at the wire, never leaked as an unknown field to native receivers.
- `webview/src/host-bridge-capture-store.ts` — same empty-snapshot family; typecheck confirms the widened optional-arg contract is structurally satisfied.
- Chunk **backends** (`file-chunk-backend.ts:111`, `memory-chunk-backend.ts:69`, `browser-utils/src/idb-chunk-backend.ts:202`) implement `ChunkBackend.snapshot(parts)` — a different contract (`chunk-backend.ts:56`), untouched by this session. `capture-recovery.ts:67` and `native-crash-recovery.ts:108` call **that** signature; neither should nor could take an owner scope. No caller of `CaptureStore.snapshot` exists outside the exporter — verified by repo-wide grep.

### The Electron × partitioning question (posed by the task)

`packages/electron/src/main-receiver.ts:50-54` adds renderer entries with `{type, timestamp, serialized}` — **no `owner`**. Electron main's store is the node file/chunk store; `createPartitionedCaptureStore` is instantiated in exactly one place in the whole repo (`vercel-edge/src/launch.ts:267`), which no electron path reaches. If the two features were ever composed, owner-less renderer entries would land in the default partition and a tenant-scoped snapshot would exclude them — which is the *documented* fail-closed §4.4 semantics, not a corruption. Not reachable today; flagged as a composition note, not a finding.

## Untouched-platform regression check

- **node / bun / deno / browser / webworker / webview / electron / capture / node-utils / browser-utils:** full root suite green (331/3839), `pnpm typecheck` clean across all 83 tasks. None of these ever produces `StoredEntry.owner` (the only producer is `edge-context.ts:58`); their stores' 0-arg `snapshot()` remains assignable to the widened optional-arg contract (verbatim TS structural rule, proven by the clean typecheck).
- **`owner` naming collision — checked, benign:** `packages/node/src/server-instrument.ts` uses "owner" for first-owner-wins re-entrancy (spans), entirely disjoint from tenant `RequestContext.owner`; no code path connects them (repo-wide grep of `owner:` producers).
- **Electron wire (Wave 0.2):** `KNOWN_FILE_TYPES` = `Object.keys(DEFAULT_FILENAMES) + 'attachment'` (`electron/src/protocol.ts`); `DEFAULT_FILENAMES` is typed `Record<Exclude<FileType,'attachment'>, string>` (`protocol/src/constants.ts:35`), so the closed set is **exhaustive by construction** — no legitimate renderer FileType (incl. `replay`, `video`) can be dropped by the new validation. `protocol/src/upload-contract.test.ts` additionally pins the schema's enum to the same source of truth.
- **Vercel Edge (non-Cloudflare):** `partitionCaptureByTenant` defaults false (`vercel-edge/src/launch.ts`), store construction is byte-identical to before; `edge.e2e.ts` green.

## Doc-vs-code audit

- `docs/design/cloudflare-tenant-isolation.md` — **matches the code as built.** §4.4 states fail-closed in BOTH directions (code: `partitioned-capture-store.ts:138-155`); §4.5 carries an explicit "As built (corrected 2026-07-28)" note replacing the original full-budget-per-partition wording with the division actually implemented (`launch.ts:271-274`); §8 Outcome maps slices to real commits; §6 Q3 honestly listed as still open.
- `packages/cloudflare/README.md` — **accurate.** "`nodejs_compat` is REQUIRED" matches the top-level `node:async_hooks` import in `cloudflare/src/launch.ts` (+ the deliberate minimal ambient `node-async-hooks.d.ts`); "on by default; `partitionCaptureByTenant: false` disables it" matches `launch.ts` (defaults spread before caller options); the `maxTenantPartitions: 3` → "10 MB / 4 ≈ 2.5 MB" math matches `DEFAULT_MAX_DATA_SIZE_MB = 10` (`vercel-edge/src/launch.ts:57`) and the `+ 1` divisor. The lazy-launcher path (`launch-config.ts:32-41`) routes DO-first construction through this same partitioned launch, so the README's "on by default" holds even when no explicit `launch()` call precedes a DO.
- `packages/instrumentation-tests/README.md` — **accurate**, including the claim that `test:unit` runs in the CI `check` job (`.github/workflows/ci.yml`) and the runtime-skip semantics.
- `docs/review/REMEDIATION-PLAN.md` — **stale in two ways** (SEV3 #2): it still prescribes the *rejected* approach for 0.1 and states as current a CI hole that is now closed. It carries no status marks at all despite waves 0.1, 0.2 and 3a.1 being executed.

## CI coherence

- **`check` job** (`.github/workflows/ci.yml`): lint → typecheck → cycles → `turbo run test:coverage` (per-package gate) → `turbo run test:unit`. The last step is the new gate for `bundle.test.ts`; only `@bugsee/instrumentation-tests` defines `test:unit`, its command is real (`vitest run --config vitest.unit.config.ts`, include `test/**/*.test.ts` → 26 tests), and a failure exits non-zero through turbo (prior pass proved the induced-failure path; this pass re-ran it green). Every other package showing `<NONEXISTENT>` for `test:unit`/`test:e2e` in `turbo --dry` is turbo's benign missing-script skip — their real suites run under `test:coverage` (140 task-lines in the dry run).
- **`e2e` job**: installs bun + deno, then a hard "Verify the runtime matrix is complete" step (`node/bun/deno --version` — fails the job if absent, closing the silent-skip in `test/runtimes.ts`), then `turbo run test:e2e` over the exactly four packages that define it (`instrumentation-tests`, `nuxt-e2e`, `sveltekit-e2e`, `astro-e2e` — verified by grep). `turbo.json` defines both tasks (`test:e2e` uncached); `pnpm-workspace.yaml` allows the workerd postinstall so miniflare has its binary. workerd is not in the version-check step, but a missing workerd makes `new Miniflare()` **throw in `beforeAll`** (test failure, not a skip) — no silent hole.
- Every suite that exists in the repo now runs in exactly one CI job; nothing runs nowhere. Verified via `turbo --dry` + the two live runs.

## SEV1

None.

## SEV2

1. **The upload-contract schema net is asserted in only one of the three collector-backed e2e suites — the two EDGE suites this session added never check it.**
   - **Where:** `packages/instrumentation-tests/test/bundle.ts:134` (`assertNoContractViolations`) has exactly one e2e caller: `test/instrumentation.e2e.ts:119`. `test/edge.e2e.ts` and `test/durable-object-tenants.e2e.ts` both use the same validating collector (`test/collector.ts` records every ajv failure into `collector.violations` — by design it "RECORDS rather than rejects") but neither ever reads `.violations` (repo grep: no other caller).
   - **What:** a wire-contract violation produced by the **edge bundle-assembly path** — a genuinely different assembler from the node one, and the very path this session built — would be recorded by the collector and then silently discarded when the suite passes. The commit intent (e5ca83b "schema-validate the upload contract in the mock collector") is only enforced for node/bun/deno uploads.
   - **Why bounded:** the edge suites do assert bundle structure and content directly (`assertBundleIntegrity`, secret/log content), and `protocol/src/upload-contract.test.ts` pins the schema's enums to the TS wire types; only the *schema-conformance* dimension of edge uploads is unasserted.
   - **Fix shape:** one line in each suite's assertions (`assertNoContractViolations(collector)`), same as `instrumentation.e2e.ts:119`.

## SEV3

1. **`StoredEntry.owner` survives only in memory backends — durable backends silently drop it, and the contract does not say so.** `packages/core/src/memory-chunk-backend.ts:38-40` stores the whole record (owner kept); `packages/core/src/file-chunk-backend.ts:84-91` frames `${timestamp}\t${serialized}\n` (owner dropped); `packages/browser-utils/src/idb-chunk-backend.ts:170-177` stores `{t, s, ty}` (owner dropped). Harmless today — the only owner producer is edge (`edge-context.ts:58`), which is memory-only — but the asymmetry is undocumented at the `StoredEntry.owner` contract comment (`contracts.ts:88-90`), and a future platform that sets `owner` on node/browser would (a) lose tenancy through recovery and (b) get a *silently unscoped* result from `chunk-capture-store.ts:101`'s options-ignoring `snapshot()` while the client believes it scoped the drain (`client.ts:350-352`). One sentence at the contract ("owner is a memory-store routing key; durable backends do not persist it") and/or a debug assert would close the trap.
2. **`docs/review/REMEDIATION-PLAN.md` is now materially stale with zero status tracking.** Line 22 (Wave 0.1) prescribes "give each DO instance its own store; never share module-scope capture state" — the approach `docs/design/cloudflare-tenant-isolation.md` §3.A explicitly **rejects as architecturally impossible** (carrier-enforced singleton), superseded by the built Option C. Wave 3a.1's "`turbo run test:coverage` currently resolves to `<NONEXISTENT>` for all four harnesses" is no longer true (fixed by 6d00362 + the `test:unit` gate). No DONE/superseded marks exist anywhere in the file (grep). An engineer treating the plan as the work list would re-attempt 0.1 the impossible way or re-do 3a.1. Add per-item status/pointer lines.
3. **The harness reaches into `@bugsee/protocol` by relative path for a file the package does not ship.** `test/collector.ts` imports `'../../protocol/upload-contract.schema.json'` while its comment says the schema is "shipped from @bugsee/protocol" — `packages/protocol/package.json` has `files: ["dist"]` and no exports entry for the schema, so nothing ships it; this works only as a monorepo reach-around (fine for a private harness, but the comment overstates and a future `files`-respecting consumer would break). Either export the schema from protocol or soften the comment.

## What the earlier passes missed

- **SEV2 #1** is precisely a between-scopes gap: pass 1 reviewed the collector schema work (its scope: the V0 library), pass 2 un-blinded the DO e2e's *content* assertions — neither noticed that the two edge suites never assert the violations channel the collector was taught to record.
- The **durable-backend `owner` drop** (SEV3 #1): all owner-related mutations in prior passes ran against the memory store, where the field survives; nobody traced the field through `file-chunk-backend`/`idb-chunk-backend` framing.
- The **REMEDIATION-PLAN staleness** (SEV3 #2): every prior pass treated the plan as input, none checked it as an artifact against the code it had meanwhile changed.

## Checked and found clean

- Composition of the full owner chain, five fresh mutations, all killed (table above) — no false survivors (every mutation grep-confirmed applied before its run).
- All four prior-pass fix sets spot-confirmed still in place and their regression tests green (fail-closed `partitionsFor`, budget division + shared `resolveMaxPartitions` coercion, bounded evicted set, electron `t`/`ts`/payload validation, un-blinded workerd e2e, apptoken provenance).
- Untouched platforms: 331/3839 unit tests + 83 typecheck tasks + 89 e2e tests green; no platform receives an `owner` it must understand, none drops a `snapshot` scope it should honour.
- `snapshot(options?)` caller audit: the exporter is the only `CaptureStore.snapshot` caller; recovery paths use the separate `ChunkBackend.snapshot(parts)` contract — unaffected by design, verified by grep.
- Cloudflare DO-first construction (`createLazyLauncher` → cloudflare `launch` → partitioned store): partitioning holds regardless of which side launches first; caller-supplied `captureStore` with partitioning requested is loudly reported (`vercel-edge/src/launch.ts` onError message).
- Electron main-receiver → default-store composition (owner-less by wire; no partitioned store reachable — single instantiation site).
- CI: no suite runs nowhere; `<NONEXISTENT>` occurrences are benign missing-script skips; bun/deno hard-verified in the e2e job; workerd failure mode is a test failure, not a skip.
- Docs: design doc, cloudflare README, harness README all match the code as it stands (including the corrected §4.5 memory model and the `nodejs_compat` requirement).
- `core/dist` observed containing new exports is a local, untracked build artifact (`git ls-files` empty) — nothing stale is committed.
- Working tree restored and clean: `git status --short` empty at completion.
