# Adversarial review — @bugsee/webworker

**Reviewed:** 2026-07-27 · **Scope:** packages/webworker (impl 521 LOC — `launch.ts` 359, `environment.ts` 89, `event.ts` 54, `index.ts` 19; tests 853 LOC — `launch.test.ts` 677, `environment.test.ts` 103, `event.test.ts` 73)
**Verdict:** The prior is mostly right but **one claim is wrong: this is not "bundle-only" coexistence** — `launch.ts:201-209` passes `captureRecovery: durableCapture`, so the capture-chunk and report-marker stores are wired too (#165 is fully built here, contrary to what `launch.ts:70-71`, `index.ts:3` and `README.md:47` still say). The Web-Worker/Service-Worker split is real, the DOM-less discipline holds (verified empirically — the whole suite runs in `environment: 'node'` while statically importing the DOM-ful `@bugsee/browser` root, and nothing touches `window`/`document`/`localStorage`), the SDK adds no `fetch`/`install`/`activate` listener of its own and never calls `skipWaiting`/`clients.claim`, and `captureNetwork: false` genuinely leaves the host's `fetch` unpatched (subscriber-presence activation, `core/src/interceptor-base.ts:8-13`). Coverage is 100/100/100/100 with 43 green tests. But the package's single most important guarantee — "the flush promise reaches `event.waitUntil`" — is **not verified by any test**: three separate mutations that turn the flush into fire-and-forget (the confirmed vercel-edge defect class) all pass 4/4. And the biggest real-world hole is the one the design never closed: **there is no Service-Worker runtime detection at all**. `platformType` defaults to `'web-worker'`, and durability, capture persistence and recovery are keyed off it — so a Service Worker that calls `launch(token)` the way the README's first example shows runs memory-only and loses its entire rolling buffer on every idle termination, silently, while reporting the wrong `platform.type` to the server. `@bugsee/util` has exported `isServiceWorker()` for exactly this purpose since day one and is not used. Two further SEV1s are inherited-but-amplified: an uncancelled `Response.clone()` on the body fast-skip path (a page-level annoyance; a whole-site memory hazard in an SW that proxies every asset), and Web-Locks-absent degradation that silently turns per-activation IndexedDB namespaces into unbounded origin-storage growth.

## SEV1

### 1. No Service-Worker detection — the SW default path is memory-only and silently lossy
- **Where:** `packages/webworker/src/launch.ts:229` (`options.platformType ?? 'web-worker'`), `packages/webworker/src/launch.ts:188` (`const persist = options.persist ?? options.platformType === 'service-worker'`), `packages/webworker/src/launch.ts:193-194`
- **What:** Every durability decision in the package hangs off a **caller-supplied string**. `persist` (durable bundle queue), `durableCapture` (IDB chunk capture store) and `recoverEnabled` (report markers + `recoverReports`) are all `false` unless the developer remembers `platformType: 'service-worker'`. There is no probe of the actual global scope anywhere in the package — `grep -rn 'ServiceWorkerGlobalScope' packages/webworker/src` returns nothing.
- **Why it matters:** A Service Worker is terminated without warning when idle and restarted per event. A developer following the README's *first* example (`README.md:8` — `launch('<TOKEN>')`, no options) inside `sw.js` gets: no durable bundle queue, no capture persistence, no marker recovery, and `platform.type: 'web-worker'` on the wire (wrong data server-side, wrong platform in the dashboard). Every termination then discards 100% of the rolling buffer *and* any incident that had not finished uploading. The failure is completely silent — no warning, no `onError`.
- **Evidence:** The package's own tests encode the hazard: `launch.test.ts:258-261` ("a web-worker (persist OFF) registers no marker store" — `getService(ReportMarkerStoreToken)` throws) and `launch.test.ts:570-573` ("a web-worker defaults persist OFF → no durable BundleStore"). The detection primitive already exists and is purpose-built for this exact distinction: `packages/util/src/env.ts:26-32` — `isWebWorker()` (deliberately excludes SW) and `isServiceWorker()`; `@bugsee/util` is currently only a **devDependency** of this package (`packages/webworker/package.json`). Control mutation proving the default is load-bearing: flipping `launch.ts:229` to a hard `'service-worker'` fails 1 test.

### 2. `launch()` emits an unhandled rejection when `onError` is not passed — and the SDK then reports its own failure as a customer crash
- **Where:** `packages/webworker/src/launch.ts:324` (`void coexistence.recoverDeadSiblings({…})`, no `.catch`), `packages/webworker/src/launch.ts:206` (`onError` forwarded to coexistence **only when defined**), `packages/browser-utils/src/coexistence.ts:194` (`.catch(onError)`)
- **What:** When the caller does not pass `onError` — the documented default (`launch.ts:120`, and every README example) — `createCoexistence` receives `onError: undefined`, so `coexistence.ts:194`'s `.catch(onError)` is `.catch(undefined)`, i.e. a **pass-through, not a handler**. Any rejection inside the per-sibling recovery therefore rejects `Promise.all` → rejects `recoverDeadSiblings()` → and `launch.ts:324` `void`s that promise with no rejection handler. Same shape at `launch.ts:314-318` (`void (…whenReady ?? Promise.resolve()).then(() => durable.recover())`).
- **Why it matters:** In a Service Worker the resulting unhandled rejection fires an `unhandledrejection` event on the SW global — **which is exactly where this package registered its own listener** (`launch.ts:306`, `createUnhandledRejectionProvider(scope)` → `packages/browser/src/detection-providers.ts` `WindowUnhandledRejectionProvider` → `createErrorReport({mechanism: 'unhandledrejection'})`). The SDK's internal recovery failure becomes a customer-facing error incident, assembled and uploaded — noise in the customer's dashboard, and traffic/battery on a path that was supposed to be silent-on-failure.
- **Evidence (empirically reproduced):** I added a temporary probe test (since removed; tree verified clean) that launched with `platformType:'service-worker'`, a seeded dead-sibling bundle, and a `LockManager` whose `ifAvailable` probe rejects — a shape real `navigator.locks` produces (SecurityError in an opaque origin; InvalidStateError/AbortError while an SW is torn down). Result with **no** `onError`: `UNHANDLED_COUNT= 1 [ 'Error: lock probe boom' ]`. Result with `onError: () => {}` supplied: **0**. The guard is the caller's optional option, not the code.
- **Blast radius:** `packages/browser/src/launch.ts:484` and `:493` are the identical construct.

### 3. Uncancelled `Response.clone()` on the Content-Length fast-skip — a whole-site memory hazard inside an SW
- **Where:** `packages/capture/src/fetch-interceptor.ts:260` (clone taken) → `packages/capture/src/fetch-interceptor.ts:139-141` (`if (contentLength > maxBytes) return {reason:'size_too_large'}` — returns **before** `getReader()`, so the clone's stream is never read and never cancelled); reached from `packages/webworker/src/launch.ts:299` (`installNetworkCapture`, `captureNetwork` + `captureNetworkBodies` both default **true**)
- **What / Why it matters:** `Response.clone()` tees the body stream. The app-side branch drives the pulls; every pulled chunk is also enqueued into the abandoned SDK branch, whose queue grows without bound. In a page this costs one large response. In a **Service Worker** the canonical pattern is `event.respondWith(fetch(event.request))` — the SDK's patched global `fetch` therefore clones **every asset of the entire site**, and every response with a `Content-Length` above `maxNetworkBodySize` (default 20 KB — i.e. essentially every image, script bundle, video, or download) takes the uncancelled path. A 200 MB video streamed through a caching SW is fully buffered in the worker.
- **Note:** The line is in `@bugsee/capture`, but the SW is the context where it is worst, and this package turns it on by default. The other early returns are benign (`:143-145` no body, `:146-148` no `getReader` so nothing to cancel); only the size fast-skip abandons a live stream. The over-cap path *inside* the read loop does cancel correctly (`:161-164`).

### 4. TEST — the flush-into-`waitUntil` guarantee is unverified: three surviving mutations
- **Where:** `packages/webworker/src/event.test.ts:29`, `:44`, `:57`, `:71` (all four tests assert `expect(flush).toHaveBeenCalledTimes(1)`); the fake event at `event.test.ts:11-19` only *collects* the promises
- **What:** The whole purpose of `event.ts` is that the flush promise is **handed to** `event.waitUntil`. No test asserts that. Verified empirically (control mutation first, to prove the harness bites):
  | # | mutation | result |
  |---|---|---|
  | M1 (control) | delete `throw error;` at `event.ts:51` | **caught** — 1 failed / 3 passed |
  | M2 | `event.ts:45` → `void client.flush(); event.waitUntil(Promise.resolve())` | **SURVIVED — 4 passed** |
  | M3 | `event.ts:42` → `.then(() => { void client.flush(); })` | **SURVIVED — 4 passed** |
  | M4 | `event.ts:50` → `void client.flush();` (no `waitUntil` at all) | **SURVIVED — 4 passed** |
  | M5 | delete `logException` in the async-rejection path (`event.ts:40`) | caught — 1 failed / 3 passed |
- **Why it matters:** M2/M3/M4 are precisely the regression this module exists to prevent, and the exact confirmed defect in the `@bugsee/vercel-edge` sibling ("the promise was never passed"). A refactor that reintroduces it ships green, at 100% coverage. The fix is one assertion shape: capture the array the fake collects and assert the *identity/settlement* of the flush promise (e.g. resolve `flush` from a deferred and assert the collected promise is still pending until it settles).

### 5. Web Locks absent ⇒ no dead-sibling recovery **and** no sweep ⇒ unbounded IndexedDB growth, silently
- **Where:** `packages/browser-utils/src/coexistence.ts:125` (`options.locks ?? navigator?.locks`), `:130` (`liveness.holdSelf`), `packages/browser-utils/src/web-lock-liveness.ts:40-47` (`available:false`, `recoverIfDead: () => Promise.resolve()`); consumed at `packages/webworker/src/launch.ts:201-209`
- **What:** Every `launch()` mints a fresh `instanceId` and writes under `"<instanceId>/"` in the per-token bundle/capture/marker databases. The **only** thing that ever deletes another instance's prefix is `recoverDeadSiblings` → `recoverIfDead`, which is a **hard no-op when `navigator.locks` is unavailable**. The per-instance capture store built at `launch.ts:262` is scoped to `coexistence.captureView` (its own prefix), so it cannot reclaim foreign prefixes either.
- **Why it matters in an SW specifically:** a Service Worker cold-starts many times a day (fetch/push/sync after idle), and each start is a new `instanceId` = a new prefix that may hold up to `maxDataSize` (default **10 MB**) of capture. Without Web Locks nothing is ever reclaimed → origin storage grows monotonically → eventual quota pressure/eviction, which takes the **site's own Cache Storage** with it. That is a host-behavior impact, not just an SDK one.
- **And it is silent:** the degradation warning (`web-lock-liveness.ts:11-13`, `WEB_LOCKS_UNAVAILABLE_WARNING`) is routed through `warn`, which `coexistence.ts:124-127` only supplies when `onError` was passed — the default launch drops it entirely.
- **Root defect is `@bugsee/browser-utils` (already reported: "orphaned capture never reclaimed without Web Locks"); this is its SW blast radius.** See also "Web Locks availability" below — in the browsers this package targets, `navigator.locks` *is* present in SW scope, so the exposure is old-Safari/hardened-context, not the mainline path.

## SEV2

### 6. `withBugseeEvent`: a throwing/absent `waitUntil` produces a false crash report **and** escapes into the host handler
- **Where:** `packages/webworker/src/event.ts:45` and `:47-52`
- **What:** `event.waitUntil(client.flush())` at `:45` sits **inside** the `try`. If `waitUntil` throws — the event is not an `ExtendableEvent` (a JS consumer wrapping `message` on a dedicated worker, or any `as any` cast past the `ExtendableEventLike` type), or the spec's `InvalidStateError` (dispatch flag unset / no pending extend-lifetime promises) — control lands in the `catch` at `:47`, which (a) calls `client.logException(error, {mechanism:'uncaught'})` on the **SDK's own** TypeError, minting a bogus "uncaught crash" incident for the customer, then (b) calls `event.waitUntil(client.flush())` **again** at `:50`, which throws again, and that second throw escapes the wrapper into the host's event listener.
- **Failure scenario:** handler throws `AppError` → `logException(AppError)` → `waitUntil` throws `TypeError` → `TypeError` propagates out of the listener instead of `AppError` (`throw error` at `:51` is never reached). The host sees the wrong error; the SDK-attributed one is what surfaces.
- **Untested:** the fake at `event.test.ts:14-17` can never throw.

### 7. The `waitUntil` flush is not time-bounded
- **Where:** `packages/webworker/src/event.ts:42`, `:45`, `:50` — all call `client.flush()` with **no timeout**; `packages/core/src/client.ts:404-411` takes the un-raced branch when `timeout === undefined`
- **What / Why it matters:** the promise handed to `event.waitUntil` has no SDK-level deadline; it is bounded only indirectly by the transport's per-request 30 s abort (`packages/browser-utils/src/fetch-transport.ts:9`, `DEFAULT_TIMEOUT_MS = 30_000`) multiplied by however many reports/uploads are pending. Browsers cap `waitUntil`; a promise still pending when the cap fires means the SW is killed with the event unresolved — and on `install` an unsettled extend-lifetime promise **fails the installation**, i.e. the customer's Service Worker never installs. The edge sibling's identical "never time-bounded" finding applies verbatim. A small explicit budget (`client.flush(2000)`) would remove the class.
- Mitigating: `uploadPipeline.flush` short-circuits `true` when `inFlight.size === 0` (`packages/core/src/upload-pipeline.ts:192-195`) and neither it nor `drainPending` can reject (both use `Promise.allSettled`) — so the *idle* case is a microtask and a rejected-waitUntil install failure is not reachable through `flush()`.

### 8. `withBugseeEvent` marks a **failed** async handler as a successful lifecycle promise
- **Where:** `packages/webworker/src/event.ts:37-43`
- **What:** the wrapper opts the handler's returned promise into the event lifetime (natively `addEventListener` ignores a listener's return value), but chains `.catch(…)` **before** `.then(() => client.flush())`, so the promise given to `waitUntil` always resolves. Used on `install`, an `async` handler whose cache population rejected is reported to the platform as a clean install: the SW activates with a half-populated cache and the site serves broken offline content.
- Bounded, because natively that rejection would not have reached `waitUntil` either — but the wrapper is what *introduces* the lifecycle coupling, so it owns the semantics. Re-throwing after capture (or passing `result` through untouched alongside a separately-chained flush) preserves the host contract.

### 9. Privacy — URL query strings are never scrubbed, and an SW captures other origins' URLs
- **Where:** `packages/capture/src/network-provider.ts:31-46` (`sanitize` rebuilds only `custom.headers` and `custom.body`; the event's top-level `url` passes through untouched), reached from `packages/webworker/src/launch.ts:299`
- **What / Why it matters:** header redaction and Content-Type-aware body scrubbing do apply on the SW path (default sanitizer on — `network-provider.ts:80-83`), and the body master-toggle/size gate runs before the filter (`:62-78`) — that part is fine. But credentials in the **query string** (`?token=`, `?api_key=`, S3 presigned `X-Amz-Signature`, OAuth `?code=`) are recorded verbatim. In a page that is the page's own traffic; in a Service Worker proxying `fetch(event.request)` it is **every request the site makes, to every origin**, so the exposure surface is qualitatively larger than the already-confirmed `@bugsee/capture` credential-leak finding. Nothing in this package narrows it, and it ships on by default with `captureNetwork`.

### 10. No flush on the detection path — a crash detected outside a wrapped event depends entirely on `persist`
- **Where:** `packages/webworker/src/launch.ts:304-307` (providers added; nothing flushes on detection), inherited from `@bugsee/browser`'s "ZERO page-lifecycle flush"
- **What:** a `self` `error`/`unhandledrejection` in an SW submits a report and returns; delivery is a fire-and-forget upload. If the SW goes idle it is terminated mid-upload. With `persist` ON (the SW default *when `platformType` was passed*) the durable queue plus marker/chunk recovery reconstruct it on the next activation — that path works. With `persist` OFF (a Web Worker, or **any SW hit by SEV1 #1**) the crash is simply lost. The asymmetry is undocumented.

## SEV3

### 11. Stale documentation contradicting the shipped code (#165)
- **Where:** `packages/webworker/src/launch.ts:70-71` ("Remaining follow-up: persisting the ROLLING capture buffer across activations"), `packages/webworker/src/index.ts:3` ("memory-only (IndexedDB persistence is a follow-up)"), `packages/webworker/README.md:47-48` ("**Remaining follow-up:** persisting the *rolling* capture buffer across activations … only relevant for the rarer cross-activation case")
- All three are false: `launch.ts:193-194` + `:201-209` + `:251-267` + `:324-346` implement exactly that. A user reading the README will believe cross-activation capture is lost and will not enable/trust it.

### 12. The worker bundle imports the DOM-ful `@bugsee/browser` **root**
- **Where:** `packages/webworker/src/launch.ts:1-5` — imports two providers from the package root, whose index (`packages/browser/src/index.ts`) re-exports `viewtree`, `input-source`, `interaction-source`, `system-events`, `component-name`, `meta-trace` and `launch`
- Runtime-safe (verified below), but keeping DOM code out of the shipped worker bundle relies entirely on `"sideEffects": false` tree-shaking; `@bugsee/browser` publishes no subpath export that would allow deep-importing just `detection-providers`. `@bugsee/replay` / `@bugsee/replay-canvas` are reached only through `import()` expressions inside `browser/src/launch.ts:454`/`:460`, i.e. inside a function this package never calls.

### 13. SDK cold-start work sits alongside the SW's critical path
- **Where:** `packages/webworker/src/launch.ts:201-209`, `:314-318`, `:324-346`; `packages/browser-utils/src/coexistence.ts:180-190` (`keyed.keys('')` — a full key scan of the capture DB across **all** instance prefixes)
- Every SW cold start re-runs `launch()`: opens up to three IndexedDB databases, hydrates the bundle store (`loadAll()`), acquires a Web Lock, scans every capture key, and recovers each dead sibling. It is all async and never blocks `respondWith`, but it contends for IDB precisely while the browser is holding the page's first request on SW startup, and the scan cost grows with the number of unreclaimed prefixes (see SEV1 #5).

### 14. `withBugseeEvent` on `fetch` flushes on every request
- **Where:** `packages/webworker/src/event.ts:45`; the README's only example (`README.md:33-35`) wraps `fetch`
- Idle cost is a microtask (`upload-pipeline.ts:192-195` short-circuits), so this is not pathological lifetime extension. But while *any* report is in flight, **every** concurrent fetch event's `waitUntil` is chained to the same drain, so a slow upload holds N events open simultaneously.

### 15. Test-suite gaps beyond the surviving mutations
- `packages/webworker/src/launch.test.ts:159` — `baseOptions` sets `captureNetwork: false` for **every** launch test. The network capture path (the SW's largest data source and its entire privacy surface) has **zero** coverage in this package.
- No test wires `withBugseeEvent` to a real launched client — `event.test.ts:5-9` uses a two-method fake, so the flush→drain→upload composition across `event.ts` and `launch.ts` is never exercised.
- No test covers `waitUntil` throwing, `flush()` rejecting/hanging, or a `flush` that has not settled.
- Recovery state is seeded through the real chunk-backend writer (`launch.test.ts:217-247` — better than hand-built IDB rows, and it does catch ordering: dropping `await markers.whenReady` fails 2 tests), but never by an actually interrupted run; termination is modelled only as "a prefix exists whose lock is free".

## Service Worker lifecycle matrix

The SDK registers **no** SW lifecycle listeners of its own (verified: no `addEventListener('fetch'|'install'|'activate'|…)`, no `skipWaiting`, no `clients.claim` anywhere in `packages/`). `withBugseeEvent` is opt-in, per-handler, and event-type-agnostic — the developer must wrap each one.

| event | `waitUntil` used? | promise actually passed? | time-bounded? | what is lost / risk | file:line |
|---|---|---|---|---|---|
| `install` | only if the developer wraps it | yes (`client.flush()`) | **no** | unsettled at the browser cap ⇒ **installation fails**; a rejected async handler is masked as success (SEV2 #8) | `event.ts:37-45` |
| `activate` | only if wrapped | yes | **no** | same unbounded-promise exposure; activation is not aborted by rejection | `event.ts:37-45` |
| `fetch` | only if wrapped (the README's example) | yes | **no** | flush per request; concurrent events chained to one drain (SEV3 #14). Response path untouched — the wrapper never sees `respondWith` | `event.ts:31-45`, `README.md:33-35` |
| `push` | only if wrapped — **undocumented** | yes | **no** | unwrapped ⇒ an incident captured during a push can be killed before upload; recovered next activation **only if `persist` is on** | `event.ts:27` |
| `sync` / `periodicsync` | only if wrapped — undocumented | yes | **no** | same | `event.ts:27` |
| `notificationclick` / `notificationclose` | only if wrapped — undocumented | yes | **no** | same | `event.ts:27` |
| `message` (`ExtendableMessageEvent`) | only if wrapped — undocumented | yes | **no** | same; wrapping a **non**-extendable `message` (dedicated worker) hits SEV2 #6 | `event.ts:11-13` |
| global `error` / `unhandledrejection` | **no** — no flush at all | n/a | n/a | fire-and-forget upload; survives only via the durable queue (SEV2 #10) | `launch.ts:304-307` |

## SW-termination data-loss analysis

**Survives an unannounced terminate + restart (only when `platformType:'service-worker'` or `persist:true` was passed):**
- Assembled bundles already handed to the durable queue — persisted before upload, re-uploaded by `durable.recover()` on the next launch (`launch.ts:314-318`), and by dead-sibling recovery for prior instances (`launch.ts:324-346`). Test: `launch.test.ts:586-596`, `:606-635`.
- Report **markers** — written synchronously into the mirror at submit time (`core/src/client.ts:455-466`) and persisted through asynchronously (`browser-utils/src/idb-report-marker-store.ts:52-57`).
- Capture **chunks** that the write queue has already landed — `recoverReports` rebuilds the incident from them on the next launch (`launch.ts:328-343`). Test: `launch.test.ts:323-342`.

**Lost:**
- Everything still in the chunk backend's queue. Writes are **sync-issue / async-complete** — `packages/browser-utils/src/idb-chunk-backend.ts:22-23` and `:91-95` (`queue = queue.then(op).catch(onError)`), `:170-176` (`appendEntry` → `enqueue(store.put(...))`). So the binding "durable-as-captured" rule is in practice **durable-as-*queued***: an unannounced terminate drops the queue tail, and with one op in flight at a time (the confirmed browser-utils back-pressure finding) the tail can be long under load — which is exactly the most recent, most incident-relevant capture.
- **Everything**, when `platformType` was not passed (SEV1 #1): memory store, no markers, no durable queue.
- Anything the browser evicted, and anything belonging to a dead prefix that Web Locks could not reclaim (SEV1 #5).

**Idempotency across repeated restarts:** each launch mints a fresh `instanceId`, so a restarted SW sees its own previous activation as a plain dead sibling — recovery is naturally re-entrant and self-terminating, and the marker is swept after delivery (asserted: `launch.test.ts:341`, `:366`). It is **not** exactly-once: if the SW is killed after the upload lands but before the marker is removed, the next activation re-delivers the same incident. That is the design's accepted trade (`web-lock-liveness.ts:56-59` — "siblings may double-recover its bundles, which the server dedupes by signature"). A capture-only dead prefix with no marker is swept without uploading (`launch.test.ts:373-392`).

## DOM-less verification

- **Imported from `@bugsee/browser`:** only `createUnhandledRejectionProvider`, `createWindowErrorProvider`, and the `WindowEvents` type (`launch.ts:1-5`) — but from the package **root**, so the whole index module graph is evaluated (SEV3 #12).
- **Empirical:** `vitest.config.ts:7` sets `environment: 'node'` — no `window`, no `document`, no DOM constructors — and all 43 tests import `./launch` (hence `@bugsee/browser`'s full index) and pass. Module evaluation of the DOM-ful browser tier is therefore proven side-effect-free in a DOM-less realm.
- **Static:** `grep -rn '\bwindow\b|\bdocument\b|localStorage|sessionStorage|HTMLElement|MutationObserver' packages/webworker/src` → only two hits, both in prose comments (`environment.ts:5`, `launch.ts:106`). `environment.ts:24-33` reads only `navigator` (`userAgent`, `deviceMemory`, `hardwareConcurrency`) plus `Intl`/`Date` — all present in Worker and ServiceWorker scopes; no `screen`, deliberately.
- **The one bare-`window` reference on the reachable path is inert:** `packages/browser/src/detection-providers.ts` declares `createWindowErrorProvider(win: WindowEvents = window)`. A default parameter is evaluated only when the argument is `undefined`; `launch.ts:304-306` always passes `scope`, inside an `if (scope !== undefined)` guard. So the `window` identifier is never resolved in a worker. (A future caller that omits the argument would `ReferenceError`.)
- **Replay:** `@bugsee/replay`/`@bugsee/replay-canvas` are neither dependencies of this package nor statically imported by `@bugsee/browser`; they are reached only via `import()` inside `browser/src/launch.ts:454`/`:460`, which this package never invokes. Not reachable at runtime.
- **IndexedDB in a worker:** available in both Worker and ServiceWorker scopes; the tests exercise the real IDB code against `fake-indexeddb` (`launch.test.ts:1`, `:37`).

## Web Locks availability

`navigator.locks` (`WorkerNavigator.locks`) is exposed in Window, Dedicated/Shared Worker and **ServiceWorker** scopes in Chromium, Firefox and Safari ≥ 15.4, so on the mainline SW path the liveness mechanism is live and `coexistence.ts:125` picks it up with no injection needed. `packages/webworker/src/launch.ts:143` also exposes a `locks` injection seam.

**When absent** (Safari < 15.4, or a context where `navigator.locks` is not exposed): `createWebLockLiveness(undefined)` returns the degraded shape — `available:false`, `holdSelf` warns once, `recoverIfDead` resolves immediately (`web-lock-liveness.ts:38-49`). Consequences, in order of severity: (1) **no dead-sibling recovery at all** — a prior activation's incident is never rebuilt or delivered; (2) **no sweep** — its capture chunks, markers and bundles are never deleted, so origin storage grows per activation forever (SEV1 #5); (3) the warning itself is dropped unless the caller passed `onError` (`coexistence.ts:124-127`). The instance's *own* incidents still upload normally, so the degradation is invisible in the dashboard.

## Inherited browser-utils defect behavior in a SW

- **Torn record kills a generation** (`idb-chunk-backend`): the impact is *narrower* in an SW than in a page in one respect — each SW activation is its own generation — and *wider* in another: for a Service Worker the affected generation is the entire captured history of the crashed activation, which is precisely the payload `recoverReports` exists to deliver. One bad record ⇒ that activation's incident arrives empty or not at all. Dead-sibling recovery reads the sibling with `cleanOtherGenerations: false` (`launch.ts:334`), so a poisoned generation is not purged as a side effect — mutating that flag to `true` fails 2 tests, so the intent is pinned.
- **Write queue with no back-pressure** (`idb-chunk-backend.ts:91-95`, `:170-176`): in an SW this converts directly into the termination data loss described above — the queue is the exact window in which capture is *not yet* durable, and there is no way to force a drain before the browser kills the worker (no API surface for it, and nothing in `withBugseeEvent` drains capture — it drains *uploads*).
- **Orphaned capture never reclaimed without Web Locks:** see SEV1 #5 — an SW restarts far more often than a tab reloads, so it accumulates orphan prefixes far faster.
- **The documented `pagehide` flush does not exist:** correctly irrelevant here — there is no `pagehide` in a worker, and this package does not claim one (`launch.ts:62`). The *replacement* an SW needs is `waitUntil`, which exists but is opt-in per handler and untested (SEV1 #4).

## What cannot be verified without a real Service Worker

1. Real termination semantics — how much of the IDB write queue actually lands when Chrome/Firefox/Safari kill an idle SW, and therefore the true size of the loss window.
2. Browser `waitUntil` caps (per-event and total) and what a promise pending at the cap does to `install`/`activate` in each engine — the SEV2 #7 exposure is reasoned from spec/engine behavior, not measured.
3. Whether `event.waitUntil` throws `InvalidStateError` in any path this wrapper actually takes (SEV2 #6 is demonstrated for the non-extendable-event case by reading the code, not by dispatching a real event).
4. Real `navigator.locks` behavior in an SW under teardown (whether the probe can reject there, which is the trigger I injected for SEV1 #2 — the rejection *handling* defect is proven regardless of trigger).
5. `Response.clone()` memory behavior under a real streaming download through a real SW (SEV1 #3 is derived from tee semantics + the code path).
6. Cold-start latency impact of the launch-time IDB work on the first `fetch` event (SEV3 #13).
7. Cross-activation end-to-end recovery driven by a genuinely killed worker rather than by a seeded prefix.
8. `xhr`/`sse` self-skip behavior in a real SW scope (no `XMLHttpRequest`/`EventSource` there) — asserted only structurally.

## Checked and found clean

- **Host `fetch` is not swallowed or altered.** The SDK registers no `fetch` listener, never touches `respondWith`, and `withBugseeEvent` calls the handler first and only then attaches `waitUntil` (`event.ts:33-45`). The fetch interceptor returns the original response untouched (`fetch-interceptor.ts:245-249`) and restores the original global on deactivate (`fetch-interceptor.ts:302-306`).
- **`captureNetwork: false` really does leave `globalThis.fetch` unpatched.** `installNetworkCapture` constructs interceptors but the patch is installed only on activation, and activation is subscriber-presence driven (`core/src/interceptor-base.ts:6-13`, `:35-38`); the provider's `controllingOption` is `CaptureNetwork` (`network-provider.ts:48`) so it never subscribes when disabled.
- **No interference with `skipWaiting`/`clients.claim`/Cache Storage** — none referenced anywhere in `packages/`.
- **The Web-Worker path does not initialize the SW-only durable machinery.** `persist=false` ⇒ `coexisting=false` ⇒ no lock held, `recoverDeadSiblings` returns immediately (`coexistence.ts:129-130`, `:135-137`); the store is `createMemoryCaptureStore` (`launch.ts:267`). Asserted at `launch.test.ts:258-261`, `:570-573`. Conversely `captureStore`/`bundleStore` overrides correctly bypass the durable layer (`launch.ts:193`, `:205`) — mutating `durableCapture` to ignore the override fails a test.
- **Multi-instance scoping holds and a LIVE sibling is never swept** — end-to-end for both bundles and capture/markers (`launch.test.ts:344-371`, `:637-667`), including that the live sibling's marker *and* capture generation are untouched.
- **`x-bugsee-internal` self-isolation** is applied to every SDK request (`launch.ts:152-155`); dropping it fails a test.
- **Singleton semantics:** repeat `launch()` returns the first client and reports via `onError` (`launch.ts:165-171`, tested `launch.test.ts:669-676`); `stop()` clears the carrier slot (`launch.ts:349-357`).
- **Environment envelope** is correctly the browser envelope minus `screen`, with `navigator`-derived cpu/memory only when defined (`environment.ts:56-89`); fully covered by `environment.test.ts`.
- **`launch()` never throws** on the durability path — coexistence failures route to `onError`/`warn` rather than aborting startup (the escape is the *rejection* path, SEV1 #2, not a synchronous throw).
- **Gates:** `pnpm --filter @bugsee/webworker exec tsc --noEmit` clean; 43/43 tests pass; coverage 100% statements / 100% branches / 100% functions / 100% lines (which is exactly why SEV1 #4 matters).
- **Working tree:** all mutations reverted from a `cp` backup and the temporary probe test deleted; `git status --short packages/` is empty.
