# Adversarial review — @bugsee/util

**Reviewed:** 2026-07-26 · **Scope:** packages/util (impl 348 LOC across 11 src files + 1 `.d.ts`, tests 675 LOC across 11 test files)
**Verdict:** The implementation is **correct**. I found no logic defect in any algorithm: `utf8ByteLength` matches `TextEncoder` at every boundary I probed (including the three the tests miss), `sha256Hex` matches FIPS vectors on both the WebCrypto and `node:crypto` paths, `deepMerge`'s `__proto__` guard genuinely works at all depths, `computeBackoff` clamps correctly, and the package is fully runtime-portable (no static `node:*`/DOM imports; every global reached via a guarded `globalThis` cast). The suite is green (106 tests) at 100% statements/branches/functions/lines. The real problems are elsewhere: **~40% of the public API — 15 exported symbols including the entire `env` runtime-detection module, `deepMerge`, and both base64 functions — has zero consumers anywhere in the repo**, while a downstream package re-implements one of those predicates inline; and **100% coverage is masking at least four surviving mutations**, i.e. the mutator-loop discipline (standards §2) was not completed on `backoff`, `utf8-byte-length`, `random-id`, and the `index` barrel. No SEV1.

---

## SEV1

None.

---

## SEV2

### 1. ~40% of the public API is dead code — including the entire `env` module — and a consumer re-implements one of its predicates inline

- **Where:** `packages/util/src/env.ts:18-41` (all 10 predicates), `packages/util/src/deep-merge.ts:21`, `packages/util/src/base64.ts:10` and `:19`, `packages/util/src/deferred.ts:14` (`settled`), `packages/util/src/index.ts:5-28` (the barrel that exports them). Duplication site: `packages/vercel-edge/src/wait-until.ts:29`.
- **What:** A repo-wide search (all of `.`, every extension, excluding `node_modules`/`dist`/`coverage`/`.turbo`) for each exported symbol found **zero references outside `packages/util/` itself** for:
  `isBun`, `isDeno`, `isNode`, `isBrowser`, `isWebWorker`, `isServiceWorker`, `isCloudflareWorker`, `isVercelEdge`, `isElectronRenderer`, `isElectronMain`, `deepMerge`, `PlainObject`, `toBase64`, `fromBase64`, `BackoffOptions` — 15 of the 24 runtime + 3 type exports. Additionally `Deferred.settled` (`deferred.ts:14`) has no production reader: the only `.settled` reads in the repo are `packages/core/src/client.test.ts:1267,1282,1294,1333`, which use a **test-local `tracked()` helper**, not this type.
  Worse, `packages/vercel-edge/src/wait-until.ts:29` open-codes the exact predicate:
  ```ts
  if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime === 'string') {
  ```
  instead of importing `isVercelEdge()` — so the abstraction has already drifted out of use where it was designed to be used (`docs/design/edge-runtime.md:165` explicitly lists `isVercelEdge`/`isCloudflareWorker` (util) as the intended seam).
- **Why it matters:** `packages/util/package.json` sets `"private": true`, so there are no external consumers either — this is genuinely unreachable code. It is not free: `env.ts` (41 LOC) carries the package's largest test file (`env.test.ts`, 148 LOC) that must be kept at the binding 100%-coverage gate forever, and the JSDoc actively asserts live usage that is false — `deep-merge.ts:14` says "Used for scope/attribute/context merging (design §7.2)" and `deferred.ts:5-6` says `settled` is "Used for … the upload pipeline". Both claims are contradicted by the code. Either wire these in (the vercel-edge duplication is the obvious first fix) or delete them; carrying them as tested-but-unused API misleads every future reviewer about what the tier-0 contract actually is.
- **Evidence:** `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.md' -w <symbol> . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage --exclude-dir=.turbo` run per symbol; every hit for the 15 symbols resolved to `packages/util/src/*` or to prose in `docs/design/sdk-design.md:370` / `docs/design/edge-runtime.md:125,165`. `grep -n '"private"' packages/util/package.json` → `"private": true`. `sed -n '1255,1300p' packages/core/src/client.test.ts` confirms `f`/`s` are `tracked(...)` locals.

### 2. `jsonSafeStringify` reports non-circular repeated references as `"[Circular]"`, silently losing data in live console capture

- **Where:** `packages/util/src/json-safe-stringify.ts:10` (`const seen = new WeakSet<object>()`) and `:18-21`. Live consumer: `packages/capture/src/console-interceptor.ts:41`.
- **What:** The visited-set is global to the whole `JSON.stringify` walk and never unwound on the way out of a subtree, so any object reached a **second** time — even from a disjoint sibling branch — is replaced with the string `"[Circular]"`. Verified:
  - `jsonSafeStringify({a: shared, b: {c: shared}})` → `{"a":{"v":1},"b":{"c":"[Circular]"}}`
  A true ancestor-only check would emit `{"a":{"v":1},"b":{"c":{"v":1}}}`.
  Scope note (this narrows, but does not remove, the impact): `console-interceptor.ts:41` calls it **per argument** via `stringifyArg`, each with a fresh `WeakSet`, so `console.log(user, user)` is safe — the loss is confined to repeated references *within a single logged object*.
- **Why it matters:** This is a debugging SDK; captured console output is the product. A developer logging a normal graph-shaped object (`{request, meta: {request}}`, React props re-referencing a slice of state, a config object referenced from two sections) gets a payload where a whole subtree is gone, labelled with a diagnosis — "[Circular]" — that is **factually wrong** and will send them hunting for a cycle that does not exist. The limitation is documented (`json-safe-stringify.ts:6-7`) and deliberately pinned by a test (`json-safe-stringify.test.ts:43`), so this is a known trade-off rather than an oversight — but the cost is real and the standard fix is not expensive: the replacer's `this` is the holder object, so an ancestor **stack** (pop while `this !== top`) gives true cycle detection with the same allocation profile the JSDoc is protecting.
- **Evidence:** Faithful re-implementation executed in `scratchpad/probe.mjs` (byte-identical logic to lines 9-28); output above. `grep -rn -w jsonSafeStringify packages` shows `packages/capture/src/console-interceptor.ts:3,41` is the only consumer; `sed -n '30,48p'` of that file confirms the per-argument call.

### 3. `deepMerge` recurses without a cycle guard — a self-referential input overflows the stack

- **Where:** `packages/util/src/deep-merge.ts:29-31`.
- **What:** The function recurses whenever `isPlainObject(sourceValue) && isPlainObject(targetValue)`, with no visited-set. A cyclic object graph present on **both** sides recurses forever:
  ```
  deepMerge(c, c)  where  c.self = c        →  RangeError: Maximum call stack size exceeded
  ```
  The realistic path is a two-step one, because step 1 stores the cycle by reference:
  ```
  acc = deepMerge({},  {ctx: cyc});   // ctx absent in target → acc.ctx === cyc  (stored by reference)
  acc = deepMerge(acc, {ctx: cyc});   // now BOTH sides plain → recurses into the cycle → RangeError
  ```
  i.e. merging the *same* cyclic attribute object twice — exactly what a repeated `setAttribute`/context-merge call would do.
- **Why it matters:** `deep-merge.ts:14-19` positions this as the hardened merge for "untrusted data — e.g. a `JSON.parse`'d attribute/context payload". `JSON.parse` output cannot be cyclic, so the stated threat model *is* covered — but the function's signature accepts any `PlainObject`, and a live user-supplied object graph throws a `RangeError` out of the SDK into the host application. That violates the repo's binding "interceptors/utilities must not alter host application behaviour" rule. **Currently latent** — `deepMerge` has no consumers (finding SEV2-1) — so this is a landmine for whoever wires it in, not a live bug. No test covers cyclic input.
- **Evidence:** `scratchpad/probe.mjs` (re-implementation identical to lines 1-36) — both the direct `deepMerge(c,c)` and the two-step realistic case threw `RangeError: Maximum call stack size exceeded`; the intermediate assertion `acc.ctx === cyc` printed `true`, confirming the by-reference store that sets up the second call.

---

## SEV3

### 4. Four surviving mutations — 100% coverage, but the mutator loop (standards §2) did not converge

All four were verified **empirically** by mutating the real source, running `pnpm --filter @bugsee/util exec vitest run <testfile>`, and restoring from a scratchpad backup. Five control mutations (`utf8 code<0x80 → <=0x80`, `deepMerge __proto__ guard neutered`, `deepMerge {...target} → target`, `deferred settled not set`, `sha256 padStart(2)→padStart(1)`) were all **KILLED**, confirming the harness detects kills.

**4a. `computeBackoff` — the `Math.min` cap is entirely unverified.**
- **Where:** `packages/util/src/backoff.ts:33`.
- **What:** Replacing `const capped = Math.min(exponential, maxDelayMs);` with `const capped = exponential;` → **all 12 tests still pass.** The hard-ceiling clamp on line 37 masks it for every tested input.
- **Why it matters:** The `Math.min` is *not* redundant — it is what preserves jitter **at** the ceiling, which is the entire anti-thundering-herd purpose of the cap (design §14.8). With the cap present, `computeBackoff(10, {initialDelayMs:1000, factor:10, maxDelayMs:5000, random:()=>0})` = **4500**; without it, every client at the ceiling retries at exactly **5000** in lockstep. The two cap tests (`backoff.test.ts:28` and `:65`) use `random: () => 0.5` and `random: () => 1`, the only two values for which both variants agree. A test at the cap with `random: () => 0` (expect 4500) closes this.

**4b/4c. `utf8ByteLength` — both surrogate-range upper boundaries are untested.**
- **Where:** `packages/util/src/utf8-byte-length.ts:17` and `:21`.
- **What:** `code <= 0xdbff` → `code < 0xdbff` **survives** (9/9 pass), and `next <= 0xdfff` → `next < 0xdfff` **survives** (9/9 pass).
- **Why it matters:** The implementation is **correct** — I confirmed `utf8ByteLength` == `TextEncoder().encode().length` == 4 for `􏿿` (U+10FFFF), `𐏿`, and `􏰀`. But no sample in the suite (`utf8-byte-length.test.ts:35-41` and the oracle list at `:69-79`) uses a high surrogate of `0xDBFF` or a low surrogate of `0xDFFF`, so the top of the astral plane (U+10FC00–U+10FFFF, and every pair ending in `\uDFFF`) is unguarded. This function bounds `maxDataSize` in three chunk backends (`packages/core/src/file-chunk-backend.ts`, `memory-chunk-backend.ts`, `packages/browser-utils/src/idb-chunk-backend.ts`) and `packages/protocol/src/sanitize.ts`, so an off-by-one here becomes a systematic size-accounting error. Adding `􏿿` and `𐏿` to the oracle array at `:69` kills both.

**4d. `index.test.ts` misses `randomId` while claiming to guard the barrel.**
- **Where:** `packages/util/src/index.test.ts:8-33` (the `expected` array) vs `packages/util/src/index.ts:26`.
- **What:** Deleting `export { randomId } from './random-id';` from the barrel → **the test passes.** The file's own comment at `:4-5` says "If a re-export is dropped or renamed, this fails" — that is false for `randomId`.
- **Why it matters:** `randomId` is the single most-used util export (19 production call sites: `packages/core/src/bugsee-api.ts`, `packages/node/src/server-instrument.ts`, `packages/webview/src/launch.ts`, `packages/vercel-edge/src/edge-context.ts`, `packages/browser-utils/src/instance-coexistence.ts`, and the hono/hapi/elysia adapters). Two secondary weaknesses in the same test: it only asserts presence, never that no *extra* symbol leaked; and the three type exports (`BackoffOptions`, `PlainObject`, `Deferred`) are unguarded by construction — a `--typecheck` type test would cover them.

### 5. `randomId`'s fallback entropy is unasserted — a 96-bit id passes the same tests as a 128-bit one

- **Where:** `packages/util/src/random-id.ts:14` and `packages/util/src/random-id.test.ts:10-34`.
- **What:** Mutating `Math.random() * 0x1_0000_0000` to `Math.random() * 0x1_0000_00` (24 bits/chunk instead of 32) **survives** — because `padStart(8, '0')` restores the length and every assertion is either `/^[0-9a-f]{32}$/` or the all-zeros padding case. Verified output: `001e2a69004ece000048e68600a4d48f` matches the regex.
- **Why it matters:** The fallback is the Node-18 path for correlation/context ids used across `server-instrument.ts`, `edge-context.ts` and `instance-coexistence.ts`; silently dropping from 128 to 96 bits (or to a broken `Math.random().toString(16).slice(...)` "simplification") raises collision probability with no test failing. A distribution assertion — e.g. stub `Math.random` to return a value near 1 and assert the chunk's high nibble is non-zero — closes it. (No test asserts the crypto path either: `randomUUID` could be replaced by any 32-hex generator and `randomId` would still pass.)

### 6. `Deferred.settled` can be `true` for a promise that will never settle

- **Where:** `packages/util/src/deferred.ts:30` and `:34` (`settled = true` executes *before* `resolveFn(value)`), documented at `:8`.
- **What:** `resolve()` accepts `T | PromiseLike<T>` (`:12`). Passing a pending thenable flips `settled` immediately while the promise adopts. Verified: `d.resolve(new Promise(r => setTimeout(r, 50)))` → `d.settled === true` with the promise still pending; `d.resolve(new Promise(() => {}))` → `settled === true` forever on a promise that never settles.
- **Why it matters:** The JSDoc at `:8` states "`settled` simply reflects whether a settlement has occurred" — for the thenable overload that is wrong; it reflects "resolve/reject was *called*". Any future consumer treating `settled` as "safe to stop waiting" gets a wrong answer. Impact today is nil because the flag has no readers (finding SEV2-1). Either narrow the doc or set the flag from a `.then`/`.finally` on the adopted value. `deferred.test.ts:11` exercises the thenable path but only asserts the eventual value, never `settled` during adoption.

### 7. `deepMerge` JSDoc under-describes its aliasing and silently drops symbol keys

- **Where:** `packages/util/src/deep-merge.ts:18-19` (JSDoc) and `:22-23` (implementation).
- **What:** Two verified gaps between doc and behaviour:
  1. The doc warns only that source-side non-plain values are shared ("mutating them on the result also mutates them on `source`"). **Target-side plain objects are aliased too**: `deepMerge({n:{deep:{v:1}}}, {other:1})` returns a result where `res.n === target.n` — mutating `res.n.deep` mutates the caller's `target`. Given the repo's binding "must not alter host application behaviour" rule, that asymmetry deserves an explicit line.
  2. `Object.keys(source)` at `:23` enumerates string keys only, so **symbol-keyed properties on `source` are silently dropped** (`deepMerge({a:1}, {[Symbol('s')]:2, b:3})` → symbol absent). Meanwhile `{ ...target }` at `:22` *does* copy target-side symbols — an inconsistency neither documented nor tested.
- **Why it matters:** Both are latent (no consumers), but a merge helper that quietly drops a class of keys and shares mutable state with the caller's input is exactly the kind of thing a future integration will get wrong. (Checked and clean: `constructor` is *not* a pollution vector — assignment creates an own property; `Object.prototype` was verified untouched.)

### 8. `backoff` turns NaN inputs into a zero delay (hot retry loop) with no test

- **Where:** `packages/util/src/backoff.ts:33-39`.
- **What:** `NaN` propagates through `Math.min` / the comparison chain and is caught by the final `bounded > 0 ? bounded : 0`, yielding **0**. Verified: `computeBackoff(3, {maxDelayMs: NaN, random: () => 0.5})` → `0`; `computeBackoff(0, {random: () => NaN})` → `0`.
- **Why it matters:** A `0 ms` backoff means the upload pipeline (`packages/core/src/upload-pipeline.ts:58`) retries with no delay at all — the opposite of the intended failure mode. Requires a malformed injected option, so bounded, but "NaN → 0 delay" is the worst possible clamp direction; `maxDelayMs` would be the safer floor. Untested. (Cleanly handled and verified: `attempt` = `Infinity`, `1e308`, `NaN`, `-0`, and negative all produce sane values.)

### 9. `base64` binds `btoa`/`atob` at module-evaluation time

- **Where:** `packages/util/src/base64.ts:4-7`.
- **What:** `const { btoa, atob } = globalThis as unknown as {...}` snapshots both functions when `base64.ts` is first evaluated — which, via the barrel at `index.ts:7`, is on *any* import of `@bugsee/util`. A polyfill installed after SDK import is never picked up, and the module cannot be exercised with `vi.stubGlobal` (contrast `env.ts:16`, which correctly retains the `globalThis` *object* and resolves properties per call).
- **Why it matters:** Low today — every declared target runtime (browser, Node ≥16, Bun, Deno, Cloudflare/Vercel edge, Web/Service Workers) ships both as `WindowOrWorkerGlobalScope` members, and the destructure itself cannot throw. But for a tier-0 package whose stated design rule is guarded per-call global access, this is the one module that deviates, and it is untestable as a result.

### 10. Coverage thresholds are merged across the package, not per-file

- **Where:** `packages/util/vitest.config.ts:13-18`.
- **What:** `thresholds` is set without `perFile: true`, so the 100%/90% gate is applied to the **package total**, not to each file. The `text` reporter's per-file table also renders with zero rows (only the summary block prints), so a weak file is invisible in CI output as well.
- **Why it matters:** `docs/implementation-standards.md` §4 frames the gate as covering "every file, every method". Today the package is at a genuine 100% (108/108 stmts, 59/59 branches, 26/26 fns, 98/98 lines), so nothing is hidden — but the config does not actually enforce what the standard describes, and this config is "the pattern every package follows" per its own comment at `:3`.

### 11. `README.md` says the package is a stub

- **Where:** `packages/util/README.md:5` — "**Status:** stub."
- **What:** The package is fully implemented, reviewed and consumed by `@bugsee/core`, `@bugsee/protocol`, `@bugsee/service`, `@bugsee/capture` and every platform package (106 tests, 100% coverage). The README is stale from scaffolding.

---

## Checked and found clean

Actively verified — do not redo:

- **`utf8ByteLength` correctness.** Differential-tested against the platform `TextEncoder` at every boundary including the three the suite misses (`􏿿` = U+10FFFF, `𐏿`, `􏰀`) — all agree. Mutations `code < 0x80 → <=`, `code >= 0xd800 → >`, `next >= 0xdc00 → >` were all **KILLED**. The impl is right; only the tests are thin (finding 4b/4c).
- **`sha256Hex`.** FIPS 180-2 vectors for `'abc'` and `''` pass on **both** paths (global WebCrypto and the `node:crypto` fallback, forced via `vi.stubGlobal('crypto', undefined)` and `{}`). `padStart(2,'0') → padStart(1,'0')` **KILLED**. String and `Uint8Array` inputs produce identical digests.
- **The `node:crypto` ambient augmentation is safe.** `packages/util/src/web-globals.d.ts:6-10` declares a narrowed `createHash`. I compiled a standalone consumer that `/// <reference>`s it *and* uses `@types/node`: `createHash('sha256').update('a plain string').digest('hex')` and `randomUUID()` both typecheck with exit 0 — declaration merging works as the comment claims. It also does **not** leak into the published types (`grep node:crypto packages/util/dist/index.d.ts` → absent). `pnpm --filter @bugsee/nestjs exec tsc --noEmit` (a package that imports `randomUUID` from `node:crypto`) is clean.
- **`deepMerge` prototype-pollution hardening.** The `__proto__` guard is load-bearing at top level *and* nested — neutering it to `'__protoXX__'` was **KILLED** by `deep-merge.test.ts:50` and `:59`. Separately confirmed `constructor` is not a vector: `deepMerge({}, JSON.parse('{"constructor":{"prototype":{"pwn":1}}}'))` creates an own property and leaves `Object.prototype` untouched.
- **`deepMerge` does not mutate its inputs.** `{ ...target } → target` was **KILLED**. (The nested-aliasing nuance is finding 7, not a mutation.)
- **Runtime portability — no violations.** No static `node:*` or DOM imports anywhere in `src/`. The single dynamic `import('node:crypto')` (`sha256.ts:24`) sits behind a `webcrypto?.subtle` guard and is unreachable on edge/browser. Every global is reached via `globalThis as unknown as {...}` with `typeof`/optional-chaining guards (`env.ts:16-41`, `random-id.ts:8`, `sha256.ts:20,32`, `base64.ts:4`). No `window`/`document`/`process` free references.
- **`base64` round-trip.** Empty input, all three padding widths, bytes `0`/`128`/`254`/`255`, and a 100 000-byte buffer all round-trip; a standalone encoder oracle (`//6A`) pins high bytes independently of the decoder. `new Uint8Array(binary.length) → length + 1` **KILLED**.
- **`env` predicate logic.** Mutations `isNode` drop-`!isDeno()` and `isElectronMain` drop-`type === 'browser'` were both **KILLED**. `isVercelEdge` correctly requires a *string* (`EdgeRuntime = 1` → false, `env.test.ts:112`). `isWebWorker`'s service-worker exclusion is pinned by `env.test.ts:77`. `isNode`'s Bun/Deno exclusion is correct. (The design gap that `isElectronRenderer` checks only `process.type` and not `versions.electron` is real but moot — zero consumers, finding SEV2-1.)
- **`jsonSafeStringify`'s `val !== null` guard is load-bearing.** Removing it was **KILLED** — `WeakSet.add(null)` throws `TypeError`, which would defeat the function's whole non-throwing contract. Also confirmed: BigInt at top level and nested, `toJSON` (Date) interaction, `space` pass-through, and `result ?? 'null'` for top-level `undefined`/function. Out-of-contract by design and correctly so: a throwing getter or throwing `toJSON` still propagates (the doc scopes the guarantee to cycles and BigInt only).
- **`createDeferred` mechanics.** Native idempotency holds (first settlement wins, late `reject` after `resolve` is a no-op on the promise). `settled = true` removal from `resolve` was **KILLED**. `resolve`/`reject` close over local variables and use no `this`, so they are safe to destructure and pass around. Note for consumers: a `Deferred` rejected before any handler is attached does fire `unhandledRejection` (verified) — inherent to the pattern, correctly handled by `deferred.test.ts:39`, and `@bugsee/service`'s use at `packages/service/src/index.ts:131-140` returns the promise to the caller on the same tick.
- **`computeBackoff` numeric edges.** `attempt` = `Infinity`, `1e308`, `NaN`, `-0`, and negatives all clamp correctly (→ `maxDelayMs` or the attempt-0 delay). The jitter formula is pinned at both extremes for the default and a custom ratio. `random()*2-1 → 1-random()*2` and removal of the hard ceiling were both **KILLED**.
- **`fflate` re-export.** Real round-trip integration through the package boundary for both gzip and zip (`fflate.test.ts`); a wrong or missing binding fails the round-trip, not just the import.
- **Baseline health.** `pnpm --filter @bugsee/util exec vitest run` → 11 files / 106 tests pass. `--coverage` → 100% statements (108/108), 100% branches (59/59), 100% functions (26/26), 100% lines (98/98). `pnpm --filter @bugsee/util exec tsc --noEmit` clean.
- **Working tree untouched.** All mutations were applied to the real source and restored from a scratchpad backup after each run; `git status --short packages/util` and `git diff --exit-code packages/util` are both empty as of the end of this review.
