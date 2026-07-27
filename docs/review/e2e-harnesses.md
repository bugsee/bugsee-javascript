# Adversarial review — e2e / test-harness packages

**Reviewed:** 2026-07-27 · **Scope:** `@bugsee/instrumentation-tests`, `@bugsee/astro-e2e`, `@bugsee/nuxt-e2e`, `@bugsee/sveltekit-e2e`

**Did they run?** Yes — all four, on this machine, green:

| suite | command | result | wall time |
| --- | --- | --- | --- |
| `@bugsee/instrumentation-tests` | `pnpm --filter … test:e2e` | **6 files / 76 tests passed** | 235.1 s |
| `@bugsee/nuxt-e2e` | `pnpm --filter … test:e2e` | **2 files / 4 tests passed** | 9.9 s |
| `@bugsee/sveltekit-e2e` | `pnpm --filter … test:e2e` | **1 file / 2 tests passed** | 2.8 s |
| `@bugsee/astro-e2e` | `pnpm --filter … test:e2e` | **1 file / 2 tests passed** | 2.7 s |

`bun` (1.x, `~/.bun/bin/bun`) and `deno` (`/opt/homebrew/bin/deno`) were both present, so all three runtime targets of the instrumentation suite actually ran — no silent skips. No flakiness observed (single run each). No child processes were leaked (`ps` after the run: clean). `git status --short packages/` was empty before and after; all build outputs (`.nuxt/`, `.output/`, `build/`, `dist/`, `.astro/`) are gitignored. Nothing was modified.

**Verdict:** The engineering inside these harnesses is, in places, the best assurance work in the repository — `webview-conformance.e2e.ts` is a schema-validated conformance spec with a negative test, `instrumentation.e2e.ts` proves cross-process disk recovery and finds the blocking frame inside a real V8 CPU profile, and `replay.e2e.ts` unzips the bundle and proves masking against real rrweb. But the assurance they provide is **worth zero at the merge gate**: `.github/workflows/ci.yml` never invokes `pnpm test:e2e`, and `turbo run test:coverage --dry=json` reports `command: "<NONEXISTENT>"` for all four packages — so 84 passing e2e tests gate nothing. Beyond that, three structural choices explain most of the misses catalogued across the other 49 reviews: (a) the harness imports **platform packages directly** and never once imports the `@bugsee/bugsee` umbrella that customers install, so no `exports`-condition defect is reachable; (b) the **edge tier asserts only that a bundle arrived**, never unzipping it, and resets the isolate between every invocation, so the entire cross-tenant/isolate-reuse defect class is unreachable by construction; and (c) **no scenario anywhere issues two concurrent requests**, so per-request context bleed — the mechanism behind the Cloudflare cross-tenant leak — is untested on every runtime. One harness is worse than absent: `nuxt-e2e/test/edge-build.e2e.ts` passes *specifically because* it sets `NITRO_PRESET` explicitly, the one input that hides the zero-config defect real users hit.

---

## SEV1

### 1. No e2e suite runs in CI — the entire harness layer is outside the gate

- **Package(s):** all four
- **Where:** `.github/workflows/ci.yml:41,44,47,54` (the complete list of run steps); `turbo.json:4-20` (no `test:e2e` task exists); `package.json:18` (the root `test:e2e` script exists but is invoked by no workflow)
- **What:** CI runs exactly four commands — `pnpm lint`, `pnpm typecheck`, `pnpm check:cycles`, `pnpm exec turbo run test:coverage`. None of them reaches an `*.e2e.ts` file. The root `pnpm test` uses `vitest.config.ts:9` `include: ['packages/*/{src,test}/**/*.{test,spec}.ts']`, which does not match `*.e2e.ts`; and `turbo run test:coverage` cannot run these packages because none of them declares a `test:coverage` script.
- **Evidence (executed):**
  ```
  $ pnpm exec turbo run test:coverage --dry=json   # → task command per package
     @bugsee/astro-e2e            => "<NONEXISTENT>"
     @bugsee/instrumentation-tests=> "<NONEXISTENT>"
     @bugsee/nuxt-e2e             => "<NONEXISTENT>"
     @bugsee/sveltekit-e2e        => "<NONEXISTENT>"
  ```
  `ls .github/workflows/` → `ci.yml` only. `grep -rn "test:e2e" .github/` → no hits.
- **Why it matters:** 84 tests that take ~4.2 min in total and pass today contribute nothing to any merge decision. Everything else in this report is downstream of this: a harness that never runs cannot catch anything, and the ones that *would* have caught real defects (the nuxt edge-build guard, the webview schema conformance) are equally inert. This is the single highest-value fix in the review: adding a `test:e2e` turbo task and a CI job.
- **Fix:** add a `test:e2e` task to `turbo.json` (`"cache": false`), give each e2e package the script (they have it), and add a second CI job running `pnpm test:e2e` — accepting that `ubuntu-latest` has neither bun nor deno (see SEV3-18).

### 2. No harness ever imports `@bugsee/bugsee` — the documented install path is completely unexercised

- **Package(s):** instrumentation-tests (root cause for the bun/deno and umbrella-condition misses)
- **Where:** `packages/instrumentation-tests/app/entry-node.ts:2`, `app/entry-bun.ts:2`, `app/entry-deno.ts:2`; `packages/instrumentation-tests/package.json:12-23`
- **What:** each runtime entry imports the **platform package directly**:
  ```ts
  // entry-bun.ts:2
  import { launch } from '@bugsee/bun';
  ```
  and `@bugsee/bugsee` is not a dependency of any of the four harness packages. Verified monorepo-wide: `grep -rn "@bugsee/bugsee" packages/*/test packages/*/app packages/*/src` → **0 hits**. The 19 `package.json` files that depend on the umbrella are all product adapters, never a test harness.
- **Why it matters:** this is the direct, verifiable answer to the mandate's key question. `@bugsee/bugsee`'s SEV1-1 (no `bun`/`deno`/`workerd`/`edge-light`/`worker` exports conditions, so Bun and Deno silently receive the Node SDK) and its SEV1-2 (a mutation re-pointing the `node` condition at the browser entry survived every test and typecheck) are both **resolution** defects. They live entirely in the `exports` map that a consumer's resolver walks. By importing `@bugsee/bun` directly, the harness bypasses the umbrella's `exports` map entirely — so `@bugsee/bun` gets exercised beautifully while the path that would actually deliver it to a customer is never traversed. The harness proves the *package* works; it cannot prove the *product* resolves.
- **Fix:** add a fourth set of entries that import `@bugsee/bugsee` (and `@bugsee/bugsee/node`) instead of the platform packages, and assert `environment.platform.type` matches the runtime that booted it. A bun entry importing the umbrella would fail today.

### 3. The edge harness asserts that *a* bundle arrived, never what is in it

- **Package(s):** instrumentation-tests
- **Where:** `packages/instrumentation-tests/test/edge.e2e.ts:73`, `:81`, `:88`
- **What:** all three edge assertions are shaped:
  ```ts
  expect(collector.uploads.length).toBeGreaterThan(before); // a real bundle (zip) was PUT
  ```
  The companion check, `incidentIssue(message)` (`edge.e2e.ts:60-61`), does `JSON.stringify(issue).includes(message)` against the **`POST /v2/issues` metadata**, not the bundle. `edge.e2e.ts` contains no `unzipSync` and no reference to `logs.json`, `network.json`, `request.json` or `manifest.json` — the uploaded zip's bytes are counted and discarded.
- **Why it matters:** this is textbook test theater for the tier where it costs the most. `@bugsee/cloudflare` SEV1-2 is *"Durable Objects for different tenants share one capture buffer — an incident bundle ships other tenants' data."* The defect is **by definition a bundle-content defect**. A harness that never opens the bundle cannot detect it no matter how many tenants it simulates. Contrast `instrumentation.e2e.ts:52`, which does `unzipSync(u.body)` and asserts individual entries — the node/bun/deno tier gets real content assertions; the edge tier gets a byte count.
- **Fix:** reuse `parseBundles` from `instrumentation.e2e.ts:50-54` in `edge.e2e.ts` and assert `request.json` summary/mechanism plus the absence of any foreign tenant's marker string.

### 4. Every edge smoke runs in a fresh isolate with an isolated carrier and capture disabled — isolate-reuse defects are structurally unreachable

- **Package(s):** instrumentation-tests
- **Where:** `packages/instrumentation-tests/test/edge.e2e.ts:54-58`; `packages/instrumentation-tests/app/edge-scenario.ts:27`, `:84`
- **What:** three compounding choices each independently neutralize the cross-tenant class:
  1. `edge.e2e.ts:55-56` — `const vm = new EdgeVM(); vm.evaluate(bundleCode);` — **a brand-new isolate per invocation**, with the bundle re-evaluated from scratch. Real `workerd` reuses **one** isolate across many requests, many tenants, and many Durable Object instances; module-global state persists. The harness resets exactly the state whose persistence is the defect.
  2. `edge-scenario.ts:27` — `const baseOptions = (collector: string) => ({ endpoint: collector, captureLogs: false, captureNetwork: false, carrier: {} })` — a **fresh `carrier` object literal per launch**. The carrier is where the shared client/capture-ring lives; passing `{}` gives every runner private state, which is precisely the isolation the product does not have by default.
  3. `edge-scenario.ts:84` — `const instance = new Instrumented({ waitUntil: () => {} }, {});` — **exactly one** Durable Object instance is ever constructed. Cross-tenant leakage needs at least two.

  On top of that, `captureLogs: false, captureNetwork: false` means the capture ring is empty, so there is nothing available to leak even if the buffer were shared.
- **Why it matters:** even after fixing SEV1-3 (assert bundle contents), the scenario would still pass, because two tenants never coexist in one isolate with live capture. Root-causing this to "the harness uses `@edge-runtime/vm` instead of workerd" would be **wrong** — I verified the isolate is faithful (below). The defect is in the scenario's shape, not the runtime.
- **Verified (executed, `node --input-type=module` inside `packages/instrumentation-tests`):**
  ```
  EdgeVM globals: {"ALS":"undefined","process":"undefined","Buffer":"undefined","setImmediate":"undefined","crypto":"object"}
  ```
  `@edge-runtime/vm` genuinely lacks `AsyncLocalStorage`, `process` and `Buffer` — matching workerd. The environment is honest.
- **Fix:** one `EdgeVM` shared across a scenario that launches two tenants with distinct tokens, live capture, and the default carrier; assert tenant A's bundle contains no tenant B marker.

### 5. No harness anywhere issues concurrent requests — per-request context bleed is untested on every runtime

- **Package(s):** instrumentation-tests (and, by omission, all three framework e2e)
- **Where:** `packages/instrumentation-tests/app/scenario.ts:127-142` (the only incoming-server scenario)
- **What:** the server battery stands up a real `node:http` server and then issues **one** request:
  ```ts
  // scenario.ts:141
  const res = await fetch(`http://127.0.0.1:${port}/orders/42`);
  ```
  The assertion (`instrumentation.e2e.ts:199-219`) checks that the report and the handler log carry the *same* `context_id`. That proves a context was **opened**. It does not prove contexts are **isolated**, because isolation is only observable when two requests overlap. The three framework e2e are the same: one `fetch` to `/api/boom`, one to `/`.
- **Why it matters:** this is the shared root cause behind two separate Cloudflare SEV1s. SEV1-2 (cross-tenant capture buffer) and SEV1-3 (`globalThis.AsyncLocalStorage` does not exist on workerd under any flag, so per-request context isolation is permanently inert) both manifest **only under concurrency**. Because SEV1-3's environment is faithfully reproduced in EdgeVM (ALS is `undefined` there too — verified above), the harness was actually *running on the broken configuration* and still passed, purely because it never asked the isolation question.
- **Fix:** a scenario that fires N overlapping requests, each stamping a distinct marker, and asserts each report's `context_id` maps to its own marker only — on node, and again inside the edge isolate.

### 6. `nuxt-e2e`'s edge-build guard passes only because it takes a path real users do not take

- **Package(s):** nuxt-e2e
- **Where:** `packages/nuxt-e2e/test/edge-build.e2e.ts:22-27` (`env: { ...process.env, NITRO_PRESET: 'vercel_edge' }`)
- **What:** the harness builds with an **explicit** `NITRO_PRESET` env override, then asserts the edge SDK is bundled and the node path is not (`:37-38`, `:43-45`). That is the only configuration under which `@bugsee/nuxt`'s `isEdgePreset` check works, because `nuxt.options.nitro?.preset` is only populated when the user (or the CLI's `--preset`/`NITRO_PRESET` forwarding) sets it explicitly. Nitro's **auto-detection** — the zero-config path Nuxt's own deploy docs advertise — resolves the preset inside `createNitro()`, long after module setup.
- **Why it matters:** the `meta-frameworks-nuxt-remix-sveltekit-astro.md` review (SEV1 #2) proved by running the real build **on this very fixture** that the zero-config Cloudflare path ships the full Node composition (`import('node:fs')`, `import('node:worker_threads')`, `process.uptime()`) into the workerd bundle — and stated explicitly: *"The only reason the shipped `packages/nuxt-e2e/test/edge-build.e2e.ts` passes is that it sets `NITRO_PRESET`."* A harness that is green because it avoids the default path is worse than no harness: it is a signed statement that the edge split works.
- **Fix:** add a second case with the preset **unset** and `CF_PAGES=1` in the env, asserting the same node-free properties. It fails today.

---

## SEV2

### 7. The mock collector validates nothing — it is a byte sink, not a contract

- **Package(s):** all four (the file is duplicated verbatim)
- **Where:** `packages/instrumentation-tests/test/collector.ts:66-92` (and byte-identical copies at `packages/{nuxt,astro,sveltekit}-e2e/test/collector.ts`)
- **What:** the control plane is implemented just far enough to make the SDK's upload pipeline complete. `:66-71` JSON-parses the session body and pushes it; `:72-85` does the same for the issue and mints an upload URL; `:86-92` stores the PUT body **without inspecting a single byte**:
  ```ts
  const body = await readBody(req);
  uploads.push({ issueId: issueByUploadPath.get(url) ?? url, body });
  res.writeHead(200);
  ```
  There is no schema, no field check, no type check, no rejection path. Any payload — including a zero-byte body or a zip with no `request.json` — is accepted with 200.
- **Why it matters:** a permissive mock is how wire defects survive e2e. `@bugsee/protocol`'s review found three live wire defects (`logs.json` string levels, WebSocket/SSE frames using a `direction` field the viewer never reads, `environment.sdk.type` absent from the appserver's Mongoose schema). None is detectable against a collector that accepts anything. The galling part is that **this repo already knows how to do it right**: `packages/webview/bridge-protocol.schema.json` is a machine-checkable JSON Schema, compiled with ajv at `webview-conformance.e2e.ts:19` and enforced on every message at `:40-49`, with a negative test at `:238` proving the schema discriminates. That pattern was built for the native bridge and never applied to the backend bundle wire.
- **Fix:** declare the bundle wire in `@bugsee/protocol` as a JSON Schema (mirroring `bridge-protocol.schema.json`), and validate `request.json` / `manifest.json` / each capture file in the collector's PUT handler.

### 8. The harness *cements* the `logLevelToWire` defect rather than catching it

- **Package(s):** instrumentation-tests
- **Where:** `packages/instrumentation-tests/test/instrumentation.e2e.ts:39` and `:133`
- **What:** the harness types the wire field as a string and then asserts the string value:
  ```ts
  // :37-42
  interface LogEntry { message: string; level: string; … }
  // :133
  logs.some((l) => l.level === 'error' && l.message.includes('something noteworthy')),
  ```
- **Why it matters:** this is the mandate's question answered exactly. The `@bugsee/protocol` review (SEV1 #1) established that `logLevelToWire` (`packages/protocol/src/levels.ts:32`) has **zero callers**, so `logs.json` ships `"error"` where the viewer's numeric-keyed map (`viewer/src/app/core/constants/values/log-levels.constant.ts:2-8` = `{"1":"error",…}`) expects `1`. A bundle-content-asserting e2e *did* look at the field — and asserted the wrong value. That review names this file:line as its own smoking gun. Worse than a miss: correcting the product to emit numeric levels would now make this e2e **fail**, so the harness actively defends the defect.
- **Fix:** assert `l.level === 1` (numeric) per `docs/design/sdk-design.md` §8.4 and Android's `LogLevel.Error((byte)1)`, and let it fail until the product is fixed.

### 9. `manifest.json` is never asserted by any harness

- **Package(s):** all four
- **Where:** produced at `packages/core/src/bundle-assembler.ts:182,191` (`MANIFEST_JSON_FILENAME`); consumed by nothing in the harnesses
- **What:** `grep -rn "manifest" packages/instrumentation-tests packages/{nuxt,astro,sveltekit}-e2e/test` → **0 hits**. Every bundle carries a manifest describing its files, `attrs`, and time bounds; no test has ever read one.
- **Why it matters:** the manifest is the index the backend uses to interpret the bundle. `bundle-assembler.ts:151,165,173` was separately found to emit `ManifestFileEntry` literals that never set `name`. A harness whose stated purpose is "asserts the actual uploaded bundle" that never opens the bundle's table of contents has an obvious hole.

### 10. Entire capture families are never exercised end-to-end

- **Package(s):** all four
- **Where:** absence across `packages/instrumentation-tests/**`, `packages/{nuxt,astro,sveltekit}-e2e/test/**`; the network shape is declared at `instrumentation.e2e.ts:43-45`
- **What:** verified by grep across all four packages:
  - `WebSocket` / `EventSource` / `WebTransport` / `XMLHttpRequest` → **NONE**. Only `fetch` is ever driven.
  - redaction / filters / sensitive-header handling → **NONE** outside `replay.e2e.ts`'s DOM masking.
  - the network entry type is declared as `interface NetworkEntry { url?: string }` (`:43-45`) — the *only* field any harness ever reads from `network.json` is the URL (`:137`, `:377`).
- **Why it matters:** `@bugsee/protocol` SEV1 #2 is that every outbound WebSocket/WebTransport frame renders as "incoming" because the package models direction in a `direction` field the viewer never reads. No harness opens a socket, so the defect is unreachable. Likewise, the protocol review found `isSensitiveHeader`, `redactShapes`, `SENSITIVE_HEADERS` and `SENSITIVE_KEY_SUBSTRINGS` all have **zero callers** — an e2e that sent an `Authorization` header and asserted it was redacted in `network.json` would have caught that in one assertion. None exists.

### 11. Runtime-matrix holes: no real browser, no Electron, no Web/Service Worker, no workerd — and the docs claim otherwise

- **Package(s):** all four (by omission)
- **Where:** `docs/dev-environment.md:17`, `:62`, `:64`; absence of any Playwright/Electron/miniflare dependency
- **What:** the SDK claims browsers, Node, Bun, Deno, Electron, Cloudflare/workerd, Vercel Edge, Web/Service Workers and WebView. Verified:
  - **Playwright:** `node_modules/.bin/playwright` does not exist; no package.json references it. `docs/dev-environment.md:17` lists "Playwright browsers … Browser e2e (`npx playwright install`)" and `:62` lists "**Playwright** | Browser e2e" as shipped tooling. Neither exists. The only DOM coverage is jsdom (`replay.e2e.ts:1`, `webview-conformance.e2e.ts:1`), and `replay.e2e.ts:9-10` honestly documents this ("jsdom is a real DOM but NOT a real browser engine").
  - **workerd:** no `miniflare` / `wrangler` / `workerd` dependency anywhere; `packages/cloudflare/package.json` depends only on `@bugsee/vercel-edge`. The Cloudflare reviewer's finding — no test in this repo has ever run on workerd — is confirmed.
  - **Electron:** no package declares an `electron` devDependency; no e2e boots it.
  - **Web/Service Worker:** `find packages -name "*.e2e.ts"` returns 10 files, none of which constructs a `Worker` or registers a `ServiceWorker`. `@bugsee/webworker`'s SEV (no Service Worker detection at all, so SW silently runs memory-only) is a **runtime-identity** defect that only a booted SW could expose.
  - `docs/dev-environment.md:64` also claims "**Verdaccio** + ~10 fixture apps | Framework e2e" — there are three fixture apps and no Verdaccio.
- **Why it matters:** four claimed-supported runtimes have zero real-runtime coverage, and the developer documentation asserts tooling that does not exist, which is how a reviewer concludes coverage exists when it does not.

### 12. No `nextjs-e2e` and no `remix-e2e` — the pattern exists, works, and was never applied to the flagship

- **Package(s):** the three framework e2e (by asymmetry)
- **Where:** `ls -d packages/*-e2e` → `astro-e2e`, `nuxt-e2e`, `sveltekit-e2e` only. `next` is installed nowhere in the monorepo (`grep -rn '"next"' packages/*/package.json` → 0 hits; `node_modules/next` absent).
- **What:** `@bugsee/nextjs` and `@bugsee/remix` — one of them the flagship, and the template the other four adapters were modelled on — have no real-framework harness. Their sibling adapters each install and boot the real framework (`nuxt@^4.4.8`, `@sveltejs/kit@^2`, `astro@^5`).
- **Why it matters:** `@bugsee/nextjs` SEV1-1 is *"the Edge build cannot compile (42 resolution errors)."* `packages/nuxt-e2e/test/edge-build.e2e.ts` is **precisely** the harness shape that catches that class: run the real framework's edge build, then assert what landed in the bundle. It exists, it works, and it was never pointed at Next. Similarly `meta-frameworks…md` SEV2 #5 records that Remix has no real-framework validation at all, contradicting its own design doc. The gap is not conceptual — it is three missing packages that would be near-copies of the ones already here.

### 13. No scenario ever exits without an explicit `flush()` + `stop()` — the node process-pinning defect is invisible by construction

- **Package(s):** instrumentation-tests
- **Where:** `packages/instrumentation-tests/app/scenario.ts:75-76`, `:145-146`, `:184-185`, `:229-230`, `:272-273`, `:334-335`
- **What:** every non-fatal scenario terminates with `await client.flush(…); await client.stop(…)`. The fatal ones call `process.exit()` explicitly (`:171`, `:217`) or rely on the SDK's own `process.exit(1)` (`:98-103`). There is no scenario of the form "call `launch()`, do a little work, return from `main`, and assert the process exits on its own."
- **Why it matters:** `@bugsee/node`'s SEV is that a default `launch()` **permanently pins the host process**. That is only observable in the one shape the harness never uses. Every scenario hands the SDK an explicit teardown, which is exactly what a pinned process needs to exit — so `expect(exitCode).toBe(0)` (`instrumentation.e2e.ts:89`) passes while the defect sits untouched.
- **Fix:** a `pin` scenario: `launch(); console.log('x');` and nothing else, asserting the process exits within a few seconds.

### 14. `unhandledRejection`, `SIGTERM` and `SIGINT` appear in no harness

- **Package(s):** all four
- **Where:** verified absence across `packages/instrumentation-tests/**` and `packages/{nuxt,astro,sveltekit}-e2e/test/**` → `grep -rn "unhandledRejection\|SIGTERM\|SIGINT"` → **NONE**
- **What:** the product registers an `unhandledRejection` listener (`packages/node/src/detection-providers.ts:80,101`) and binds its flush to the `'exit'` event (`packages/node/src/launch.ts:774`). Neither path is ever driven by any harness. `runtimes.ts:95-115` spawns children and waits for natural exit; it never sends a signal.
- **Why it matters:** two `@bugsee/node` SEVs live exactly here — the `unhandledRejection` listener converting host crashes to `exit 0` (deleting its registration passed all 109 unit tests), and the `'exit'`-bound flush never firing on `SIGTERM` (the normal way a container stops a server). Both are cheap to test at this layer: fire a rejection and assert exit 1; `child.kill('SIGTERM')` and assert the bundle still arrived. Neither is attempted.

### 15. Spawned scenario processes are never timed out or killed

- **Package(s):** instrumentation-tests
- **Where:** `packages/instrumentation-tests/test/runtimes.ts:95-115`
- **What:** `runScenarioProcess` returns a promise that settles only via `child.on('error', reject)` or `child.on('exit', …)`. There is no timeout, no `child.kill()`, and no `afterAll` handle on the child. If a scenario process never exits, vitest's 60 s `hookTimeout` (`vitest.config.ts:14`) aborts the *hook* — and leaves the child process running indefinitely.
- **Why it matters:** the subject under test includes "does the process exit?" (SEV2-13). The one failure mode the harness is meant to surface is also the one that makes it leak. I did not observe a leak in my run (all children exited; `ps` was clean afterwards), so this is latent, not active.
- **Fix:** a `setTimeout` in `runScenarioProcess` that `child.kill('SIGKILL')`s and rejects with the captured stderr.

---

## SEV3

### 16. Fixed ports 3737 / 3738 / 3739 in the three framework e2e

- **Where:** `packages/nuxt-e2e/test/nuxt.e2e.ts:71`, `packages/sveltekit-e2e/test/sveltekit.e2e.ts:67`, `packages/astro-e2e/test/astro.e2e.ts:68`
- **What:** the app servers bind hardcoded ports while the mock collector correctly uses an ephemeral one (`collector.ts:108` — `server.listen(0, '127.0.0.1', …)`). If a stale or foreign process holds the port, the new server fails to bind, `probeUntilUp` succeeds against the *wrong* listener, and the suite fails later at the upload assertion with a confusing message. It fails **loudly**, not silently (the collector URL is per-run, so a stale server points at a dead collector) — hence SEV3 not SEV1 — but it makes the suites hostile to parallel CI jobs and to a developer with a dev server running.
- **Fix:** bind port 0 and read the assigned port from the server's stdout, as the collector already does.

### 17. The three framework e2e packages are excluded from `pnpm typecheck` as well

- **Where:** `packages/{astro,nuxt,sveltekit}-e2e/package.json` declare only `test:e2e`; only `packages/instrumentation-tests/package.json:9` declares `"typecheck": "tsc --noEmit"`
- **Evidence:** `turbo run typecheck --dry=json` → `@bugsee/instrumentation-tests => "tsc --noEmit"`, the other three → `"<NONEXISTENT>"`.
- **What:** their e2e sources are never typechecked. `pnpm lint` (biome, whole-repo) is the only CI gate that touches them at all — so a type error in `astro.e2e.ts` reaches `main` undetected.

### 18. bun/deno silently vanish when the binary is absent

- **Where:** `packages/instrumentation-tests/test/runtimes.ts:34-43` (`resolveBin` swallows the `execFileSync` failure), `test/instrumentation.e2e.ts:57-63` (writes a skip notice to `process.stderr`), `:67-69` (`describe.each` filters unavailable targets out)
- **What:** a runtime whose binary is missing produces zero suites and a stderr line; the run still exits 0. Locally this is a reasonable, documented trade-off (`README.md:30-31`), and it did not bite here — both binaries were present and all three targets ran. But `ubuntu-latest` ships neither, so wiring SEV1-1's fix naively would produce a green "cross-runtime instrumentation" job that only ever ran node.
- **Fix:** when adding the CI job, install bun and deno (both have first-party setup actions) and make absence a hard failure there via an env flag.

### 19. Fixture route surfaces are minimal — no null-body-status route, so the Astro 304 SEV1 was unreachable

- **Where:** `packages/astro-e2e/src/pages/` contains exactly `index.astro`, `api/boom.ts` (`:3-5`, throws), `api/health.ts` (`:3-5`, returns 200)
- **What:** `meta-frameworks…md` SEV1 #1 proved — on a fixture built from this very package — that `@bugsee/astro`'s `injectTraceIntoResponse` turns a `304`/`204`/`205` HTML response into a **500**, because `new Response(body, response)` throws `TypeError` for a null-body status. The e2e fixture has no route that returns one, so the defect never fires. The same shape applies to nuxt (one `boom` route) and sveltekit (one `boom` endpoint + one page).
- **Fix:** add routes covering the status classes an SDK response-rewrite must survive: 204, 205, 304, a streaming response, and a non-HTML content type.

### 20. `sourcemaps.e2e.ts` fakes the CLI binary, so the debug-ID wire format is never validated

- **Where:** `packages/instrumentation-tests/test/sourcemaps.e2e.ts:45-54`
- **What:** a small node script stands in for the Rust `bugsee-cli`, recording its argv and token. The plugin→spawn→argv chain is genuinely proven; what is **not** proven is that the real CLI accepts that argv or that the emitted `debugId` matches what the backend expects. `:92-102` separately asserts the runtime attach against a hand-planted `globalThis._bugseeDebugIds`.
- **Why it matters:** minor and honestly labelled in the file header, but it means the source-map chain's only end-to-end evidence stops at the process boundary.

### 21. `collector.ts` is duplicated byte-for-byte across all four packages

- **Where:** `packages/instrumentation-tests/test/collector.ts`, `packages/nuxt-e2e/test/collector.ts`, `packages/astro-e2e/test/collector.ts`, `packages/sveltekit-e2e/test/collector.ts`
- **Evidence:** identical `md5` (`09d6a3a4fff0c3a43233eda74d34a3af`), 129 lines each.
- **Why it matters:** hygiene alone would be SEV3-trivial, but it raises the cost of the SEV2-7 fix fourfold and makes drift between the four copies invisible. A shared private `@bugsee/e2e-collector` workspace package would fix both.

---

## Assurance-gap table (the key output)

| confirmed defect | in scope for a harness? | why it was NOT caught | fix to the harness | file:line |
| --- | --- | --- | --- | --- |
| **cloudflare cross-tenant DO capture-ring leak** | Yes — `edge.e2e.ts` boots a real Durable Object | Three independent blockers: (1) the assertion is `uploads.length > before` and **never unzips the bundle**, and a leak is by definition a bundle-content defect; (2) a **fresh `EdgeVM` per invocation** resets the module-global state whose persistence *is* the defect (workerd reuses one isolate); (3) only **one** DO instance with **one** tenant ever exists, and `carrier: {}` gives it private state while `captureLogs/captureNetwork: false` leave the ring empty | Shared isolate, two tenants with distinct tokens, default carrier, capture ON; unzip and assert tenant A's bundle contains no tenant B marker | `test/edge.e2e.ts:55,73,81,88`; `app/edge-scenario.ts:27,84` |
| **cloudflare ALS never exists on workerd → context isolation permanently inert** | Yes — and the harness **already runs on a faithful no-ALS isolate** (verified: `AsyncLocalStorage` is `undefined` in EdgeVM) | Not an environment problem. **No scenario anywhere issues two concurrent requests**, so isolation is never asked about. The node server scenario fires exactly one `fetch` and asserts only that a `context_id` exists | N overlapping requests, each with a distinct marker; assert each report's `context_id` maps to its own marker only — on node and inside the edge isolate | `app/scenario.ts:141`; `test/instrumentation.e2e.ts:199-219` |
| **cloudflare `instrumentRpcMethods` makes RPC uncallable** | No | The edge scenario exercises only `withBugseeFetch`, `withBugsee` and `instrumentDurableObject`. `instrumentRpcMethods` is never invoked by any harness | Add an RPC-surface smoke to `edge-scenario.ts` asserting a wrapped method is still callable | `app/edge-scenario.ts:7-8` (imports; no RPC) |
| **bun/deno bypassed on the documented install path (umbrella has no bun/deno conditions)** | Yes — this is the harness's flagship claim ("boots the real SDK in real bun/deno processes") | **The entries import the platform package directly, never the umbrella.** `import { launch } from '@bugsee/bun'` bypasses `@bugsee/bugsee`'s `exports` map entirely, and the umbrella is not a dependency of any harness package (`grep "@bugsee/bugsee" packages/*/{test,app,src}` → 0 hits monorepo-wide). The harness proves the *package* works; the defect is in *resolution* | Add umbrella entries (`import { launch } from '@bugsee/bugsee'`) per runtime and assert `platform.type` matches the booting runtime. The bun entry fails today | `app/entry-bun.ts:2`; `app/entry-deno.ts:2`; `app/entry-node.ts:2`; `package.json:12-23` |
| **umbrella `node`→browser condition mutation survived every test** | Yes — same root cause | Nothing in any harness resolves through an `exports` map, so no condition-map mutation is observable | Same as above: one umbrella-imported entry per condition (`node`, `browser`, `import`, `require`) | `package.json:12-23` (no umbrella dep) |
| **nextjs Edge build cannot compile (42 resolution errors)** | **Should be** — the exact harness shape exists and works for Nuxt | There is **no `nextjs-e2e` package** and `next` is installed nowhere in the monorepo. `nuxt-e2e/test/edge-build.e2e.ts` runs a real edge build and asserts what landed in the bundle — precisely this defect class — and was simply never pointed at Next | Create `packages/nextjs-e2e` modelled on `nuxt-e2e`: real `next build` for node + edge runtimes, assert the edge bundle resolves and is node-free | absence of `packages/nextjs-e2e`; `packages/nuxt-e2e/test/edge-build.e2e.ts:22-45` (the template) |
| **nuxt zero-config Cloudflare deploy ships the NODE SDK into workerd** | Yes — `nuxt-e2e/test/edge-build.e2e.ts` exists for exactly this | **The harness passes because it takes a path users do not take.** It sets `NITRO_PRESET: 'vercel_edge'` explicitly, which is the only input that populates `nuxt.options.nitro.preset` at module-setup time. Nitro's auto-detection resolves the preset inside `createNitro()`, after modules run — so the zero-config path never reaches the harness | Add a case with the preset **unset** and `CF_PAGES=1`; assert the same node-free properties. It fails today | `packages/nuxt-e2e/test/edge-build.e2e.ts:25` |
| **astro turns a 304/204/205 HTML response into a 500** | Yes — `astro-e2e` boots real Astro and drives real routes | The fixture has exactly three routes: `index.astro`, `api/boom.ts` (throws), `api/health.ts` (200). **No route returns a null-body status**, so `new Response(body, response)` is never given a 304 | Add routes returning 204/205/304, a streaming body, and a non-HTML content type | `packages/astro-e2e/src/pages/` (3 files); `api/health.ts:3-5` |
| **node: default `launch()` permanently pins the host process** | Yes — the harness asserts process exit codes on three runtimes | **Every scenario ends with an explicit `flush()` + `stop()`** (or an explicit `process.exit`). There is no "launch and return from main" scenario, which is the only shape in which pinning is observable | A `pin` scenario: `launch()`, log once, return; assert exit within a few seconds | `app/scenario.ts:75-76,145-146,272-273,334-335` |
| **node: `unhandledRejection` listener converts host crashes to exit 0** | Yes — trivially, at this layer | `unhandledRejection` appears **nowhere** in any of the four packages. Only `uncaughtException` is driven (`scenario.ts:98-100`) | A `rejection` scenario: `Promise.reject(new Error(…))` unhandled; assert a report **and** a non-zero exit | absence in `app/scenario.ts`; product at `packages/node/src/detection-providers.ts:80,101` |
| **node: flush bound to `'exit'` never fires on SIGTERM** | Yes — the runner owns the child process | `runScenarioProcess` never sends a signal; it only waits for natural exit. `SIGTERM`/`SIGINT` appear nowhere | After the app signals readiness, `child.kill('SIGTERM')`; assert the bundle still arrived | `test/runtimes.ts:95-115`; product at `packages/node/src/launch.ts:774` |
| **protocol: `logLevelToWire` never called → `logs.json` ships string levels** | Yes — the harness unzips `logs.json` and reads the `level` field | **It asserts the wrong value.** `interface LogEntry { level: string }` and `l.level === 'error'` bake the defect into the expectation. The protocol review names this file:line as its own smoking gun. Fixing the product would now break this test | Assert `l.level === 1` per `sdk-design.md` §8.4 / Android `LogLevel.Error((byte)1)`; let it fail until the product emits numerics | `test/instrumentation.e2e.ts:39,133` |
| **protocol: ws/sse/wt frames use a `direction` field the viewer never reads** | No | **No harness ever opens a WebSocket, EventSource, WebTransport or XHR** — only `fetch`. And `interface NetworkEntry { url?: string }` means the only field ever read from `network.json` is the URL | Drive each transport against the mock collector; assert the full entry shape against a protocol schema | absence across all four packages; `test/instrumentation.e2e.ts:43-45,137` |
| **protocol: redaction helpers have zero callers** | No | Redaction is asserted **nowhere** outside `replay.e2e.ts`'s DOM masking | Send an `Authorization` header and a password body field; assert both are redacted in `network.json` | absence across all four packages |
| **webworker: no Service Worker detection → SW silently runs memory-only** | No | **No harness constructs a `Worker` or registers a `ServiceWorker`.** `find packages -name "*.e2e.ts"` → 10 files, none worker-related. This is a runtime-identity defect that only a booted worker can expose | A worker harness (jsdom + `@vitest/web-worker`, or Playwright for SW) asserting `platform.type` and durable persistence | absence of any worker `*.e2e.ts` |
| **react: an SDK throw in `componentDidCatch` unmounts the customer's app** | No | **No frontend adapter has an e2e sibling at all.** Only jsdom-hosted `replay.e2e.ts` touches a DOM, and it drives `@bugsee/browser` directly, never a framework | A `react-e2e` (or Playwright) harness rendering a real tree, forcing an SDK throw inside the boundary, asserting the app stays mounted | absence of `packages/react-e2e` |
| **replay: masking holes proven only by driving real rrweb** | Partially — `replay.e2e.ts` **does** drive real rrweb and assert masking | Genuinely caught at this layer for the cases it covers (`:101-112`: `replay.bin` present, FullSnapshot type 2, secret absent, mask run present). The residual gap is jsdom vs a real engine, honestly documented in the file header | Playwright run against real Chromium/Firefox/WebKit (the documented follow-up) | `test/replay.e2e.ts:9-10,101-112` |

---

## Is it in the gate?

**No. Nothing in this report's scope runs in CI.**

`.github/workflows/ci.yml` is the only workflow (`ls .github/workflows/` → `ci.yml`). It triggers on push and pull_request (`:7-10`) and runs exactly four commands:

| step | line | reaches an `*.e2e.ts`? |
| --- | --- | --- |
| `pnpm lint` (biome) | `ci.yml:41` | **Yes, lint only** — biome scans the whole repo, so e2e sources are linted |
| `pnpm typecheck` (`turbo run typecheck`) | `ci.yml:44` | **Only `@bugsee/instrumentation-tests`** (`package.json:9`). The three framework e2e packages have no `typecheck` script → `<NONEXISTENT>` |
| `pnpm check:cycles` (madge) | `ci.yml:47` | No |
| `pnpm exec turbo run test:coverage` | `ci.yml:54` | **No** — all four e2e packages report `command: "<NONEXISTENT>"` |

The root `test:e2e` script exists (`package.json:18`) and correctly filters all four packages, but no workflow invokes it. `turbo.json:4-20` has no `test:e2e` task, so it cannot be reached through turbo either.

Consequence: 84 passing tests — including the schema-validated WebView conformance spec that is the reference contract handed to the Android team, the cross-process disk-recovery proof, and the edge bundle-size/node-free guard — gate nothing. A regression in any of them reaches `main` green.

Secondary consequence: the three framework e2e packages are outside `pnpm typecheck` too (SEV3-17), so `pnpm lint` is the only automated check that reads them at all.

---

## Assertion-strength analysis

The suites split cleanly into three tiers.

**Tier 1 — genuinely strong (contents asserted, defects would fail):**

- `instrumentation.e2e.ts` unzips every upload (`:50-54`) and asserts real substance: the exact `summary` and `type` of the error report (`:121-122`); `logs.json` message content (`:131`); `network.json` carrying the captured `/echo` (`:137`); a real V8 CPU profile with non-empty `nodes` and a numeric `startTime` (`:144-146`); and — the strongest assertion in the repository — that the **blocking frame `e2eHangSpin` appears in the AppHang bundle's profile** (`:172-173`), which is the empirical justification for not shipping a native stack-capture addon. It also proves cross-process disk recovery by asserting the seed delivered **nothing** and the recovered bundle carries a specific pre-crash breadcrumb (`:312`, `:324`), and proves a single trace id flows inbound → report → outbound while explicitly asserting the outbound span is **not** the inbound one (`:404-412`).
- `webview-conformance.e2e.ts` compiles the **shipped** `packages/webview/bridge-protocol.schema.json` with ajv (`:19`), validates every JS→native message (`:40-49`), and includes a negative test proving the schema actually discriminates (`:238`). This is the only place in the repo where a wire contract is machine-checked.
- `replay.e2e.ts` gunzips `replay.bin`, asserts a FullSnapshot event exists, asserts the secret is absent, and asserts a mask run is present — proving *recorded-then-masked*, not merely absent (`:101-112`).

**Tier 2 — shape-only (a defect could hide):**

- The framework e2e (`nuxt`, `sveltekit`, `astro`) do unzip, and do check `source.mechanism === 'http-error'` — but then fall back to `Object.values(files).map(strFromU8).join('\n')` and `toContain('e2e … boom')` (`nuxt.e2e.ts:128-130`, `sveltekit.e2e.ts:114-117`, `astro.e2e.ts:114-118`). "The string appears somewhere in some file" would pass even if the message landed in the wrong file, at the wrong nesting depth, or duplicated across five. The trace-meta check is `html.toContain('<meta name="traceparent"')` — presence, not a valid W3C traceparent value.

**Tier 3 — test theater:**

- The **entire edge tier**: `expect(collector.uploads.length).toBeGreaterThan(before)` at `edge.e2e.ts:73,81,88`, with no `unzipSync` anywhere in the file. The companion `incidentIssue()` (`:60-61`) does a `JSON.stringify(...).includes(...)` against the *issue metadata*, not the bundle. This is exactly "a bundle arrived" — for the runtimes where content correctness matters most.

**Never asserted anywhere, in any tier:** `manifest.json` (0 references); `environment.sdk.*`; log level as a numeric wire value (asserted as a *string*, cementing a live defect); any network entry field other than `url`; redaction; WebSocket/SSE/WebTransport/XHR entries; concurrent-request context isolation.

---

## Mock-collector fidelity

**Permissive. It validates nothing.**

`packages/instrumentation-tests/test/collector.ts` (129 lines, duplicated byte-identically into all three framework e2e packages — md5 `09d6a3a4fff0c3a43233eda74d34a3af`) implements the control plane just far enough for the SDK's upload pipeline to complete:

- `:66-71` — `POST /v2/sessions`: `JSON.parse` the body, push it, return `{ access_token: 'e2e-access-token' }`. No field is checked.
- `:72-85` — `POST /v2/issues`: `JSON.parse`, push, mint `{ endpoint, issueId, recordingId }`. No field is checked.
- `:86-92` — `PUT /upload/<n>`: `uploads.push({ issueId, body })` then `res.writeHead(200)`. **The bundle bytes are stored without inspection.** A zero-byte body, a zip missing `request.json`, or a bundle with a malformed manifest all get a 200.
- `:93-98` — `/echo`: increments a counter and records headers (this part is genuinely useful — it is how the traceparent-injection assertion works).

There is no JSON Schema, no reference to `@bugsee/protocol`'s `wire.ts`, no OTLP Profile v1 check, and no rejection path. A permissive mock is the mechanism by which every wire defect in the `@bugsee/protocol` review survived an e2e that claims to "assert the uploaded bundle."

The sharp irony: **this repo already built the right thing once.** `packages/webview/bridge-protocol.schema.json` is a machine-checkable JSON Schema, shipped inside the package so it cannot drift, compiled with ajv and enforced on every message — with a negative test proving it discriminates. That discipline was applied to the *native bridge* contract and never to the *backend bundle* contract, even though the backend contract is the one that determines whether a customer's data renders correctly in the viewer.

**On safety:** the collector binds `server.listen(0, '127.0.0.1')` (`:108`) — an ephemeral loopback port, never a real Bugsee host. All four harnesses point the SDK at `collector.url`. No real credentials, tokens or endpoints appear anywhere (`'e2e-app-token'`, `'e2e-token'`, `'https://api.e2e.test'`). Verified clean.

---

## Runtime coverage matrix

| runtime | really booted | simulated | untested | evidence |
| --- | --- | --- | --- | --- |
| **Node** | ✅ real `node` process via `tsx` | — | — | `runtimes.ts:51-56`; ran here, all scenarios |
| **Bun** | ✅ real `bun` process | — | — | `runtimes.ts:57-61`; `bun` present, ran here |
| **Deno** | ✅ real `deno` process | — | — | `runtimes.ts:62-67`; `deno` present, ran here |
| **Vercel Edge** | — | ⚠️ `@edge-runtime/vm` (a faithful WinterCG isolate — verified no ALS/process/Buffer) | — | `edge.e2e.ts:55`; assertions are bundle-arrival only |
| **Cloudflare / workerd** | — | ⚠️ same `@edge-runtime/vm` | **no workerd, ever** | no `miniflare`/`wrangler`/`workerd` dependency anywhere; `packages/cloudflare/package.json` deps = `@bugsee/vercel-edge` only |
| **Browser (real engine)** | — | ⚠️ jsdom only | **no real browser** | `replay.e2e.ts:1` (`@vitest-environment jsdom`); **no Playwright installed** despite `docs/dev-environment.md:17,62` claiming it |
| **WebView** | — | ✅ jsdom + a mock native receiver, **schema-validated** | native receiver side | `webview-conformance.e2e.ts:1,19,40-49` — strongest simulated coverage in the repo |
| **Web Worker** | — | — | **untested** | no `*.e2e.ts` constructs a `Worker` |
| **Service Worker** | — | — | **untested** | no `*.e2e.ts` registers a `ServiceWorker`; `@bugsee/webworker`'s SW-detection defect is a direct consequence |
| **Electron** | — | — | **untested** | no package declares an `electron` devDependency |
| **Nuxt (node)** | ✅ real `nuxi build` + booted `.output` server | — | — | `nuxt.e2e.ts:78,84` |
| **Nuxt (edge)** | ✅ real `vercel_edge` build, bundle inspected | — | zero-config preset path | `edge-build.e2e.ts:22-45` — but see SEV1-6 |
| **SvelteKit** | ✅ real `vite build` + booted `adapter-node` server | — | — | `sveltekit.e2e.ts:73,76` |
| **Astro** | ✅ real `astro build` + booted `@astrojs/node` standalone | — | — | `astro.e2e.ts:75,83` |
| **Next.js** | — | — | **untested; `next` installed nowhere** | no `packages/nextjs-e2e`; `grep '"next"' packages/*/package.json` → 0 |
| **Remix** | — | — | **untested** | no `packages/remix-e2e` |

**Claimed-supported runtimes with zero real-runtime coverage: Cloudflare/workerd, real browsers, Web Workers, Service Workers, Electron, Next.js, Remix.**

---

## Green-when-broken risks

Assessed each candidate honestly; most of this repo's harness code fails loudly, which is to its credit.

**Real (would report green while testing less or nothing):**

1. **The whole suite, in CI.** Not green-when-broken so much as *absent-while-assumed-present*: `pnpm test:e2e` never runs, so the harness reports nothing at all while `docs/dev-environment.md:151` and every package description present it as the cross-runtime assurance layer. (SEV1-1)
2. **`nuxt-e2e/test/edge-build.e2e.ts` is green precisely because it avoids the defect.** Setting `NITRO_PRESET` explicitly is what makes the assertion pass; the default path it is meant to protect ships the Node SDK into workerd. This is the purest green-when-broken case in the scope. (SEV1-6)
3. **The edge tier passes with an empty/garbage bundle.** `expect(uploads.length).toBeGreaterThan(before)` (`edge.e2e.ts:73,81,88`) succeeds for any non-zero PUT — the collector accepts any body with a 200 (`collector.ts:86-92`). Content could be entirely wrong and the suite stays green. (SEV1-3 + SEV2-7)
4. **`instrumentation.e2e.ts:133` is green *because* the product is broken.** It asserts `l.level === 'error'`, the string form the viewer cannot read. This test will turn red the day the defect is fixed. (SEV2-8)
5. **bun/deno silently vanish when absent** (`runtimes.ts:34-43`, `instrumentation.e2e.ts:57-63`): a skip notice on stderr, zero suites, exit 0. Harmless today (both were installed here); a trap the moment this is wired into a CI image lacking them. (SEV3-18)

**Checked and NOT a green-when-broken risk:**

- No `try/catch` wraps any assertion in any of the four packages. `assertAllConform()` **throws** on a schema violation (`webview-conformance.e2e.ts:43-47`); build failures **throw** in `beforeAll` (`nuxt.e2e.ts:79-81`, `sveltekit.e2e.ts:74`, `astro.e2e.ts:80-81`); a missing edge entry throws (`edge-build.e2e.ts:28`).
- The framework e2e use **readiness polling**, not sleeps (`probeUntilUp` with a 60 s deadline in all three) — no timing-race green.
- `resolveBin`'s `catch` (`runtimes.ts:38-40`) swallows only the *probe*, and the unavailability is surfaced on stderr and in the filter; it does not swallow a test failure.
- The fixed-port hazard (SEV3-16) fails **loudly** rather than silently: the collector URL is minted per run, so a stale server points at a dead collector and the upload assertion fails.
- `expect(exitCode, stderr).toBe(0)` passes stderr as the failure message throughout — good practice; failures are debuggable.

---

## Checked and found clean

- **No real Bugsee infrastructure is contacted, ever.** Every harness points the SDK at the loopback mock (`collector.ts:108` — `server.listen(0, '127.0.0.1')`). Tokens are literals (`'e2e-app-token'`, `'e2e-token'`, `'vercel-edge-vm-token'`, `'cloudflare-vm-token'`, `'durable-object-vm-token'`); the only external-looking URL is `'https://api.e2e.test'` in the source-map argv assertion, which is never dialled. No credential, no `.env`, no network egress.
- **All build artifacts are gitignored and `git status` stayed clean.** `packages/astro-e2e/.gitignore` (`.astro/`, `dist/`), `packages/nuxt-e2e/.gitignore` (`.nuxt/`, `.output/`, `.data/`), `packages/sveltekit-e2e/.gitignore` (`.svelte-kit/`, `build/`); root `.gitignore` covers `node_modules/`, `dist/`, `coverage/`, `.turbo/`. `git check-ignore -v packages/sveltekit-e2e/build/index.js` confirms. `git status --short packages/` was empty before my run and empty after.
- **No leaked child processes.** After the full instrumentation run (which spawns node, bun and deno children across seven scenarios each) and the three framework suites, `ps` showed no `entry-node`/`entry-bun`/`entry-deno` and no orphaned app servers. `afterAll` teardown (`server?.kill('SIGKILL')`, `await collector?.close()`) works, and `collector.close()` correctly calls `server.closeAllConnections?.()` first (`collector.ts:125`) so keepalive sockets do not stall the hook.
- **`vitest.config.ts` isolation is correct and deliberate.** `include: ['test/**/*.e2e.ts']` plus `fileParallelism: false` in all four packages, with a documented reason in each (`instrumentation-tests/vitest.config.ts:6-8`: sequential spawning so runtimes never contend for CPU and skew the hang watchdog; `nuxt-e2e/vitest.config.ts:11`: both files build in the same app dir). The exclusion from `pnpm test` is intentional and correctly implemented (root `vitest.config.ts:9` globs `*.{test,spec}.ts`).
- **`webview-conformance.e2e.ts` is exemplary** and should be the model for the backend wire: it imports the schema **from the shipped package** so the artifact handed to the Android team and the artifact under test cannot drift (`:14-16`), validates every message, and proves the schema discriminates with an explicit negative test (`:238`).
- **The node/bun/deno assertions are substantive**, not shape-only — see the Tier-1 list above. In particular the AppHang→CPU-profile→blocking-frame chain (`:157-173`) and the two-phase cross-process recovery scenarios (`:221-326`) are exactly the kind of thing unit tests cannot reach, and they are asserted properly.
- **`@edge-runtime/vm` is a faithful stand-in for the isolate's global surface** — I verified `AsyncLocalStorage`, `process`, `Buffer` and `setImmediate` are all `undefined` there, matching workerd, with `crypto` present. The edge harness's weakness is its assertions and scenario shape (SEV1-3, SEV1-4), **not** a dishonest runtime. Worth recording so the fix is aimed correctly.
- **The three framework e2e genuinely boot their real frameworks** — not mocks, not module-level fakes. I watched the real Astro router raise the fixture's throw through Astro's own middleware chain in the run log, and the real Nitro `error` hook fire for Nuxt. Each installs its real framework as a devDependency (`nuxt@^4.4.8`, `@sveltejs/kit@^2`, `astro@^5` + `@astrojs/node@^9`), runs the real production build, and boots the built server as a separate `node` process. The claim in their package descriptions is accurate.
