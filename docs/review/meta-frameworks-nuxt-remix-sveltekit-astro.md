# Adversarial review — @bugsee/nuxt + remix + sveltekit + astro

**Reviewed:** 2026-07-27 · **Scope:** the four meta-framework adapters, reviewed as structural peers
(impl / test LOC, measured):

| package | impl LOC | test LOC | entries |
|---|---|---|---|
| `@bugsee/nuxt` | 379 | 562 | `.` (module) · `./server` · `./client` · `./edge` · `runtime/nitro-plugin{,.edge}` |
| `@bugsee/remix` | 248 | 423 | `.` (portable) · `./server` · `./client` |
| `@bugsee/sveltekit` | 286 | 379 | `.` (portable) · `./server` · `./client` · `./edge` |
| `@bugsee/astro` | 321 | 423 | `.` (integration) · `./middleware` · `./server` · `./client` · `./edge` |

**Frameworks actually exercised:**
- **Real builds + real boots** of Nuxt 4.4.8 / Nitro 2.13.4 (`node-server`, `vercel_edge`, and an
  auto-detected `cloudflare-pages` build I ran myself), SvelteKit 2 + `adapter-node` + Vite 8, Astro 5 +
  `@astrojs/node` (SSR, static/SSG, prerender+adapter, and four ad-hoc fixtures I built).
- **All three shipped e2e siblings run green:** `@bugsee/nuxt-e2e` (2 files / 4 tests, incl. a real
  **edge-build** assertion), `@bugsee/sveltekit-e2e` (1/2), `@bugsee/astro-e2e` (1/2).
- **Remix: nothing.** `react-router` and `@remix-run/*` are **not installed anywhere in the repo**
  (`ls node_modules/.pnpm | grep -iE '^react-router|^@remix-run'` → empty; no `packages/remix-e2e`).
- Unit suites: 37 / 29 / 27 / 29 tests, all green; `tsc --noEmit` clean on all four; coverage **100 %
  statements and 100 % branches** on all four.
- Module-graph purity probed with esbuild under edge conditions (`worker,import,module,default`).
- 15 mutations injected and reverted (see *Test quality*).

**Verdict:** These four are **materially better engineered than the `@bugsee/nextjs` template they were
derived from**. The proven nextjs SEV1 — a literal dynamic `import()` dragging `@bugsee/node` into the edge
graph — **does not reproduce in any of the four**: an esbuild probe under edge conditions bundles
`@bugsee/nuxt/edge`, `@bugsee/sveltekit/edge` + `.`, `@bugsee/astro/edge` + `./middleware` and
`@bugsee/remix` with **exactly the same input set as `@bugsee/vercel-edge` itself** (zero `@bugsee/node`
inputs, one guarded `node:crypto` dynamic import that is a baseline property of `@bugsee/util`). The test
suites are strong: every one of 15 injected mutations — including "break the runtime split" and "drop a user
config key" — was caught. However there are **two SEV1s**, both proven by running real framework builds and
servers rather than by reading: Astro converts a legitimate `304`/`204` HTML response into a **500**, and
Nuxt ships the **Node** SDK into a **Cloudflare Workers** bundle on the zero-config deploy path that Nuxt
itself documents. Remix is the weak leg: it is the only one with no real-framework validation at all, while
`docs/design/meta-framework-adapters.md:161` claims all four are "real-boot validated".

---

## SEV1

### 1. Astro turns a `304`/`204`/`205` HTML response into a 500 — proven end-to-end
- **Package(s):** astro (node **and** edge)
- **Where:** `packages/astro/src/middleware.ts:74` and `packages/astro/src/middleware.ts:77`; the call is
  unguarded at `packages/astro/src/middleware.ts:99`; the edge path reuses it at
  `packages/astro/src/edge.ts:71`.
- **What:** `injectTraceIntoResponse` reconstructs the response with `new Response(html, response)` /
  `new Response(body, { status: response.status, … })`. The WHATWG `Response` constructor **throws
  `TypeError`** for a null-body status (204/205/304) with any body — including the empty string that
  `await response.text()` yields. Nothing catches it: `createBugseeMiddleware` only wraps `await next()`
  (`middleware.ts:93-98`), and the injection at `:99` sits outside that `try`.
- **Why it matters:** the SDK converts a *successful* response into a server error. It is the direct
  violation of mandate 4 ("a throw in SDK code cannot 500 a request") and of the repo's own binding
  principle "interceptors must not alter app behavior". A conditional-GET / ETag flow on an HTML page
  (`Astro.response.status = 304`) is ordinary, supported Astro.
- **Evidence (real Astro 5 build + `@astrojs/node` standalone boot, my fixture):**
  ```
  --- GET / ---                 200
  --- GET /api/notmodified ---  500
  [ERROR] TypeError: Response constructor: Invalid response status code 304
      at new Response (node:internal/deps/undici/undici:11393:9)
      at injectTraceIntoResponse (.../dist/server/_astro-internal_middleware.mjs:8852:41)
  ```
  Route under test: `return new Response(null, { status: 304, headers: { 'content-type': 'text/html; charset=utf-8' } })`.
  Isolated constructor check: `new Response('', {status:204|205|304})` → `TypeError` for all three;
  `new Response('', response304)` → `TypeError`.
- **Not present in the peers:** SvelteKit injects through `transformPageChunk` (a string in / string out —
  `handle.ts:33-37`), Nuxt through `html.head.push` (`nitro.ts:95`), Remix through a stream `Transform`
  (`meta-tag-transformer.ts:42`). None reconstructs a `Response`. Astro is the only one that does.
- **No test covers it:** `packages/astro/src/middleware.test.ts:113` exercises a 204 but deliberately with
  **no `content-type`**, so it takes the early return at `middleware.ts:70` and never reaches the
  constructor.

### 2. Nuxt ships the NODE SDK into a Cloudflare Workers bundle on the zero-config deploy path
- **Package(s):** nuxt
- **Where:** `packages/nuxt/src/module.ts:39-43` (`isEdgePreset`) and `packages/nuxt/src/module.ts:83-86`
  (the `addServerPlugin` branch).
- **What:** the node-vs-edge Nitro plugin is chosen from `nuxt.options.nitro?.preset` **at module-setup
  time**. That value is only populated when the user writes `nitro: { preset }` in `nuxt.config.ts`, or via
  `@nuxt/cli`'s explicit override (`process.env.NITRO_PRESET` / `SERVER_PRESET` / `--preset`). Nitro's
  **auto-detection** — the path Nuxt's own deployment docs advertise as zero-config — resolves the preset
  *inside* `createNitro()`, long after modules have run. So on Cloudflare Pages / Workers,
  `isEdgePreset(undefined)` returns `false` and the module registers `./runtime/nitro-plugin`, i.e.
  `@bugsee/bugsee/node`.
- **Why it matters:** the workerd bundle then contains the full Node composition (fs storage, worker-thread
  ANR watchdog, `process.uptime()` in the env builder). Nitro itself warns during the build that
  `nodejs_compat` is off. This is the same end state as the proven nextjs SEV1 — Node code in an edge graph
  — reached by a different route.
- **Evidence (I ran the real build on the shipped fixture):**
  ```
  $ env -u NITRO_PRESET CF_PAGES=1 CF_PAGES_URL=https://x.pages.dev pnpm exec nuxi build   # in packages/nuxt-e2e
  ●  Nitro preset: cloudflare-pages
  [warn] [nitro] [cloudflare] Node.js compatibility is not enabled.
  [success] [nitro] Nuxt Nitro server built

  $ grep -c … dist/_worker.js/chunks/nitro/nitro.mjs
  installBugseeNitroEdge => 0        launchEdge => 0
  installBugseeNitro(   => 1         import('node:fs') => 1      import('node:worker_threads') => 2
  ```
  Inlined in that worker bundle:
  `function installBugseeNitro(e,t){…} … const _1Bl8…=e=>{installBugseeNitro(e,useRuntimeConfig().bugsee)}`
  and `Date.now()-Math.round(1e3*process.uptime())`.
- **Preset-visibility proof** (`loadNuxt` on the same fixture, printing `nuxt.options.nitro?.preset`):
  `no env → undefined`, `NITRO_PRESET=vercel_edge → undefined`, `CF_PAGES=1 → undefined`,
  `VERCEL=1 → undefined`, `NETLIFY=1 → undefined`. The only reason the shipped
  `packages/nuxt-e2e/test/edge-build.e2e.ts` passes is that it sets `NITRO_PRESET`, which
  `@nuxt/cli` forwards as an explicit `loadNuxt` override
  (`@nuxt/cli/dist/build-DWst0L5A.mjs:59`: `preset: ctx.args.preset || process.env.NITRO_PRESET || process.env.SERVER_PRESET`).
  Nitro's own fallback is at `nitropack/dist/core/index.mjs:725` + the `resolvePreset("")` auto-detect below
  it — both inside `createNitro`, after module setup.
- **Fix direction (not applied — read-only review):** resolve the preset in Nuxt's `nitro:config` /
  `nitro:init` hook (where `nitro.options.preset` is final) instead of at `setup`, or ship a single runtime
  plugin that branches at import time on a build-time-defined flag.

---

## SEV2

### 3. Nuxt captures the raw query string — including secrets — into the report event
- **Package(s):** nuxt (the only one of the four)
- **Where:** `packages/nuxt/src/nitro.ts:78` — `...(context?.event?.path !== undefined ? { path: context.event.path } : {})`
- **What:** H3's `event.path` is `this._path || this.node.req.url`
  (`h3@1.15.11/dist/index.mjs:1798`) — it **includes the query string**. The three peers all strip it and
  each documents *why*: `packages/remix/src/handle-error.ts:32-41` ("report attributes don't pass the
  redaction pipeline, so a secret in `?token=…` must not leak"),
  `packages/astro/src/middleware.ts:30-39` (same comment), `packages/sveltekit/src/handle-error.ts:22`
  (`event.url.pathname` is already query-stripped). Nuxt alone passes the raw value through.
- **Evidence (real Nuxt boot against a mock collector, `GET /api/boom?token=SUPERSECRET123&x=1`,
  bundle unzipped):**
  ```
  events.user.json :: [{"timestamp":…,"name":"nuxt.request-error",
     "params":{"method":"GET","path":"/api/boom?token=SUPERSECRET123&x=1","tags":["request"]},"context_id":"21f08d…
  ```
- **Blast-radius note (not a nuxt defect):** the same bundle's `manifest.json` carried
  `"attrs":{"http.method":"GET","http.url":"/api/boom?token=SUPERSECRET123&x=1"}` — that is the already
  root-caused `@bugsee/node` default-`node:http`-owner leak, and it therefore also affects
  sveltekit/astro/remix on node. Only the `events.user.json` entry above is owned by `@bugsee/nuxt`.
- **Test gap:** `packages/nuxt/src/nitro.test.ts:70,75` asserts `path: '/api/x'` — a path with no query, so
  the leak is invisible to the suite. Remix (`handle-error.test.ts:36-41`) and Astro
  (`middleware.test.ts:49`) both have explicit "no secret leak" tests.

### 4. Astro unconditionally buffers the whole SSR HTML body, on an assumption that is false
- **Package(s):** astro (node + edge)
- **Where:** `packages/astro/src/middleware.ts:73` (`const html = await response.text();`); the assumption
  is stated at `packages/astro/src/middleware.ts:62-63`: *"Rewriting buffers the body (Astro's response is
  not streamed here)"*.
- **What / Why it matters:** whenever a trace is active and the response is `text/html`,
  `injectTraceIntoResponse` drains the entire body before returning, so the response can only be sent after
  the last byte is rendered. Astro's node adapter **does** stream. Measured on a page with an async child
  component (`await new Promise(r=>setTimeout(r,1500))`), plain Astro + `@astrojs/node`:
  `Transfer-Encoding: chunked`, `ttfb=0.012s total=1.514s` — i.e. ~1.5 s of the response is streamed after
  the headers. Buffering that turns TTFB into total time. This contradicts the code's own stated premise
  and the repo's "interceptors must not alter app behavior" principle.
- **Peers:** SvelteKit (`handle.ts:43`) and Remix (`meta-tag-transformer.ts:32-44`) both inject
  **per chunk** and preserve streaming; Nuxt injects into the head array before render. Astro is the
  outlier.
- **Caveat, stated honestly:** I could not measure the buffered TTFB directly, because the trace `<meta>`
  did not reproduce on my ad-hoc Astro fixtures (see *Checked and found clean* → open observation). The
  buffering itself is unconditional in the code once `traceMetaTag()` is non-empty, and the shipped e2e
  proves the tag *is* non-empty on a normal SSR page.

### 5. Remix has no real-framework validation at all, contradicting the design doc
- **Package(s):** remix
- **Where:** absence of `packages/remix-e2e`; `react-router` / `@remix-run/*` absent from the whole
  workspace; `docs/design/meta-framework-adapters.md:161-166` — *"all shipped over the shared
  `@bugsee/adapter-kit`, each **real-boot validated**"*.
- **What:** every Remix/RR7 contract the package depends on is a structural guess validated only against
  hand-written fakes: the `handleError(error, {request, params, context})` shape
  (`packages/remix/src/handle-error.ts:16-25`), the claim at `handle-error.ts:5-7` that *"React Router
  filters expected control-flow throws (thrown `Response`/redirect) before this hook"* (nothing in the repo
  verifies it — and if it is wrong, every thrown-`Response` 404/redirect is reported as a crash), the
  `useRouteError()` `{status,statusText,data}` shape (`client.ts:48-56`), the `<HydratedRouter onError>`
  prop (`client.ts:40`), and the `getMetaTagTransformer` pipe contract (`meta-tag-transformer.ts:9-15`).
  The other three each install the real framework and assert an uploaded bundle.
- **Why it matters:** the three peers caught real integration problems only a real boot can catch (that is
  what the e2e siblings exist for). Remix ships the same claim with none of that evidence, and a wrong
  guess here silently means either no reports or 404s reported as crashes.

### 6. Astro's node/edge split is a hand-declared option that is never checked against the actual adapter
- **Package(s):** astro
- **Where:** `packages/astro/src/integration.ts:22-23` (`runtime?: 'node' | 'edge'`, defaulting to node)
  and `packages/astro/src/integration.ts:56`.
- **What:** a user on `@astrojs/cloudflare` or `@astrojs/vercel` edge who does not remember
  `runtime: 'edge'` gets the generated middleware
  `import { registerServer } from '@bugsee/astro/server'` (`integration.ts:46`) — i.e.
  `@bugsee/bugsee/node` in a workerd/edge bundle. Same failure class as SEV1 #2, but user-triggered rather
  than default. The integration receives `config` in `astro:config:setup` and could read `config.adapter`
  in `astro:config:done`; it uses neither, and never warns.
- **Compare:** Nuxt at least *tries* to auto-detect (`module.ts:39`), and SvelteKit makes the choice
  explicit by requiring a different import in `hooks.server.ts`. Astro is the only one where a silently
  wrong default is a single forgotten key away.

### 7. Nuxt-on-edge loses route attribution and trace injection that the node path has
- **Package(s):** nuxt
- **Where:** `packages/nuxt/src/nitro-edge.ts:65-83`; the unused declarations at
  `packages/nuxt/src/nitro-edge.ts:23-28`.
- **What:** `installBugseeNitroEdge` calls `client.logException(error, …)` only. It never calls
  `client.event('nuxt.request-error', {method, path, tags})` the way the node path does
  (`nitro.ts:72-83`), and it registers no `render:html` hook, so **no trace `<meta>` is injected on edge**.
  The interface fields `path`, `method`, `tags` on `EdgeNitroErrorContext` (`nitro-edge.ts:24-28`) are
  declared and never read.
- **Why it matters:** a Nuxt-on-edge report arrives with no route, no method, and no FE↔BE trace join — the
  three things the design calls "the moat". The header comment at `nitro-edge.ts:10-11` acknowledges the
  missing per-request context as "a documented v2", but not the missing attribution, which needs no context
  at all (the values are right there on the hook argument).

---

## SEV3

### 8. Nuxt's `error`-hook body is unguarded while its `render:html` body is guarded
- **Where:** `packages/nuxt/src/nitro.ts:69-84` (no `try`) vs `packages/nuxt/src/nitro.ts:93-98` (wrapped,
  with the comment "trace injection must NEVER break SSR rendering").
- `reportServerError` is itself total (`packages/adapter-kit/src/report-server-error.ts:23-33`), so the
  exposure is small — `isExpectedClientError` reading `error.statusCode` and the params spread. But the
  asymmetry means the *stated* invariant is only enforced on one of the two hooks, and Nitro propagates a
  throwing `error`-hook handler out of its own error handler.

### 9. Edge `waitUntil` blast radius (confirmed `@bugsee/vercel-edge` SEV1)
- `packages/nuxt/src/nitro-edge.ts:73` calls the resolved `waitUntil(...)` **directly inside the Nitro
  `error` hook with no `try`**. `resolveWaitUntil` (`packages/vercel-edge/src/wait-until.ts:24-39`) returns
  the host's bound `waitUntil` when present; a host that throws (Cloudflare does, when `waitUntil` is
  called outside a live request — reachable here because the Nitro `error` hook also fires for
  `plugin`/`unhandledRejection` tags) takes the error hook down with it.
- `packages/sveltekit/src/edge.ts:76` and `packages/astro/src/edge.ts:68` run the **entire request**
  inside `runInEdgeContext`, whose unguarded `finally` (`packages/vercel-edge/src/edge-context.ts:67-74`)
  is the already-confirmed vercel-edge SEV1 — a throwing host `waitUntil` there destroys the user's
  `Response`, and the flush is not time-bounded.

### 10. Remix + SvelteKit inject a **second** `<meta>` into any later chunk containing `</head>`
- **Where:** `packages/remix/src/meta-tag-transformer.ts:42`, `packages/sveltekit/src/handle.ts:36`.
- Both run `html.replace('</head>', …)` **per chunk** with no "already injected" flag, so a page whose body
  renders a literal `</head>` (a code-sample page, an escaped-HTML blog post, an inline script string) gets
  a stray `<meta name="traceparent">` in the body.
- **Evidence** (exact transformer logic, two writes):
  ```
  "<html><head><title>a</title><META></head><body><pre>example: &lt;/head&gt;</pre>
   <script>var s=\"<META></head>\";</script></body></html>"
  ```
- Sharper for Remix specifically: RR7 hydrates with `hydrateRoot(document, …)`
  (`packages/remix/src/client.ts:28`), so an element React did not render, injected inside `<body>`, is a
  hydration-mismatch candidate. Astro (buffered, first-match-only) and Nuxt (`head.push`) are not affected.

### 11. Route names are raw paths, not parameterized patterns (3 of 4)
- nuxt `packages/nuxt/src/nitro.ts:78` → `/api/users/42`; astro `packages/astro/src/middleware.ts:55` →
  `/users/42`; remix `packages/remix/src/handle-error.ts:60-61` → raw `path` **plus the matched `params`
  values** (`{id:'42'}`), i.e. the ids are captured twice.
- Only SvelteKit ships a real pattern: `routeId` `/users/[id]` (`packages/sveltekit/src/handle-error.ts:56`)
  and `http.route` on the edge context (`packages/sveltekit/src/edge.ts:59`). Astro's `APIContext` does
  expose `context.routePattern` (Astro ≥5) and it is not used; Nuxt's H3 event has no route pattern, but
  Nitro's error hook context does carry the matched route on newer versions.
- Consequence: server-error grouping/aggregation keys on high-cardinality URLs for three of four adapters.

### 12. No adapter validates `appToken`; a JS config silently launches with `undefined`
- `packages/astro/src/integration.ts:32` → `registerClient(undefined, {})` when `astro.config.mjs` (plain
  JS — no type checking) omits it; `packages/nuxt/src/module.ts:70-71` → `runtimeConfig.public.bugsee =
  { appToken: undefined }` when `modules: ['@bugsee/nuxt']` is added with no `bugsee:` key (the module
  declares no `defaults`). Mandate 6 asks for "fails loudly rather than silently"; both fail silently.

### 13. Astro's option bags are untyped and lossily serialized
- `packages/astro/src/integration.ts:19,21` type `client`/`server` as `Record<string, unknown>` — a typo'd
  option name is accepted silently. Nuxt does this correctly
  (`packages/nuxt/src/module.ts:20,22` derive from the real `Install*Options`).
- `packages/astro/src/integration.ts:32,42-46` embed the bags with `JSON.stringify`, which silently drops
  function-valued and `undefined` options (e.g. `onError`, `systemMetricsSampler`) and throws on a circular
  value at `astro.config.mjs` eval time, outside any guard.

### 14. Astro `client`/`server` bags are also *baked into the build*, not runtime config
- `packages/astro/src/integration.ts:56` computes `moduleCode` once at integration construction, so
  everything (including the endpoint) is frozen at build time. `packages/astro-e2e/astro.config.mjs:5-7`
  documents this and works around it. Nuxt does this properly through `runtimeConfig` + `NUXT_*` env
  overrides (`packages/nuxt/src/module.ts:70-71`). Astro users cannot change any Bugsee option between
  environments without rebuilding.

### 15. Test-strength gaps (everything below was verified by running, not by reading)
- **No hydration assertion anywhere.** All three e2e siblings `fetch()` the SSR HTML and grep for
  `<meta name="traceparent"` (`packages/nuxt-e2e/test/nuxt.e2e.ts:111`,
  `packages/sveltekit-e2e/test/sveltekit.e2e.ts:100`, `packages/astro-e2e/test/astro.e2e.ts:124`). None
  loads the page in a browser, so a hydration mismatch caused by the injected `<meta>` would not be caught
  — most relevant for Remix (`hydrateRoot(document, …)`).
- **Only Nuxt has an edge-build test** (`packages/nuxt-e2e/test/edge-build.e2e.ts`), and as shown in SEV1
  #2 it only covers the explicit-`NITRO_PRESET` path. SvelteKit and Astro have **no** edge build or boot
  test at all, although both ship an `./edge` entry.
- **No composition test for SvelteKit's `sequence`.** `packages/sveltekit-e2e/src/hooks.server.ts:15` is
  `sequence(bugseeHandle)` — a single handle — so merging `transformPageChunk` with a *user* handle (the
  documented usage at `packages/sveltekit/src/handle.ts:10`) is never exercised.
- **No source-map / debug-id wiring** in any of the four (`@bugsee/bundler-plugin-core`,
  `@bugsee/vite-plugin`) and no component-annotate wiring for SvelteKit
  (`@bugsee/svelte-plugin-component-annotate` is not referenced by `@bugsee/sveltekit` at all). This is
  design decision D2 (`docs/design/meta-framework-adapters.md:71`) deferring P6 to #158, so it is a known
  gap, not a regression — but it means production stack traces stay minified and Svelte component
  attribution is absent, which is worth stating next to the "shipped" claim at line 161.

---

## Per-package summary

| package | SEV1 | SEV2 | SEV3 | headline |
|---|---|---|---|---|
| **nuxt** | 1 (#2) | 2 (#3, #7) | 4 (#8, #9, #11, #12) | Zero-config Cloudflare deploy silently bundles the **Node** SDK into a worker; raw query string (with secrets) reaches the wire |
| **remix** | 0 | 1 (#5) | 3 (#10, #11, #15) | Only adapter with **no real-framework validation whatsoever**, while the design doc claims otherwise; every framework contract is an unverified structural guess |
| **sveltekit** | 0 | 0 | 3 (#9, #10, #15) | Cleanest of the four; error seam chains + delegates correctly, only adapter with parameterized route names; edge path untested |
| **astro** | 1 (#1) | 3 (#4, #6, #14) | 3 (#12, #13, #15) | A `304`/`204` HTML response becomes a **500**; response body buffered unconditionally; node/edge choice is an unvalidated hand-declared flag |

---

## Edge/server split integrity (the key question)

| package | does Node code leak into the edge graph? | evidence |
|---|---|---|
| **nuxt** — `@bugsee/nuxt/edge` module graph | **No** | esbuild `platform:neutral`, `conditions:[worker,import,module,default]`, `external:['node:*']`: 131 846 B, `node:` specifiers = `["node:crypto"]` only, **0** inputs from `packages/node`/`node-utils` — byte-for-byte the same input set as the `@bugsee/vercel-edge` baseline (133 034 B, same one specifier). |
| **nuxt** — *which* plugin the module ships | **YES, on auto-detected presets** | SEV1 #2. Real `nuxi build` with `CF_PAGES=1`: worker bundle contains `installBugseeNitro(` ×1, `import('node:fs')` ×1, `import('node:worker_threads')` ×2, and **zero** `installBugseeNitroEdge`/`launchEdge`. The explicit `NITRO_PRESET=vercel_edge` build (the shipped e2e) is clean. |
| **sveltekit** — `./edge` + `.` | **No** | Same probe: 136 140 B, `["node:crypto"]`, 0 node-package inputs. The `.` entry is genuinely portable (`@bugsee/adapter-kit` + type-only `@bugsee/core`). |
| **astro** — `./edge` + `./middleware` | **No (module graph)** / **yes if `runtime` is mis-declared** | Same probe: 135 981 B, `["node:crypto"]`, 0 node-package inputs. But the *choice* is `options.runtime === 'edge'` (`integration.ts:56`) with no adapter check — SEV2 #6. |
| **remix** — `.` (the entry `entry.server` imports) | **No** | 3 475 B, **zero** `node:` specifiers, 0 node-package inputs. The strictest split of the four; the `node:stream` transformer correctly lives only behind `./server` (`packages/remix/src/server.ts:15`). |
| baseline `@bugsee/vercel-edge` alone | (reference) | 133 034 B, `["node:crypto"]` — the single `node:crypto` is a **guarded dynamic** import in `@bugsee/util` (`packages/util/src/sha256.ts:24`, taken only when `globalThis.crypto.subtle` is absent). Not attributable to these four. |

**The `@bugsee/bugsee` 3-condition gap does not bite any of the four**, for the same reason it missed
nextjs: every edge path imports `@bugsee/vercel-edge` **directly**
(`packages/nuxt/src/nitro-edge.ts:12-18`, `packages/sveltekit/src/edge.ts:17-23`,
`packages/astro/src/edge.ts:12-18`); every node path uses the explicit `/node` subpath
(`packages/nuxt/src/nitro.ts:11-15`, `packages/remix/src/server.ts:9`,
`packages/sveltekit/src/server.ts:8`, `packages/astro/src/server.ts:8`); every browser path resolves under
a genuine `browser` condition (`packages/nuxt/src/client.ts:9-13`, `packages/remix/src/client.ts:8`,
`packages/sveltekit/src/client.ts:9`, `packages/astro/src/client.ts:7`). Verified by reading all four
`package.json` `exports` maps and by the esbuild probe above.

---

## Error-seam matrix

| package | chains to app handler? | framework error page still renders? | SDK throw contained? | file:line |
|---|---|---|---|---|
| **nuxt** (node) | n/a — Nitro's `error` is an additive `hookable` notification hook, never replaces anything | ✅ hook is observe-only; Nitro renders its own 500 (verified: e2e `/api/boom` → 500) | ⚠️ partial — `reportServerError` is total, but the hook body has no `try` (`nitro.ts:69-84`) while `render:html` does (`:93-98`) | `packages/nuxt/src/nitro.ts:69` |
| **nuxt** (edge) | n/a | ✅ | ❌ `waitUntil(...)` unguarded inside the hook | `packages/nuxt/src/nitro-edge.ts:65,73` |
| **remix** | n/a — `handleError` is a notification hook; the user's `handleError` is the one they export, ours is optional | ✅ returns void; Remix/RR still renders the `ErrorBoundary` | ✅ whole body in `try/catch` | `packages/remix/src/handle-error.ts:47-69` |
| **sveltekit** | ✅ **best of the four** — `handleErrorWithBugsee(appHandler)` reports **then** delegates and **forwards the return** (the `App.Error` SvelteKit renders); it delegates even for errors it skips | ✅ `createHandleServerError` returns `undefined` → SvelteKit's default error page | ✅ report path fully wrapped (`:43-63`) | `packages/sveltekit/src/handle-error.ts:80-88` |
| **astro** (node) | n/a — Astro has no `onRequestError`; the middleware wraps `next()` | ✅ **rethrows** (`throw error; // rethrow so Astro renders its error page`) | ❌ **no** — the success path (`injectTraceIntoResponse`) is outside the `try` → SEV1 #1 | `packages/astro/src/middleware.ts:91-100` |
| **astro** (edge) | n/a | ✅ `runInEdgeContext` captures + rethrows (deliberately not double-reporting) | ❌ same injection defect, plus the vercel-edge `finally` | `packages/astro/src/edge.ts:65-73` |

**404 / redirect handling:** nuxt skips `statusCode < 500` (`nitro.ts:52-55,70`, tested at
`nitro.test.ts:79-89`); sveltekit skips `status < 500` (`handle-error.ts:45`, tested at
`handle-error.test.ts:49`); remix skips aborted requests (`handle-error.ts:51`, tested at
`handle-error.test.ts:63`) and route-error-responses on the client (`client.ts:48-56,68`); astro reports
whatever `next()` throws — correct for Astro, where 404s and redirects are returned `Response`s, not throws.
**Mutation-verified:** removing each of these guards makes the suite fail (see below).

---

## Session-stitching + privacy

| package | correlation works? | mis-stitch risk | route names parameterized? |
|---|---|---|---|
| **nuxt** | ✅ **empirically proven** — I hit `/api/boom` on a real boot and the uploaded `events.user.json` entry carried `"context_id":"21f08d…"`, i.e. the report was stamped with the live per-request context | Low. The server error correlates via the server's own `run`-scoped ALS context opened by `@bugsee/node`'s `node:http` emit-patch (`packages/node/src/server-instrument.ts:350`); no browser session id ever crosses to the server, so there is no path for user A's session to attach to user B's server error. The FE↔BE join runs the *other* way (server trace → client via `<meta>`). | ❌ raw path **with query** (`nitro.ts:78`) |
| **remix** | Unproven (no e2e). Mechanism is the same portable `reportServerError` + node emit-patch. | Low, same reasoning | ❌ raw path + matched param **values** (`handle-error.ts:58-61`) |
| **sveltekit** | ✅ e2e proves a bundle with `mechanism: 'http-error'` and the thrown message uploads (`sveltekit.e2e.ts:112-117`); `context_id` not asserted | Low, same reasoning. On edge, `runInEdgeContext` mints a fresh `contextId` per invocation (`packages/vercel-edge/src/edge-context.ts:52`) | ✅ `routeId` `/users/[id]` (`handle-error.ts:56`) + `http.route` (`edge.ts:59`) |
| **astro** | ✅ e2e proves an **endpoint-first cold request** still delivers the report (`astro.e2e.ts:103-119`) — a genuinely well-designed test that validates the "launch from the middleware, not `page-ssr`" decision at `integration.ts:5-9` | Low, same reasoning | ❌ raw pathname (`middleware.ts:55`); `context.routePattern` available and unused |

**Trace-value integrity:** the `traceparent` written into the SSR HTML is built from
`RequestContext.trace`, which on node comes from the `http.server` transaction, and any *inbound*
continuation is validated by `parseTraceparent` (`packages/capture/src/traceparent.ts:71-92`) — strict
`^[0-9a-f]{32}$` / `^[0-9a-f]{16}$` / `^[0-9a-f]{2}$`, lowercased, all-zero and version `ff` rejected. So
the hex invariant `traceMetaTag` assumes **is** enforced upstream on every path these four use.

---

## traceMetaTag XSS reachability

| package | user-controlled input reaches the sink? | file:line |
|---|---|---|
| **nuxt** | **No.** `traceMetaTag` → `getTraceparent` reads `RequestContext.trace`, set from the local transaction id or a `parseTraceparent`-validated inbound header. No supported seam lets a request-controlled string through. | sink `packages/adapter-kit/src/trace-data.ts:49`; call `packages/nuxt/src/nitro.ts:94`; guard `packages/capture/src/traceparent.ts:82-90`; write `packages/node/src/server-instrument.ts:395-413` |
| **remix** | **No** (same chain; also read once per response at transformer creation) | `packages/remix/src/trace-meta.ts:15` → `packages/remix/src/meta-tag-transformer.ts:31` |
| **sveltekit** | **No** (node); on edge no per-invocation trace is minted at all, so the tag is `''` | `packages/sveltekit/src/handle.ts:35`; edge no-op documented at `packages/sveltekit/src/edge.ts:15` |
| **astro** | **No** (same chain) | `packages/astro/src/middleware.ts:71` |

The adapter-kit SEV2 (an unescaped raw-HTML sink asserting an unenforced invariant) remains a latent
hardening item — a *future* adapter or a non-`parseTraceparent` trace writer would make it live — but
**none of these four reaches it with attacker-controlled data today**. Escaping the value at
`trace-data.ts:49` would close it for good at zero cost.

**Hydration:** the injected `<meta>` lands in `<head>` on all four, outside the hydrated app root for
Nuxt/SvelteKit/Astro. Remix hydrates `document` itself (`packages/remix/src/client.ts:28`), so it is the
one package where head injection interacts with React's hydration — and where SEV3 #10 (a stray `<meta>` in
the *body*) would be a real mismatch. No package tests this (SEV3 #15).

---

## Build-config preservation

| package | user config preserved? | file:line |
|---|---|---|
| **nuxt** | ✅ **verified two ways.** The module only writes the `bugsee` / `public.bugsee` keys and merges its values **under** anything the user already set (Nuxt `defu` convention), leaving other `runtimeConfig` keys untouched. Mutation-verified: dropping either `...asRecord(...)` spread makes the suite fail. | `packages/nuxt/src/module.ts:70-71`; test `packages/nuxt/src/module.test.ts:54-71` |
| **astro** | ✅ **verified empirically.** I built a fixture whose `astro.config.mjs` declares its own vite plugin (a virtual module) **and** a `vite.define`; both survived — the page imported `virtual:user-marker` and read `__USER_DEFINE__` and the build completed. Astro's `updateConfig` deep-merges and concatenates `vite.plugins`. | `packages/astro/src/integration.ts:64-78` |
| **sveltekit** | n/a — touches no build config; composes via the user's own `sequence()` in `hooks.server.ts` | `packages/sveltekit/src/handle.ts:10` |
| **remix** | n/a — touches no build config; the user wires `entry.server`/`entry.client` by hand | `packages/remix/src/index.ts:1-8` |

**Astro SSG is safe** (mandate 2): I built `output: 'static'` with no adapter — build **completed in 5 s**,
no hang, the client `injectScript('page')` was emitted into `dist/index.html`, and **no server middleware
was bundled**, so `registerServer` (→ `@bugsee/node`) never ran at build time. I also built
`output: 'static'` **with** `@astrojs/node` and a `prerender = true` page — completed in 3 s, no hang. The
known `@bugsee/node` "default `launch()` pins the host process" defect therefore does **not** reach
`astro build`.

---

## Test quality — 15 mutations injected and reverted, **15/15 caught**

Every mutation was applied to the real source with a `cp` backup, the package suite run, then restored from
the backup (never `git checkout`). `git status --short packages/` is empty.

| # | mutation | result |
|---|---|---|
| M1 | nuxt: force the node plugin regardless of preset (**breaks the runtime split**) | ✅ caught — 4 tests failed |
| M2 | nuxt: drop the user's `public.bugsee` keys (**drops a user config key**) | ✅ caught — 1 failed |
| M2b | nuxt: drop the user's private `bugsee` keys | ✅ caught — 1 failed |
| M3 | astro: ignore `runtime:'edge'`, always emit the node module | ✅ caught — 1 failed |
| M4 | sveltekit: stop chaining to the app's `handleError` | ✅ caught — 2 failed |
| M5 | astro: swallow the error instead of rethrowing | ✅ caught — 2 failed |
| M7 | nuxt: report `<500` H3 errors (404s as crashes) | ✅ caught — 1 failed |
| S4 | nuxt: flip `injectTraceMeta` default to off | ✅ caught |
| S12 | nuxt: drop `cloudflare`/`worker` from edge detection | ✅ caught — 2 failed |
| S8 | remix: `safePath` returns the full URL (**query leak**) | ✅ caught — 3 failed |
| S8b | astro: `safePath` returns the full URL (**query leak**) | ✅ caught — 2 failed |
| S9 | sveltekit: report 404s | ✅ caught — 2 failed |
| S7 | astro-edge: drop trace injection | ✅ caught |
| S6 | sveltekit-edge: drop the `http.route` attribute | ✅ caught |
| — | control: unmutated baseline | 37 / 29 / 27 / 29 pass |

**Not test theater.** Concretely: `packages/nuxt/src/module.test.ts:118-127` compiles the *generated*
client-plugin source to prove it parses; `packages/nuxt/src/nitro.test.ts:137-151` drives a hostile
`head.push` that throws; `packages/remix/src/client.test.ts:12-15` keeps `@bugsee/react` **real** so the
`export *` re-export is genuinely exercised and then asserts referential identity at `:107-108`;
`packages/astro/src/middleware.test.ts:49` asserts the query string is absent by value; the three e2e
siblings unzip the actual uploaded bundle and assert `request.json`'s `source.mechanism` **and** the thrown
message, not merely "an upload happened". The gap is coverage of the *un*happy shapes (SEV1 #1's 204-with-
content-type, SEV2 #3's query string), not weak assertions.

---

## Checked and found clean

- **The nextjs SEV1 does not reproduce.** No package uses a literal dynamic `import('<node-entry>')` inside
  a portable/edge module. Nuxt splits at **build time** by shipping a different runtime file
  (`module.ts:83-86`); Astro splits at build time by generating different module source
  (`integration.ts:44-47`); SvelteKit and Remix split by requiring a different **subpath import** in the
  user's own file. All three strategies are bundler-safe. (The nuxt defect is in *which* file is chosen,
  not in the mechanism.)
- **Edge module graphs are byte-comparable to the `@bugsee/vercel-edge` baseline** — see the table above.
- **`@bugsee/util`'s `node:crypto`** (`packages/util/src/sha256.ts:24`) is a properly guarded dynamic
  import behind a `globalThis.crypto.subtle` check; it appears in the edge graph of the baseline SDK too
  and is not attributable to these four.
- **Astro static (SSG) and prerender+adapter builds are unaffected** — both complete, neither hangs,
  neither bundles the server middleware into a no-server build.
- **Astro preserves the user's `vite` config** (plugins + defines), verified by a real build.
- **Nuxt preserves the user's `runtimeConfig`**, verified by test + mutation.
- **SvelteKit's error seam is the reference implementation of mandate 3** — reports, delegates, forwards the
  app's return value, and still delegates for errors it chooses not to report
  (`handle-error.ts:80-88`, tested at `handle-error.test.ts:105-113`).
- **Astro's endpoint-first launch decision is correct and genuinely proven** — the launch lives in the
  middleware rather than an `injectScript('page-ssr')`, and `packages/astro-e2e/test/astro.e2e.ts:90-93`
  deliberately probes an *endpoint* for readiness so the whole run is endpoint-first.
- **Remix's `./server` boundary is the tightest of the four** — the only `node:*` user
  (`meta-tag-transformer.ts:17`) is exported solely from `server.ts:15`, and the `.` entry bundles to
  3.5 KB with zero `node:` specifiers.
- **`tsc --noEmit` clean; coverage 100 % statements / 100 % branches on all four**; the three e2e siblings
  all pass (`pnpm --filter @bugsee/{nuxt,sveltekit,astro}-e2e test:e2e` → exit 0).
- **Open observation, NOT a finding (could not root-cause, so not reported as a defect):** on four ad-hoc
  Astro fixtures I built under `packages/astro-e2e/node_modules/`, the trace `<meta>` was injected in one
  (the 304 repro) and absent in three, with otherwise-identical integration config. The shipped
  `@bugsee/astro-e2e` reliably gets it. This is most likely an artifact of my fixture placement (duplicate
  module instances → separate carriers) rather than product behaviour, but it is worth one deliberate
  follow-up experiment from a normally-located fixture before trusting the injection unconditionally.

---

### Read-only compliance

`git status --short packages/` is **empty**. Every mutated file was backed up with `cp` and restored from
that backup (never `git checkout`). All scratch fixtures and probes were created under gitignored
`node_modules/` paths and removed; build artifacts (`.output/`, `dist/`, `.astro/`, `build/`) are covered by
the root and per-package `.gitignore`s. No network requests to Bugsee infrastructure; all servers bound to
`127.0.0.1`; no credentials used.
