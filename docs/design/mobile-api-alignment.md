# Aligning the JS SDK public API with the mobile SDKs

Status: **Implemented** (T1-T9 landed and went through two multi-agent review rounds, 2026-10-12; findings in
`docs/review/mobile-alignment-round-1.md` and `-round-2.md`). What is NOT built is listed under "Remaining mobile gaps". Source: a read-only comparison of the Android (`android/sdk`, `Bugsee.java`,
`OptionsDescriptors.java`), iOS (`BugseeLib/Bugsee.h`, `BGSOptionsDescriptors.m`) and JS public surfaces. The mobile
SDKs are the parity target (CLAUDE.md, "Android-canonical"). Where the web genuinely differs, the difference stays and
is documented under "Kept differences".

## Tasks

Each task is test-first with the mutator loop, keeps the coverage gate, and lands as its own commit.

| ID | Task | Mobile reference | Notes |
|---|---|---|---|
| T1 | Wire `ReportHandler.after`; add `setLifecycleEventsListener` with the mobile event set (Launched, Stopped, BeforeReportShown, AfterReportShown, BeforeReportUploaded, AfterReportUploaded, ReportUploadFailed, ReportUploadFailedWithFutureRetry, BeforeReportAssembled, AfterReportAssembled, ReportAssemblyFailed, BlackoutStarted, BlackoutEnded) | Android `LifecycleEvents`, iOS `BugseeLifecycleEventType` | **Done.** `after` was typed and never invoked; it now runs (also on the injected trigger-pipeline path). |
| T2 | Facade cleanup: type `performanceUploadMode`; `startTransaction` / `startSpan` / `getActiveSpan` on the `Bugsee` object; stop exposing `UploadOptions.trigger` and `Mechanism` publicly | `Bugsee.startTransaction`, `startSpan`, `getActiveSpan` | **Done.** Internals keep working through `asInternalClient`. |
| T3 | Attachments: a public attachment type and `report.attachments` writable from `ReportHandler.before`; iOS limits (3 files, 3 MB each; JS applies these); Android has no byte limit but caps a report at 1000 attachments (`IssueReport.MAX_ATTACHMENTS`, a runaway-loop guard that JS does not need); bundle assembler includes them | `Report.addAttachment`, iOS `BugseeAttachment` | **Done.** The report field is `userAttachments` (`addReportAttachment(report, input)` is the helper form). |
| T4 | Blackout: `startBlackout` / `endBlackout` / `isBlackout`; suspends replay, input and viewtree capture while logs and network continue | `Bugsee.startBlackout` | **Done.** Emits the T1 events. |
| T5 | Launch state: `getStatus()` with the Stopped/Launching/Launched/Stopping enum, `relaunch(options?)`, `getLaunchOptions()`, `getHostLaunchOptions()`; verify launch → stop → launch works | `getStatus`, `relaunch`, `getLaunchOptions` | **Done.** See "Kept differences" for the relaunch semantics. |
| T6 | Missing options: `captureLogsLevel`, `captureBreadcrumbs`, `detectHttpErrors`, `captureNetworkDefaultSanitizer`, `reportDefaultCrashPriority`, `reportDefaultErrorPriority`; `getDefaultNetworkSanitizer()` so a custom filter can reuse the default redaction | `OptionsDescriptors` keys under `com.bugsee.option.*` | **Done.** Canonical keys already existed for some. |
| T7 | `notify(title, body?, severity?, fields?, urgent?)` | `Bugsee.notify` | **Done.** The collector already accepts it from a browser; see "T7 findings" |
| T8 | `logException` options: `domain`; check what `mergingRules` does on iOS | Android `ExceptionOptions.Domain`, iOS `BugseeExceptionLoggingOptions` | Done: `domain` + `skipFrames` (see T8 findings) |
| T9 | Browser: persist the user identifier across page loads, as iOS and Android do (Android keeps it in `BugseeEnvironment`'s global preferences under `user_identifier`) | iOS / Android `setUserIdentifier` | **Done**, storage-failure tolerant, and **opt-in** (`persistUserIdentifier`): the identifier is often an e-mail (PII) and a browser may be shared. |

## Options added by T6

Launch options (all runtimes through `COMMON_OPTION_DEFINITIONS` in `@bugsee/core`; sent in `sdk.options`
dots-to-colons like every other option). `detectHttpErrors` is wired wherever network capture is installed: browser, node (so Bun, Deno and the umbrella), web worker, WebView, Vercel Edge and Cloudflare.

| Friendly | Canonical (`com.bugsee.option.` + ...) | Default | Notes |
|---|---|---|---|
| `captureLogsLevel` | `capture.logs.level` | `'verbose'` | Console and `client.log()` records less severe than the level are dropped before the log filter. |
| `captureBreadcrumbs` | `capture.breadcrumbs` | `true` (mobile: `false`) | `false` drops every breadcrumb: `addBreadcrumb`, the UI ones and adapter ones. See Kept differences. |
| `detectHttpErrors` | `detect.http-errors` | `false` | fetch / XHR / `node:http` **5xx** responses (Android `BugseeDetectionHttpError`, iOS `BGSDetectionProviderHttpError`) file an `error` report with mechanism `http-error`, once per session per (method, templated URL, status). Severity `high` (explicit, so `reportDefaultErrorPriority` does not override it), domain `HttpError::Server`, attributes `http_status_code` / `http_method` / `http_url` / `http_status_text`; the text is only `HTTP <status> <statusText>`. 4xx, transport failures and aborted requests are never reported. See Kept differences. |
| `captureNetworkDefaultSanitizer` | `capture.network.default-sanitizer` | `true` | Friendly name for the existing key. A network filter still replaces the default; see `getDefaultNetworkSanitizer()`. |
| `reportDefaultCrashPriority` | `reporting.defaults.crash-priority` | `'blocker'` | Severity of a crash report that was given none. |
| `reportDefaultErrorPriority` | `reporting.defaults.error-priority` | `'high'` | Same for error reports (`logException`, unhandled rejections). NOT for http errors: those carry an explicit `high`. |

An explicit per-call severity (`logException(e, { severity })`) and a report handler's edits win over the default.
Native-crash recovery (Electron) builds its report outside the client and keeps `blocker`.
An option passed as `undefined` counts as not supplied (the default applies; `captureNetworkDefaultSanitizer: undefined`
keeps the redaction ON). The default sanitizer is turned off ONLY by an explicit boolean `false`. A value of the wrong
type (a non-boolean toggle, an unknown log level or priority name) is reported through `onError` and the default
applies; **the library never logs, so without an `onError` the fallback is silent.** `captureLogsLevel` also accepts
the integer levels 1-5 (1 = error ... 5 = verbose). The value in effect (trimmed, lower-cased, integers mapped to
names) is what `sdk.options` and `getLaunchOptions()` carry, not the raw input.

`getDefaultNetworkSanitizer()` (exported from `@bugsee/capture` and the `@bugsee/bugsee` entries) returns
`{ sanitize, sanitizeUrl, sanitizeErrorMessage }`, the same object the built-in sanitizer uses. Call it from inside a
`setNetworkEventFilter` filter to keep the default redaction.

## T8 findings

Investigated 2026-10 against Android `library/.../reporting/exceptions/`, iOS `BugseeExceptionLoggingOptions.h`,
`BGSCrashReport.m`, and worker `crash/{android,apple,javascript}.py`, `crash/managed/common.py`.

- **`domain`** (Android `ExceptionOptions.Domain = "domain"`, iOS `exceptionDomain`): a short issue-organising
  category. Android writes it as `exception.domain` in crash.json (`ExceptionSerializer`); iOS as the error `domain`.
  The worker folds it into the grouping signature (`android.py:175-179`, `apple.py:370`: "reports with the same
  domain and stack trace group together") and prefixes the issue summary with `[domain]` (`android.py:251-268`, capped
  at 150 chars). **Gap:** JavaScript crashes go through `crash/managed/common.py:get_crash_signatures`, which does not
  read `domain`, and `javascript.py:530` builds its own summary. The SDK now sends `exception.domain` (the Android wire
  shape); it has no grouping or summary effect until the worker's managed path reads it. Not verified against a
  running backend.
- **`skipFrames`** (Android `ExceptionOptions.SkipFrames`, iOS `mergingRules[BugseeMergingRulesSkipFramesKey]`):
  skips N top frames when computing the crash location/signature; frames stay in the report. Android applies it
  client-side in `ExceptionSignature`; the worker also reads `exceptionLoggingOptions.mergingRules.skipFrames`
  (`android.py:111,248`, `apple.py:301,439`), but not on the managed/JS path. JS equivalent: the top N frames of the
  outermost exception get `hidden: true`, which `managed/common.py:_get_crash_location` already skips. Same
  semantics, no worker change, trace still shows them. Implemented.
- **`mergingRules`**: a dictionary whose only key is `skipFrames`. Not added as its own option; `skipFrames` is the
  flat equivalent (Android's map already uses the flat key).
- **`includeVideo`**: forces a video-less report. Not applicable: JS has no video; replay is governed by the
  `replay` launch option. Kept difference.
- Invalid values (empty/non-string `domain`, non-integer or negative `skipFrames`) are ignored and routed to `onError`.

## T7 findings: `notify()`

Read from Android (`library/.../relay/*`, `BugseeInternal.notify`), iOS (`BGSNotificationRelay*`, `Bugsee.h`) and the
appserver (`code/components/app/notification-relay/*`, `code/routing/routes/api/v2.routes.js:116-124`,
`config/default.js` `web.cors.public`).

**What it is.** A message relayed to the app's configured messaging integrations (Slack, webhooks, ...) by the
collector. It never enters the report pipeline: no video, logs or events, no issue, no bundle upload.

**Endpoint.** `POST {api}/v2/notifications`. Body `{ "app_token": "...", "notifications": [ item, ... ] }`; iOS also
sends `access_token` when it has one, Android authenticates through its session instead. The server needs neither:
`resolveOrgAndApp` (`notification-relay.service.js:~118-150`) takes the app from `body.app_token`, then `?app_token=`,
then a session. No access token and no `/v2/sessions` call are needed, so `notify()` works before the first report.

**Item** (`RelayNotification`, identical on both platforms; the server's `sanitizeItem` keeps exactly these keys):
`id` (client UUID, the dedup and status key), `timestamp` (ms), `title` (required), `body`, `severity` (1 to 5, the same
numbers as report severity), `fields` (string to string), `urgent` (true only), `delivery` (`immediate` or `deferred`,
stamped when it is sent), `user`, `environment`, `attributes` (snapshots taken at the call). `user` is `{ email: <user identifier> }`, as Android
sends it: the integrations read only `name` / `email` from it, so the earlier `{ id }` shape was invisible to them.
An item without an `id` or a non-empty `title` is `invalid` server-side.

**Response.** `{ ok: true, result: { notifications: { <id>: accepted | skipped | invalid | failed } } }`.
`failed` means the enqueue failed and the item should be sent again; the other three are final. `429 QuotaExceeded`
(`retryAfter`), `503 ServerTooBusy` (version blacklist), `401 InvalidAppToken`, `403 KillSdk`, `400 InvalidBatch`,
`500 EnqueueFailed` (with the per-item map). If relay is switched off for the app the server still answers
`accepted`, so the SDK drops the batch rather than retrying forever.

**Browser access (the question this task was blocked on): yes, it works.**
- `v2.routes.js:116-124` puts `middleware.common.publicCors` on `/notifications`, the same policy as `POST /sessions`:
  origin `*`, no credentials, methods `POST, OPTIONS`, preflight answered by the route.
- Allowed request headers (`config/default.js:249-253`): `origin, content-type, accept, authorization, x-app-token,
  x-client-type, x-bugsee-internal, x-tid`. The JS SDK's headers (`content-type`, `accept`, `x-client-type`,
  `x-bugsee-internal`, `x-app-token`) are all inside it, and the browser tier sends no `user-agent`.
- No application-type check on this route: `utils.isValidForClient` runs only in `session.service.js:979` and
  `issue.service.js:1131`. A `javascript` application (`x-client-type: javascript`) is therefore fine, and so is any
  other type.
- Authentication is the app token, which a browser SDK ships in the page anyway; the abuse limiter is the server's
  (`notification-relay.limiter.js`, unlimited in v1).
- Nothing is needed from the backend.

**Mobile semantics reproduced.**
- No-op for an empty title, before `launch()`, after `stop()`, and when the SDK was killed.
- Batch limits 50 notifications / 256 KB; one notification at most 256 KB (dropped with an `onError` otherwise).
- Flush window `notifyFlushDelay` (`com.bugsee.option.config.notify-flush-delay`, default 0 ms). The first
  notification arms the window and later ones join it. Delivery is stamped `immediate` when the delay is 0 and
  `deferred` otherwise; an `urgent` notification skips the window and is sent alone, stamped `immediate`
  (Android `RelayNotification.flushDelivery`).
- Retry: network error, 408, 429, 5xx, or a per-item `failed` back off 2 s doubling to 60 s, keeping order. A 429
  `QuotaExceeded` carries `retryAfter` (seconds, body) which replaces the backoff for that retry (capped at 10 min).
  Other 4xx and a `{ ok: false }` envelope drop the batch (the error router answers HTTP 200 for a refusal). A
  `403` whose body is `{ error: 'KillSdk' }` switches the SDK off like a report's KillSdk verdict; an anonymous 403
  (a proxy) is only a rejected batch.
- After `stop()` or a kill the relay sends and retries nothing (`flush()` is a no-op, no backoff timer is re-armed);
  a re-launch resumes what was kept. The queue is bounded by count (1000), total size (1 MB) and age (72 h), oldest
  dropped first, like Android's relay storage.
- `fields` keeps only string values; severity is the report severity names.
- `client.flush()` and `client.stop()` deliver what is pending, so `await bugsee.stop()` before exit loses nothing.

**Kept differences.**
- The queue is **in memory**, not persisted. Mobile writes each notification to disk and a background job sends it
  after a restart. A page closed or a process killed with an unsent notification loses it. A durable queue would
  need its own IndexedDB / file store with multi-instance coexistence, which the bundle queue only gets through the
  per-instance prefix and liveness machinery, so it is not cheap. Use `urgent`, `flush()` or a short `notifyFlushDelay`
  where loss matters. The queue is capped (1000 items, 1 MB, 72 h; oldest dropped) and survives `stop()` then `launch()` on one page.
- Wired in `@bugsee/browser` and `@bugsee/node` (so Bun, Deno and the umbrella). The Vercel edge, web worker,
  Cloudflare and WebView entries compile `notify()` but have no sender, so it is a silent no-op there (the WebView
  also accepts `notifyFlushDelay` and ignores it; the native host owns delivery); an isolate that is frozen
  after the response would lose a queued message anyway.
- A rejected or oversize notification is reported through `onError`, never thrown.

## Kept differences (documented, not changed)

- **`detectHttpErrors` vs mobile.** Same: 5xx only, per-session de-duplication on (method, normalized URL, status),
  severity High, domain `HttpError::Server`, attributes, query/fragment/credentials stripped. Different:
  (1) path templating (`{id}`, `{uuid}`, `{hex}`, `{token}`, `{email}`) is ALWAYS on; Android applies it only when a
  network filter is configured, because the JS detector reads the raw event and an e-mail in a path must never reach
  a summary; (2) a 20-per-minute rate limit stays as a backstop behind the de-duplication (mobile has none), and the
  de-duplication set is capped at 1000 endpoints (past that, new endpoints are dropped); (3) both the `complete` and
  the `error` stage are accepted, like Android; an aborted request (`AbortError`, an aborted caller signal, ABORT_ERR)
  is emitted as an `abort` stage by the fetch and `node:http` interceptors, and a request with no HTTP status is never
  reported; a `req.destroy()` by the app cannot be told apart from a connection reset, so it stays an `error` stage
  (still not reported, because it has no status). Same on both: the grouping signature is carried as one synthetic crash.json frame (`HttpError.<METHOD> <url>
  <status>`), not a client-computed hash (Android `BugseeDetectionHttpError` does the same with `FRAME_CLASS =
  "HttpError"`); the worker's managed-JS path is not verified to group on it.
- **Electron renderer options.** `captureBreadcrumbs`, `captureLogsLevel`, `reportDefault*Priority` and
  `captureNetworkDefaultSanitizer` given to the MAIN process do not apply to data a renderer streams up, unless the
  renderer is launched with the same options. Forwarding them in the session handshake is a follow-up.
- **Wire options on the public client.** `UploadOptions.trigger` and `LogExceptionOptions.mechanism` are hidden by
  type AND stripped at runtime from the public `upload` / `logException` / `prepareUpload().send`, which stops
  accidental and untyped use. It is NOT a security boundary: code that can import `@bugsee/core` can call
  `asInternalClient`, or read the `Symbol.for('com.bugsee.internal-client')` brand off the client, and so can still
  file a report with `trigger: 'code_dialog'`. SDK packages reach the wire options through `asInternalClient`,
  which is no longer the same object as the public client (it is a copy carrying the unstripped methods). The
  `@internal` types remain in the published d.ts.

- `captureBreadcrumbs` defaults to `true`, not mobile's `false`: UI-interaction breadcrumbs (click / change / submit /
  focus) are a core web signal and were already always on. The option can now switch them off.

- `launch` is async in the browser (lazy-loaded extensions) and synchronous on Node.
- JS filters return a value; mobile filters take a callback.
- No native triggers (shake, screenshot, notification bar, broadcast), no video options, `Appearance` or `setWrapper`.
  Web uses replay, CSS masking, and per-call `strings` / `theme` / `css` on the dialog.
- `maxDataSize` per runtime (browser 10 MB, Node 50 MB). It is NOT the mobile option of the same name:
  JS `maxDataSize` is `config.data-size`, the size of the rolling in-memory/on-disk CAPTURE buffer that becomes the
  report. Mobile `config.max-data-size` (Android default 150, iOS 50, in MB) is a disk cap on reports WAITING to
  be sent, evicting whole pending reports (errors, then bug reports, then crashes, oldest first). The JS
  equivalent of that is not built (see "Remaining mobile gaps": `MaxPendingReports` / `MaxPendingReportAge`).
- **`relaunch()` semantics.** JS `relaunch()` after `stop()` starts a new client again (Android: `relaunch()` when
  the SDK is not started is a logged no-op, so a stopped Android SDK stays stopped). Before any `launch()` JS
  rejects (Android logs a warning and returns). Everything else follows mobile: Bugsee options return to their
  defaults, integration seams and the deployment identity are kept (see `RELAUNCH_KEPT_OPTIONS`, which stay
  referenced from the process carrier after the client is gone).
  Each package's `relaunch` re-runs THAT package's launch (e.g. `@bugsee/nextjs/server` re-runs `registerServer`
  so the OTel default-attach is re-applied; the plain umbrella `@bugsee/bugsee/node` `relaunch` would not).
  `@bugsee/webview` and `@bugsee/electron` offer none: the WebView carrier holds only a facade (native owns the
  session) and Electron's launch needs `ipcMain`.
- **JS-only launch keys** with no mobile counterpart: `startInBlackout` (`capture.start-in-blackout`),
  `persistUserIdentifier` (`user.persist-identifier`) and `lifecycleEventsListener` (mobile registers its listener
  through `setLifecycleEventsListener` only; the option exists so Launching/Launched are observable, since a
  listener set after `launch()` misses them).
- **`startBlackout()` before launch** is a no-op, as on Android (`BugseeInternal.startBlackout` logs a warning and
  returns unless the SDK is started); use `startInBlackout`. **`endBlackout()` before launch (or after `stop()`) is
  a KEPT DIFFERENCE:** Android no-ops, JS clears the carried process-wide blackout flag silently, because the flag
  outlives a client and an app that stopped during a blackout must be able to lift it (otherwise the next launch
  starts dark with no event). See `blackout.md`, State rules.

## Remaining mobile gaps (no JS equivalent yet)

Verified 2026-10-12 against `android/sdk/library/.../Bugsee.java` and `contracts/options/Options.java`; a
`grep` of `packages/*/src` finds none of these. Not part of the alignment tasks above; recorded so they are
decisions, not oversights. `deleteCollectedDataOnDevice` is the one to decide on next (privacy).

APIs:
- `deleteCollectedDataOnDevice(includingIntermediate, listener)`: erase everything collected on the device
  (privacy / right-to-erasure). JS stores in IndexedDB / files; needs a store-level wipe plus the in-flight uploads.
- `addNetworkEvent(networkEvent, requiresFiltering)`: feed a network event the SDK did not intercept.
- `logUnhandledException(ex, options)`: file an exception as an unhandled one (JS has `logException`, which is
  handled; unhandled ones come from the global handlers).
- `testCrash()`: force a crash to verify the integration.
- On-demand `captureViewHierarchy()`: JS has the `captureViewHierarchy` launch option (report-time snapshot) but
  no call to capture one now.
- Runtime secure-view / secure-rectangle APIs (`addSecureActivity`, `addSecureRectangle`, `removeSecureRectangle`,
  `removeAllSecureRectangles`, `getAllSecureRectangles`): JS masks with replay options and CSS (and the WebView
  obscuring channel), not by registering rectangles at runtime.

Options (`com.bugsee.option.` + ...):
- `config.max-pending-reports`, `config.max-pending-report-age` (Android defaults 30 and 30 days) and mobile's
  meaning of `config.max-data-size` (disk cap on pending reports; see Kept differences).
- `detect.early-crash`, `detect.anomaly`, `detect.frustration` and the `detect.exit.*` family (exit reasons:
  low memory, not responding, excessive resource use, ...).
- `capture.logs.allsources` (all log sources, not only the app's), `capture.network.on-launch` (network capture
  from before launch), `capture.breadcrumbs.extras`.
- `performance.adaptive-sampling` (Android default on).

## Open decisions (not delegated)

- **Performance sample rate:** mobile defaults to 0.01, JS to 1.0. Lowering JS cuts web-vitals volume to 1%.
- **Hang detection:** off by default on mobile, on by default on Node.

## Process

One Sonnet agent per task, each in its own git worktree, merged into `main` one at a time. A task is done when the
gates pass (`pnpm lint`, `pnpm typecheck`, `pnpm check:cycles`, per-package coverage) and the diff has been reviewed.
