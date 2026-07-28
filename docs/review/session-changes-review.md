# Adversarial review — Wave V0 + Wave 0.1 changes (session of 2026-07-27/28)

**Reviewed:** 2026-07-28 · **Scope:** `git 5fb6fe3..HEAD -- packages/ .github/ turbo.json pnpm-workspace.yaml`, code only
**Verdict:** Keep it, but do **not** call Wave 0.1 done. The core mechanism (owner key → partitioned store → owner-scoped drain) is correctly built, well tested at unit level, and empirically fixes the exact leak the review filed — I reproduced the fix and the regression on real workerd. But three things are wrong. (1) The fail-closed policy holds only for owner-**scoped** snapshots; an owner-**less** report on the same multi-tenant isolate still drains every tenant's partition, and I proved that end-to-end on real workerd with a documented, supported handler shape (`withBugsee` module handler + instrumented DOs). SEV1 #2 is therefore reduced, not closed. (2) The memory deviation you suspected is real and is worse than "a deviation": measured, 9 full partitions hold ~116 MB of V8 heap against a 128 MB isolate limit, up from ~13 MB before, with no knob to change it. (3) The S5 e2e's first assertion is vacuous — I ran it with tenants A and B never dispatched at all and all three tests still passed, so the "they really shared one isolate" guard guards nothing. Everything else — the schema, the assertion library, the allowlist guard, the platform-neutrality claim — checked out, several of them under mutation.

## SEV1

### 1. Fail-closed does not hold: an owner-less report drains EVERY tenant's partition
- **Where:** `packages/core/src/partitioned-capture-store.ts:96-102` (`partitionsFor(undefined)` → `allPartitions()`) with `packages/core/src/client.ts:349-352` (drain is scoped only when `reportContext?.owner !== undefined`)
- **What:** The policy is asymmetric. An owner-**scoped** snapshot fails closed (unknown owner → `[]`, default partition excluded). An **unscoped** snapshot — the branch taken whenever the faulting report has no `RequestContext.owner` — returns the merged contents of the default partition **and every tenant partition**. On a multi-tenant isolate that is the original leak, unchanged.
- **Why it matters:** It is not a corner case. Any Worker that mixes instrumented Durable Objects with an instrumented module `fetch` handler (both documented in `packages/cloudflare/README.md`, both exported from `packages/cloudflare/src/index.ts`) has an owner-less report path: `withBugsee`'s fetch wrapper never passes `owner` (`packages/cloudflare/src/with-bugsee.ts:81-113` — no `owner` in any `runInEdgeContext` call), so a front-handler incident drains A's and B's DO rings. The same holds for the on-by-default `unhandledrejection` safety net (`packages/vercel-edge/src/detection.ts`), which fires outside any DO context.
- **Evidence (reproduced on real workerd via miniflare, `nodejs_compat`, three instrumented DOs + a `withBugsee` front handler):**
  ```
  tenant A/B status: 200 200
  front-fault status: 500
  sessions: 1 issues: 1 uploads: 1
  bundle mentions FRONT-INCIDENT: true
  LEAK tenant A secret in front bundle: true
  LEAK tenant B secret in front bundle: true
  context: … == logs.json == [{"…","message":"SECRET-OF-TENANT-A","context_id":"7c69d847…"}, …
  ```
  The front handler's incident bundle carried both DO tenants' secrets, verbatim, off the isolate. The S5 e2e does not see this because its front handler is a bare (uninstrumented) `fetch` that only proxies to the DO, so it never produces an owner-less report.
- **Note:** the comment at `partitioned-capture-store.ts:91-95` states the policy as if it were global ("excluded from **every** owner-scoped snapshot" — true, but that is exactly the gap: the leak is on the *unscoped* path, which the comment does not address).

### 2. Memory: 9 partitions × the full `maxDataSize` ≈ 116 MB measured heap vs a 128 MB isolate
- **Where:** `packages/vercel-edge/src/launch.ts:199-213` (each partition is built with the **same** `memoryStoreOptions`, i.e. the full `maxDataSizeBytes`) and `packages/core/src/partitioned-capture-store.ts:41` (`DEFAULT_MAX_PARTITIONS = 8`, default partition additionally never reclaimed → 9 rings)
- **What:** Your suspicion is confirmed, with numbers. Edge default `maxDataSize` is 10 MB (`packages/vercel-edge/src/launch.ts:55`). Ceiling before this change: 10 MB serialized in one ring. Ceiling after: 90 MB serialized across 9 rings.
- **Evidence (measured against the REAL `createMemoryCaptureStore`, `--expose-gc`, ~300-byte unique JSON entries):**
  ```
  entries: 31687, serialized bytes: 10.0 MB
  heap held by ONE full 10MB-capped store: 12.9 MB
  x9 partitions (8 owned + default): 116 MB vs 128 MB isolate limit
  ```
  A Cloudflare Worker isolate is killed at 128 MB. 116 MB of capture buffer leaves ~12 MB for the customer's own code, the SDK and V8 overhead.
- **Preconditions, stated honestly:** each partition also has the 60 s rolling window, so a tenant must sustain ~170 KB/s of capture to fill 10 MB. With network-body capture on by default (`maxNetworkBodySize` 20480), that is roughly 9 captured requests/s per DO — high, but well within a chatty real-time Durable Object. Eight such DOs in one isolate is the archetypal DO deployment.
- **Aggravating factor:** the byte cap can only evict **closed** parts and requires `parts.length > 1` (`packages/core/src/chunk-capture-store.ts:59-68`). Parts are closed only by `tick()` (`:83-99`), driven by `setInterval` (`packages/core/src/client.ts:654`). Wherever ticks do not advance, a partition is a single unbounded open part and neither the byte cap nor the window applies — so 116 MB is the *favourable* bound, not the worst case.
- **No mitigation available to the customer:** `maxPartitions` is never plumbed through — `packages/vercel-edge/src/launch.ts:209-212` passes only `createPartition` and `onError`, and `BugseeEdgeLaunchOptions` exposes no knob. There is no way to lower the partition count or the per-partition budget independently of the global one.

### 3. The S5 e2e's co-location assertion is vacuous — it passes with ONE tenant and no co-location
- **Where:** `packages/instrumentation-tests/test/durable-object-tenants.e2e.ts:54-58`
- **What:** `expect(collector.sessions.length).toBe(1)` is claimed as the observable proxy for "the three DOs shared one isolate ... otherwise this test proves nothing". It is not a proxy for that at all. `POST /v2/sessions` is issued from exactly one place, `packages/core/src/upload-pipeline.ts:79`, i.e. **per upload**. Capture is incident-driven, so tenants A and B never upload and never create a session. `sessions.length === 1` therefore means "exactly one incident occurred" and is completely insensitive to isolate placement.
- **Evidence (mutation: delete the A and B dispatches at `durable-object-tenants.e2e.ts:43-44`, so ONE DO runs and co-location is impossible):**
  ```
  --- applied? diff:
  43,44d42
  <     await mf.dispatchFetch(`http://do.test/?tenant=A&secret=${SECRET_A}`);
  <     await mf.dispatchFetch(`http://do.test/?tenant=B&secret=${SECRET_B}`);
   Test Files  1 passed (1)
        Tests  3 passed (3)
  ```
  All three tests green, including "the three tenants really did share ONE isolate". In that world assertion 3 (`not.toContain(SECRET_A/B)`) is also trivially satisfied. The guard that exists to stop the suite going vacuous cannot detect the suite going vacuous.
- **Why it matters:** if workerd ever changes DO placement, this suite reports green while testing nothing, and the guard was written specifically to prevent that. A sound proxy would assert something isolate-scoped and observable — e.g. that the three DO ids appear as distinct `context_id`s within a single client's capture, or that the bundle contains entries whose owner partitions coexisted.
- **The rest of the suite does have teeth** (verified separately, see "seven suspicions" #5) — this finding is about assertion 1 only, and about the claim it makes.

## SEV2

### 4. The assertion library's own tests run in NO CI job
- **Where:** `packages/instrumentation-tests/package.json:7-9` (scripts: `test:e2e`, `typecheck` — no `test`/`test:coverage`), `packages/instrumentation-tests/vitest.config.ts` (`include: ['test/**/*.e2e.ts']`), `.github/workflows/ci.yml:52-54` + `:104`
- **What:** `test/bundle.test.ts` is the negative-test suite that is the entire justification for trusting `bundle.ts` ("an assertion library that cannot fail is precisely the theater this work removes", `bundle.ts:20-22`). In CI it runs nowhere: the `check` job runs `turbo run test:coverage`, and instrumentation-tests has no such script; the new `e2e` job runs `turbo run test:e2e`, whose vitest config globs only `*.e2e.ts`.
- **Evidence:**
  ```
  $ turbo run test:coverage --dry=json | …
  { "package": "@bugsee/instrumentation-tests", "command": "<NONEXISTENT>", … }
  tasks with NONEXISTENT command: 5 of 86
  ```
  This is the *same* `<NONEXISTENT>` silent-skip the new CI job was written to fix (`.github/workflows/ci.yml:58-63` names it as the root cause). The 24 tests do pass — I forced them via the vitest node API — they simply never run in the gate.
- **Claim affected:** `packages/instrumentation-tests/README.md:20-22` — "Those are `*.test.ts` on purpose, so they run in the fast `pnpm test` gate." True for a developer running root `pnpm test` locally (root `vitest.config.ts` globs `packages/*/{src,test}/**/*.test.ts`); false for CI, which never runs root `pnpm test`.

### 5. An LRU-evicted tenant's incident bundle is silently EMPTY
- **Where:** `packages/core/src/partitioned-capture-store.ts:74-80` (evict) with `:100-101` (unknown owner → `[]`)
- **What:** Eviction removes the partition from the map without any record that the owner existed. A later incident in that DO resolves to "unknown owner" and produces a bundle with **no capture at all** — no logs, no network, nothing — indistinguishable from a DO that never captured. On an isolate hosting more than 8 active DOs (Cloudflare routinely co-locates far more), a cold-but-live tenant's incident report is a shell.
- **Why SEV2 not SEV1:** it is data loss, not a leak, and the report envelope still uploads. But it is silent — no `onError`, no marker — and the pre-change behaviour was "leaky but present". Worth at least surfacing through `onError` so it is diagnosable.

### 6. An explicit `captureStore` (or a `launchEdge` call) silently disables tenant isolation
- **Where:** `packages/vercel-edge/src/launch.ts:204-213`
- **What:** `options.captureStore ?? (partitionCaptureByTenant ? partitioned : memory)` — a caller-supplied store wins over the partitioning switch with no warning, so an advanced user who injects a store on Cloudflare gets the pre-fix leak back. Same shape for the launch path: `@bugsee/cloudflare` re-exports `launchEdge` (`packages/cloudflare/src/index.ts:8`), and a user calling `launchEdge(token)` directly gets a non-partitioned client which the DO lazy launcher then reuses via the carrier singleton (`packages/cloudflare/src/launch-config.ts:35-43`).
- **Why it matters:** a security-relevant default that any of three plausible call shapes turns off without diagnostics. At minimum this should `onError` when `partitionCaptureByTenant` is requested but not honoured.

## SEV3

### 7. A test assertion that cannot fail
- **Where:** `packages/vercel-edge/src/launch.test.ts:319` — `expect(provider ?? injected).toBeDefined();`
- **What:** `injected` is a const object defined 20 lines above, so the `??` fallback makes the expression unconditionally defined. The assertion is a no-op. The surrounding test is fine (the `store?.run(...)` assertions below it are real), but this line is exactly the theater the Wave V0 work is aimed at.

### 8. `apptoken` exemption is broader than "the file the assembler writes"
- **Where:** `packages/instrumentation-tests/test/bundle.ts:159` (`if (name === 'apptoken' …) continue`) and `:42` (`STRUCTURAL_FILES` includes `apptoken`)
- **What:** The exemption is by name, not by provenance. A bundle entry that happens to be named `apptoken` — an attachment with a user-chosen filename is the realistic route — is skipped by **both** `assertNoSecrets` and the undeclared-entry check in `assertBundleIntegrity`. Not exploitable in any adversarial sense (this is harness code and the assembler is the only producer today), but the exemption should key on "the assembler's structural apptoken", not on the string.
- **Verified not a problem:** the check is exact-match, so `logs/apptoken` or any nested path is still scanned.

### 9. Fixture comment claims behaviour the config does not produce
- **Where:** `packages/instrumentation-tests/app/do-tenants-worker.ts:57` — "Deterministic + fast: no background tick, and capture stays in memory until the incident."
- **What:** The config it annotates sets only `captureNetwork: false`. Nothing disables the tick; `client.launch()` starts it unconditionally (`packages/core/src/client.ts:654`) and the edge launch passes no scheduler override.

## The seven suspicions

**1. Memory / OOM — YOU WERE RIGHT, and it is quantified.** SEV1 #2. Measured 12.9 MB of V8 heap per full 10 MB-capped partition; 9 partitions = 116 MB against a 128 MB isolate limit, up from ~13 MB before the change. Design §4.5's "one global cap, evict from the largest partition first" was not implemented and `maxPartitions` is not even reachable from launch options. Reaching the ceiling needs sustained ~170 KB/s per tenant across 8 tenants — high but realistic for chatty DOs — and the ceiling is *optimistic* because the byte cap cannot evict the open part when ticks do not advance.

**2. Does fail-closed hold on the real path — NO.** SEV1 #1, reproduced end-to-end on real workerd: a `withBugsee` front-handler incident in an isolate hosting instrumented DOs uploaded both tenants' secrets. The exact path you guessed — "`snapshot()` with `owner: undefined` being called somewhere a tenant-scoped call was intended" — is real and is `client.ts:349-352`. There is exactly one exporter drain call site in the whole repo (verified by grep), and it is that one, so this is the complete surface: whenever the report has no owner, everything merges.

**3. "Single-tenant behaviour is unchanged" — TRUE, and it survives mutation-free scrutiny.** Verified four ways. (a) The partitioned store is only constructed when `partitionCaptureByTenant === true`, which only `@bugsee/cloudflare` sets — Vercel Edge, plain fetch handlers, node, browser, electron, webworker never see it (`packages/vercel-edge/src/launch.ts:204-213`). (b) `snapshot(options?)` is a *widened optional* parameter, so every existing zero-arg implementation stays structurally assignable; `tsc --noEmit` is clean for core, cloudflare, vercel-edge, protocol and instrumentation-tests. (c) `StoredEntry.owner` never reaches any persistence format: `file-chunk-backend.ts:88` frames `<timestamp>\t<serialized>` and `idb-chunk-backend.ts:174` stores `{t, s, ty}` — both drop `owner` by construction, so no disk/IDB format change. (d) Full suites green with no regressions: node 435, browser 208, webworker 43, electron 115, capture 243, browser-utils 123, node-utils 146, core (4 changed files) 154, cloudflare 55, vercel-edge 69, protocol 189.

**4. S0's static node import — loud, not silent; no in-repo consumer broken; the allowlist is NOT too permissive.** No other package in the workspace depends on or imports `@bugsee/cloudflare` (`grep` over all `package.json` + all `src/*.ts`) — astro/nuxt/sveltekit/hono do not, so nothing in-repo is affected. On failure mode: the README claim "**Without it your Worker fails to build**" is only partly right — see "Claims" below. The allowlist has real teeth: injecting `import { hostname } from 'node:os'` into `packages/vercel-edge/src/launch.ts` produced `AssertionError: expected [ 'node:os' ] to deeply equal []` **and** `expected [ 'node:async_hooks', 'node:os' ] to deeply equal [ 'node:async_hooks' ]` — both packages failed, exactly as designed. The metafile-based `nodeImports` (`edge-bundle.ts:56-70`) is also a genuine improvement over the previous regex, which the diff correctly documents.

**5. Does S5 prove what you claim — PARTLY. The isolation assertions do; the co-location proxy does not.** Teeth verified independently: reverting `partitionCaptureByTenant` to `false` in `packages/cloudflare/src/launch.ts:32` produced `AssertionError: expected '{"type":"error","summary":"INCIDENT-I…' not to contain 'SECRET-OF-TENANT-A'`, with the full leaked `logs.json` showing all three tenants' messages — so assertion 3 is real and the fix is real. The FIRST assertion is vacuous: see SEV1 #3, where the suite stayed green with A and B never dispatched.

**6. Concurrency — YOU WERE WRONG TO SUSPECT THIS; I found nothing.** Owner resolution in `capture-aggregator.ts:60-67` reads the context twice, but both reads are **synchronous within one `route()` call** with no intervening await, so they cannot disagree; a wrong-partition interleaving is not reachable there. `client.assemble` reads `reportContexts.get(request)`, populated synchronously at report-submit time inside the still-open ALS scope (`client.ts:457-460`), so a detached/queued assembly cannot drain a different owner. `runInEdgeContext` runs the handler inside `store.run(context, …)` and the capture fires inside it by construction (`edge-context.ts:44-58` and its own doc comment). The partitioned store's LRU touch is synchronous map manipulation. The only real interleaving hazard would be the single-slot ALS fallback, and Cloudflare now always injects a real ALS. *(Redundant double `getContext()` call is a hygiene nit, not a defect — not filed.)*

**7. `assertNoSecrets`'s apptoken exemption — not exploitable, but broader than intended.** SEV3 #8. The exact-match means nested paths are still scanned; the residual risk is a same-named attachment escaping both this check and the undeclared-entry check. Separately worth knowing: the only secret currently passed to it is the app token (`instrumentation.e2e.ts`, "never leaks the app token outside the apptoken file"), so the assertion's live value is narrow — it proves the token appears nowhere *else*, which is a real if small property.

## Claims I made that do not hold

1. **"Fail closed (§4.4)" / "an incident uploads only the faulting tenant's data"** — `partitioned-capture-store.ts:91-95`, `vercel-edge/src/launch.ts:86-89`, `client.ts:344-348`. Only true when the report carries an owner. Proven false on real workerd for an owner-less report on a multi-tenant isolate (SEV1 #1).
2. **"SINGLE-TENANT IS UNCHANGED … a noisy tenant can no longer evict a quiet tenant's data"** — `partitioned-capture-store.ts:11-13`. The single-tenant half is true (verified). The second half is true only because each partition got its own full budget, which is precisely the deviation that creates the OOM ceiling — the fix for one unfiled defect created a larger one.
3. **Design §4.5 and the S2 slice row contradict the code** — `docs/design/cloudflare-tenant-isolation.md:112-114` ("keep **one global cap**, evict from the largest partition first") and `:123` ("per-owner rings, **global cap, largest-first eviction**, LRU reclaim"). The code implements neither; it gives every partition the full cap and bounds only the count. The doc, as committed in this session, describes a system that does not exist.
4. **"Without it your Worker fails to build with a module-resolution error"** — `packages/cloudflare/README.md:105`. Empirically, a wrangler-shaped esbuild bundle (`external: ['node:*']`, exactly what `edge-bundle.ts:bundleWorkerEntry` does) **builds fine**; the failure happens at worker **load**, when workerd cannot resolve the builtin. My probe: `BUILD succeeded (node:* external, as wrangler does): true`, then `NO FLAG: FAILED -> MiniflareCoreError [ERR_MODULE_RULE]: Unable to resolve … no matching module rules` versus `nodejs_compat: status=200 body=served`. The important half of the claim — that it fails loudly rather than silently degrading — **is** true and is the right call. The mechanism stated is not verified and is bundler-dependent.
5. **"`test/bundle.test.ts` … run in the fast `pnpm test` gate"** — `packages/instrumentation-tests/README.md:20-22` and `bundle.ts:20-22`. True locally, false in CI, where they run in neither job (SEV2 #4).
6. **"the three tenants really did share ONE isolate (otherwise this test proves nothing)"** — `durable-object-tenants.e2e.ts:54-58`. The assertion cannot detect what it names; the suite stays green with a single tenant and no co-location (SEV1 #3).
7. **"Deterministic + fast: no background tick"** — `app/do-tenants-worker.ts:57`. Nothing in the referenced config disables the tick (SEV3 #9).

## Checked and found clean

- **Owner never reaches the wire.** `capture-aggregator.ts:60-67` passes `owner` out-of-band alongside `type`/`timestamp`; the payload stamp (`:33-56`) is untouched. The negative tests cover both the plain and trace-active branches, and the persistence backends drop it structurally (see suspicion #3).
- **Fail-closed on the *scoped* path is genuinely enforced.** Mutation: making `partitionsFor` prepend the default partition to an owner-scoped read was caught — `× EXCLUDES unattributed entries once any owner exists (fail closed)`, 1 failed / 13 passed. The mutation was confirmed applied by diff first.
- **Edge bundle allowlist guard.** Caught an injected `node:os` import in both packages (see suspicion #4). Exact-equality, not a relaxed "any node import".
- **`assertBundleIntegrity`** (`bundle.ts:74-119`): correctly checks root files, manifest presence, declared-but-missing, the directory-shaped `name/` stand-in, empty declared files, and undeclared payloads. All 24 `bundle.test.ts` tests pass when forced to run.
- **Mock collector schema validation** (`collector.ts`): records rather than rejects, wraps the unzip in try/catch so a malformed bundle cannot crash the collector mid-scenario, and correctly validates `session.environment` (the nested envelope) rather than the whole body. Binds to `127.0.0.1`, force-closes keepalive sockets.
- **`upload-contract.schema.json` ↔ TS pinning** (`protocol/src/upload-contract.test.ts`): FileType enum derived from `DEFAULT_FILENAMES` at runtime (so it cannot silently drift), Severity range from the enum, `sdk.type` const, all-zero W3C id rejection. 189 protocol tests pass.
- **`readJson`** throws with the present-file list instead of returning `undefined` — the vacuous-assertion fix, correctly implemented.
- **DO owner derivation** (`instrument-durable-object.ts:15-23`): defensive against missing `id`, non-string `toString`, empty string and a throwing getter; resolved once per instance (`instrument-class.ts:88`), which is right — the tenant is a property of the DO, not the invocation. `WorkerEntrypoint` correctly passes no `resolveOwner`.
- **No unguarded `node:*`/DOM leakage beyond the Cloudflare tier.** The only new node import is `node:async_hooks` in `packages/cloudflare/src/launch.ts:7`, typed by a deliberately minimal ambient shim (`node-async-hooks.d.ts`) rather than `@types/node` — a good call that preserves the portability guardrail. `@bugsee/core`, `@bugsee/capture`, `@bugsee/vercel-edge` are unchanged in this respect and the allowlist test enforces it.
- **Snapshot release** is in a `finally` on both exporter paths (`capture-exporter.ts:33-51`, `:53-72`); the partitioned `combinedSnapshot.release` isolates a throwing partition per source (`partitioned-capture-store.ts:119-127`).
- **Capture-must-not-break-the-app** holds through the new store: `guard()` wraps `add`/`tick`/`clear`, tested with a throwing partition.
- **CI e2e job**: correct pnpm/node/bun/deno setup, explicit version echo so a missing runtime fails loudly rather than being silently skipped by `runtimes.ts`, `workerd: true` added to `allowBuilds` so the miniflare binary actually installs, `test:e2e` turbo task with `cache: false`. The design of the job is right; only the `bundle.test.ts` gap (SEV2 #4) is missing from it.
- **Working tree**: `git status --short` empty at the end of the review. Every mutation was applied with `cp`-backup + `perl -pi`, confirmed applied by `diff` before trusting the result, and restored from the backup; no `git checkout` was used and nothing was left behind.
