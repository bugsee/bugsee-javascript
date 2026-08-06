# Adversarial review — @bugsee/protocol

**Reviewed:** 2026-07-26 · **Scope:** `packages/protocol` (impl 777 LOC across 8 files, of which ~382 lines are *executable* code and ~192 are pure type declarations; tests 1069 LOC = 749 runtime + 320 type-level)

**Verdict:** The package itself is small, clean, portable and unusually well tested for what it *does* — 100 % line/branch/function coverage is real (not theatre), the dot→colon option rule is byte-for-byte correct against both the Android emitter and the appserver's server-side sanitizer, the Android FileType/NoBodyReason/option-identifier/severity/log-level constants match their Android counterparts exactly, and the sanitizer suite resisted 9 of 11 targeted mutations. The serious problems are not *inside* the package — they are **translators this package provides that nobody calls** and **shapes this package declares that no downstream consumer can read**. Two of these produce silently wrong data in the Bugsee viewer today: `logs.json` ships `level` as a string name because `logLevelToWire` has zero callers anywhere in the monorepo (the viewer's level map is numeric-keyed), and every outbound WebSocket/WebTransport frame renders as "incoming" because the package models frame direction in a `direction` field that the viewer never reads, having dropped the Android-canonical `type:"websocket"` + `event:"send"` encoding that its own design doc §8.7 and the code comment on `wire.ts:98` claim it implements. A third (`environment.sdk.type`) is a genuine emitter/receiver disagreement whose fix belongs in the appserver. Test-strength gaps are concentrated in the two long denylist/identifier tables (20 of 27 sensitive headers and 6 of 17 canonical option identifiers survive deletion undetected). **Note on the brief:** the stated ratio (impl ~1097 / tests ~749, "lowest in the monorepo at 0.68:1") is an artifact of counting `wire.test-d.ts` (320 LOC of type tests) as implementation. The true ratio is **1069 : 777 = 1.38 : 1**, and measured against *executable* code alone (382 lines) the runtime tests are ~1.96 : 1. The low ratio is not a real signal; `wire.ts` is 170 LOC with **zero** executable statements.

---

## SEV1

### 1. `logs.json` ships `level` as a string name, not the numeric 1–5 wire value — `logLevelToWire` has zero callers

- **Where:** `packages/protocol/src/levels.ts:32` (`logLevelToWire`), exported at `packages/protocol/src/index.ts:16`
- **What:** This package exists to translate the public string level names to the mobile-compatible numeric wire values, and `logLevelToWire`/`LOG_LEVEL_BY_NAME` (`levels.ts:23-34`) do exactly that. **No consumer anywhere in the monorepo calls it.** The log path emits the raw string:
  - `packages/capture/src/console-interceptor.ts:24` — `const DEFAULT_LEVELS: Record<string, LogLevelName>` → `:98` `emit('log', { …, level, … })` emits `'error'|'warning'|'info'|'debug'`.
  - `packages/core/src/client.ts:544` — `log(message, level: LogLevel | LogLevelName = 'info', …)`, `:549` `const entry: LogEvent = { timestamp: ts, level, source: 'logger', message }`.
  - `packages/core/src/events.ts:11` — `level: LogLevelName | LogLevel`, i.e. the field is **polymorphic on the wire**: a string when it comes from the console interceptor or the default, a number when an app passes `LogLevel.Error`.
  - `packages/capture/src/log-provider.ts:41` — `this.capture('log', event.timestamp, event)` writes the `LogEvent` verbatim; `packages/core/src/bundle-assembler.ts:157` JSON-stringifies it into `logs.json`.
- **Why it matters:** The viewer maps this field through a **numeric-keyed** table: `viewer/src/app/core/constants/values/log-levels.constant.ts:2-8` = `{"1":"error","2":"warning","3":"info","4":"debug","5":"verbose"}`. `viewer/src/app/features/recording/elements/console/elements-recording-console.component.ts:201` filters with `row.level === this.$levelsMap[level.name]` — a string `'error'` never equals `1`, so **activating the console level filter hides every JS log row**. `viewer/src/app/features/recording/shared/helpers/downloads.ts:183` does `padEnd(ConstantsService.LogLevels[level], 7)` → `undefined` in the CSV/text export. Android is unambiguous here: `android/sdk/library/src/main/java/com/bugsee/library/capture/providers/log_system/BugseeCaptureDataEntryLog.java:107` writes `putKeyValue("level", targetLevel.getValue(), true)` and `android/sdk/library/src/main/java/com/bugsee/library/contracts/options/LogLevel.java:45` defines `Error((byte)1)`. `docs/design/sdk-design.md` §8.4 specifies `log` → `{timestamp, level (1-5), source, tag?, message}`.
- **Evidence:** `grep -rw logLevelToWire packages --include='*.ts'` → 0 hits outside `packages/protocol`. The uploaded-bundle e2e is the smoking gun: `packages/instrumentation-tests/test/instrumentation.e2e.ts:133` asserts `logs.some((l) => l.level === 'error' && …)` — i.e. the *real* SDK, booted in a real process against a mock collector, uploads the string. Verified the viewer constant and both viewer consumers by reading them; verified no string→numeric normalization exists anywhere in `viewer/src/app/features/recording` or `worker/jobs/*.py`.

### 2. WebSocket/WebTransport frame **direction** is unreadable downstream — `NetworkStage` diverges from Android, from `docs/design/sdk-design.md` §8.7, and from the viewer

- **Where:** `packages/protocol/src/wire.ts:98-114` (`NetworkStage`), `:126` (`NetworkDirection`), `:153-154` (`NetworkEvent.direction`)
- **What:** `wire.ts:98` comments the union as *"Network event stage values (**corrected to Android-canonical**, design §8.7)"*. It is not Android-canonical. Android's `NetworkEventStage` (`android/sdk/library/src/main/java/com/bugsee/library/contracts/exchange/NetworkEvent.java:229-236`) is `before|complete|redirect|error|abort|timing|**websocket**`, and connection sub-events go in a **separate `event` field** — `android/sdk/library/src/main/java/com/bugsee/library/capture/providers/network/BugseeCaptureDataEntryNetwork.java:200-201` emits `putKeyValue("event", webSocketEventType.getValue(), true)`. `docs/design/sdk-design.md` §8.7 specifies exactly that shape (`"type": … | "websocket"` plus `"event": null | "create" | "open" | "send" | "message" | "close" | "error"`). The implementation instead **dropped `websocket` and `event` entirely**, promoted `open`/`message`/`close` to top-level `type` values, and invented a sibling `direction: 'in' | 'out'`.
- **Why it matters:** In the Android/mobile encoding the direction *is* the event value — `message` = inbound, `send` = outbound. The viewer's frame builder relies on precisely that and never looks at `direction`: `viewer/src/app/features/recording/shared/recording-network-types.service.ts:16-24` `STAGE_TYPE_RENAME_MAP = { message: "incoming frame", send: "outgoing frame", … }`, and `:395-419 constructWebsocketFrames()` computes `const type = frame.event || (frame.type as RecordingNetworkWebsocketEventType)` before passing it to `RecordingNetworkWebsocketFrame` (`:39-51`), which does `this.type = STAGE_TYPE_RENAME_MAP[type] || type`. The JS SDK emits `type:'message'` for **both** directions — `packages/capture/src/web-socket-interceptor.ts:106` (`direction: 'in'`) and `:122` (`direction: 'out'`) — so **every outbound WebSocket/WebTransport frame is rendered as an incoming frame**, and inbound/outbound byte accounting is skewed with it.
- **Evidence:** Read the Android stage enum and serializer, the design §8.7 block, the JS interceptor, and the viewer builder. Confirmed the viewer *does* tolerate the flat-stage form for open/close/error (`recording-network-types.service.ts:177,181,185` — `event.event === "open" || event.type === "open"`), which is why this fails silently rather than loudly. Then confirmed the direction field has **no reader at all**: `grep -rn "\.direction\b|direction:" viewer/src --include='*.ts'` returns only an unrelated swipe directive; same for `sequence`, `channel`, `code`, `reason`, `customError` — all declared in `wire.ts:141,152,156,158,160` and read by nothing in either `viewer` or `worker`.

### 3. `environment.sdk.type: 'javascript'` — the backend's JS discriminator — is not a declared path in the appserver's Mongoose `EnvironmentSchema`

- **Where:** `packages/protocol/src/wire.ts:45-50` (`EnvironmentEnvelope.sdk: { version; type: 'javascript'; build?; options? }`)
- **What:** The protocol declares `sdk.type` **required**, and every platform emits it (`packages/node/src/environment.ts:91`, `packages/browser/src/environment.ts:96`, `packages/vercel-edge/src/environment.ts:51`, `packages/webworker/src/environment.ts:84`). The appserver's `EnvironmentSchema.sdk` subdocument declares only `build`, `version` and `options` — `appserver/code/components/shared/dao/models/_environment.js:145-151` — with **no `type` path**. Mongoose document `strict` is left at its default (`true`); only `strictQuery` is relaxed, at `appserver/code/components/shared/dao/index.js:7`. This schema is what persists both `session.environment` (`models/session.js:65`) and `recording.environment` (`models/_recording.js:23`).
- **Why it matters:** The worker's JS-crash routing reads the field back **from the persisted recording**, not from the uploaded `request.json`: `worker/jobs/bundle.py:477` `environment = recording.get('environment') or {}` (where `recording` comes from the `api.update_recording_with_issue` response at `:463,:476`), and `worker/jobs/bundle.py:210` `is_javascript = ((environment.get('sdk') or {}).get('type') == 'javascript')` selects `javascript.process_crash_report` vs `managed.process_crash_report` (`:222` vs `:224`). If the path is stripped at persist, every JS crash falls through to the managed processor. The appserver itself also reads it pre-persist at `appserver/code/utils.js:1128` for the per-runtime SDK version floor, so the field is genuinely load-bearing on both sides of the store.
- **Evidence:** Read `_environment.js` in full, confirmed `platform.type` is declared via Mongoose's `type: { type: String }` escape hatch (`:50-52`) while `sdk` has no equivalent; confirmed the git history of `_environment.js` (last JS-related touches are `feat(app): add the javascript umbrella application type (A0)` / `feat(symbols): route javascript apps…`, neither touching `sdk`); confirmed no global `mongoose.set('strict', …)`. **Caveat, stated plainly:** I verified this by reading the schema and its call sites — I did **not** execute Mongoose to observe the strip. **The protocol side is correct; the remediation belongs in the appserver, not in this package.** Flagged here because it is exactly the emitter/receiver field disagreement the review is meant to surface.

---

## SEV2

### 4. 20 of the 27 `SENSITIVE_HEADERS` entries can be deleted or typo'd with no test failing

- **Where:** `packages/protocol/src/sensitive.ts:10-38`; test at `packages/protocol/src/sensitive.test.ts:12-33`
- **What:** The header test pins only 7 distinct names (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-amz-security-token`, `x-ms-token-aad-refresh-token`). The other 20 — including `x-auth-token`, `x-csrf-token`, `x-forwarded-for`, `x-real-ip`, `authentication`, `x-amz-credential`, `x-amz-signature`, `x-goog-api-key`, `x-vault-token`, `x-shopify-access-token`, `x-clerk-session-token`, `x-supabase-auth`, `x-ms-token-aad-access-token`/`-id-token` — are unasserted. This is a striking asymmetry: the sibling list `SENSITIVE_KEY_SUBSTRINGS` **is** exhaustively pinned, and `sensitive.test.ts:46-49` even documents the reasoning for doing so.
- **Why it matters:** `sanitizeHeaders` (`sanitize.ts:17`) uses **exact** matching for headers: `isSensitiveHeader(name) ? REDACTED : redactShapes(value, options)`. A header silently dropped from the set falls through to `redactShapes`, which only matches JWT/AWS/Stripe/GitHub literal shapes — so e.g. a Vault or Shopify token would be uploaded in the clear. A privacy regression here ships green.
- **Evidence:** Four mutations run and reverted, each removing one entry from the set (`x-forwarded-for`, `x-vault-token`, `proxy-cookie`, `x-shopify-access-token`) — **all four SURVIVED** the full `pnpm --filter @bugsee/protocol exec vitest run`. Control mutation (`MANIFEST_VERSION = 2 → 3`) was **CAUGHT**, proving the harness. All source files restored from backups; `git status --short packages/protocol` empty.

---

## SEV3

### 5. Six canonical `BugseeOption` identifiers survive corruption undetected — four of them Android-canonical

- **Where:** `packages/protocol/src/options.ts:40,44,58,60,61,62`; test at `packages/protocol/src/options.test.ts:53-69`
- **What:** `options.test.ts` pins 11 of the 17 identifiers. Unpinned: `CaptureNetworkBodies`, `CaptureNetworkBodyWithoutType`, `DetectHang`, `DetectHangFairMs`, `DetectHangMediumMs`, `DetectHangSevereMs`. The `is namespaced + unique` test (`options.test.ts:71-75`) does not constrain the value. Because all 135 consumer references go through the `BugseeOption.X` symbol, a value change propagates *consistently* through the monorepo and is invisible to every other test too.
- **Why it matters:** The last four are byte-identical Android identifiers (`android/sdk/library/src/main/java/com/bugsee/library/contracts/options/Options.java:120,129,137,144`), i.e. cross-SDK on-the-wire identity in `environment.sdk.options`. A typo silently breaks server-side option correlation between the JS and Android SDKs — precisely the failure the test's own comment at `options.test.ts:51-52` says it is guarding against.
- **Evidence:** Four mutations run and reverted (`…network.bodies → …network.body`, `…body-without-type → …bodywithouttype`, `…detect.hang → …detect.hangs`, `…hang.level.fair → …hang.fair`) — **all SURVIVED**.

### 6. Three `DEFAULT_FILENAMES` entries are pinned by no test in the repo; two more only by consumer-package tests

- **Where:** `packages/protocol/src/constants.ts:35-51`; test at `packages/protocol/src/constants.test.ts:31-43`
- **What:** Mutating `screenshot: 'screenshot.png'`, `'events.system': 'events.system.json'` and `'traces.user': 'traces.user.json'` all **SURVIVED**, and a repo-wide grep finds those three literals nowhere outside `constants.ts`. Mutating `crash: 'crash.json'` and `viewtree: 'viewtree.json'` also survived the owning package's suite, but those two *are* pinned by consumers — `packages/core/src/bundle-assembler.test.ts:426` (`{ filename: 'crash.json', type: 'crash' }`), `packages/core/src/client.test.ts:1041`, `packages/browser/src/launch.test.ts:422`. The package that owns the wire contract should pin its own table.
- **Evidence:** Five mutations run and reverted; grep for each literal across `packages --include='*.ts'`.

### 7. `optionsToWire` silently drops a key on a dot/colon collision

- **Where:** `packages/protocol/src/options.ts:20-26`
- **What:** `optionsToWire({ 'a.b': 1, 'a:b': 2 })` → `{"a:b":2}`; reversing the insertion order yields `{"a:b":1}`. One option value is lost and *which* one depends on key order. `optionKeyToWire` is idempotent (verified: `to(to('a.b.c')) === 'a:b:c'`), so double application is harmless — but `optionKeyFromWire` is lossy for a key that legitimately contained a colon (`from(to('a:b')) === 'a.b'`).
- **Why it matters:** The server side treats this as a real failure mode — `appserver/code/components/app/session/session.utils.js:96-116` counts collisions explicitly and logs `renamed=…, collisions=…`, dropping the loser. The 17 canonical identifiers contain no colons, so this can only be triggered by an extension- or user-supplied key; `options.ts:29-33` explicitly invites extension packages to register their own. No test covers it.
- **Evidence:** Exercised the real module in a temporary vitest file inside the package (removed immediately; tree verified clean). Also confirmed `'a..b' → 'a::b'`, `'.' → ':'` and non-ASCII (`'ключ.значение' → 'ключ:значение'`) behave consistently with Android's `key.replace('.', ':')`.

### 8. The credit-card Luhn negative test is single-point — a weakened check survives

- **Where:** `packages/protocol/src/shapes.ts:33` (`return sum % 10 === 0;`); test at `packages/protocol/src/shapes.test.ts:91-93`
- **What:** Mutating to `sum % 10 !== 1` **SURVIVED**. The only negative fixture is `'5555555555554445'`, whose Luhn sum is exactly `valid + 1` — i.e. the one residue the mutant still rejects. (Controls: `sum >= 0`, removing the alternate-doubling, and reversing the scan direction were all **CAUGHT**, so the positive side is well covered.)
- **Why it matters:** A weakened validator over-redacts — legitimate 12–19 digit runs (order IDs, account references, IMEIs) would be replaced with `<redacted>` in captured bodies. One more negative fixture with a different residue closes it.

### 9. `sanitizeJson` bypasses `toJSON`, flattening non-plain objects

- **Where:** `packages/protocol/src/sanitize.ts:45-51`
- **What:** The `typeof value === 'object'` branch walks `Object.entries`, so `Date → {}`, `Map → {}`, `Error → {}`, and `Uint8Array → {"0":1,"1":2}` (index-expanded). Plain `JSON.stringify` would have produced an ISO string for the Date.
- **Why it matters:** Latent only today: `sanitizeBody` (`sanitize.ts:83`) feeds it `JSON.parse` output, which never contains these, and `sanitizeJson` has **zero** consumers outside this package. It becomes a live data-loss bug the moment a caller hands it a live object graph (e.g. a structured log payload).
- **Evidence:** Exercised against the real module (temp vitest file, removed).

### 10. `gateNetworkBody` silently disables the size gate on a non-finite `maxBytes`

- **Where:** `packages/protocol/src/sanitize.ts:135` (`utf8ByteLength(body) > options.maxBytes`)
- **What:** With `maxBytes: NaN` the comparison is always false, so an arbitrarily large body is captured; with `maxBytes: -1` everything is dropped. Verified both against the real module. The value flows from `BugseeOption.CaptureNetworkBodySizeLimit` (`packages/capture/src/network-provider.ts:84`) with a `20480` default, so it is only reachable via a malformed user option — bounded, but a `Number.isFinite` guard (or resolver-side validation) would make the wire size bound unconditional.

### 11. `sanitizeHeaders` throws on a non-string header value

- **Where:** `packages/protocol/src/sanitize.ts:17` → `packages/protocol/src/shapes.ts:47-55` (`value.replace(...)`)
- **What:** A non-string value raises `TypeError`. `Record<string,string>` says that cannot happen, but Node's `IncomingMessage.headers['set-cookie']` is `string[]`. Today every producer normalizes first — `packages/node/src/http-interceptor.ts:57-66 normalizeHeaders` joins arrays and `String()`s the rest — so this is defensive only. It sits directly in the capture path (`network-provider.ts:36`), where a throw would kill capture for that event.

### 12. Timestamp units are undocumented on the wire types

- **Where:** `packages/protocol/src/wire.ts:139` (`NetworkEvent.timestamp: number`), `:93` (`ManifestJson.time: { start: number; end: number }`)
- **What:** Neither field states its unit. The convention *is* consistent and correct — unix-**milliseconds** everywhere (`packages/core/src/clock.ts:11-13` `wallNow(): Date.now()`; every interceptor's `#now` defaults to `Date.now()`, e.g. `packages/capture/src/fetch-interceptor.ts:226`; Android stores `long` ms at `IssueReportingRequest.java:118-120`; `worker/test/test_jobs_video.py:111` treats `{'start':0,'end':5000}` as a 5-second recording) — but a wire-contract package should pin the unit at the type, since this is exactly the class of mismatch that is invisible locally and catastrophic in the viewer.

### 13. `FileType` is the only exported union with no `Equal<>` membership pin; `screenshot` is a dead type with a content-type mismatch

- **Where:** `packages/protocol/src/constants.ts:16-32`; `packages/protocol/src/wire.test-d.ts:258-319`
- **What:** `wire.test-d.ts` pins the exact membership of `Mechanism`, `NetworkStage`, `PlatformType`, `NetworkMechanism`, `NetworkDirection` and `NoBodyReason` with `Expect<Equal<…>>`, but not `FileType` — the union that decides how the backend routes every bundled file. Separately, no JS code path emits the `screenshot` FileType (grep of `'screenshot'` across `packages` finds only `packages/core/src/reporting.ts:27`, which is a `ReportingTriggerType`, not a file type), while `DEFAULT_FILENAMES.screenshot = 'screenshot.png'` (`constants.ts:37`) contradicts the backend's `content_type = 'image/jpeg'` for that type (`worker/jobs/bundle.py:615`). Harmless while unemitted; a trap for whoever implements report-time screenshots.

### 14. `ManifestFileEntry.name` is never emitted, so attachments get a server-generated random display name

- **Where:** `packages/protocol/src/wire.ts:83-88` (`name?: string`); emitter at `packages/core/src/bundle-assembler.ts:151,165,173`
- **What:** The assembler pushes `{ filename, type }` for every file and `{ filename: attachment.name, type: 'attachment' }` for attachments — `name` is never set for any file type. Android does set it (`android/sdk/library/src/main/java/com/bugsee/library/reporting/IssueReportingRequest.java:790-795`, passing the user's attachment name as the third `IssueReportFile` argument alongside the stored filename). The worker compensates: `worker/jobs/bundle.py:623-629` fills `file_entry['name'] = 'attachment_' + strutils.random_str(5)`.
- **Why it matters:** Bounded today, because `ReportAttachment.name` is documented as *the bundle filename* (`packages/core/src/reporting.ts:5-10`) and there is no public user-facing attach API yet — so the only affected artifact is the harvested Electron native `.dmp`, which shows as `attachment_x8f2k`. It becomes user-visible the moment a public attachment API lands. The appserver schema does **not** require `name` (`appserver/code/components/shared/dao/models/_recordingManifestFile.js:46-48`), so nothing is rejected.

### 15. Fifteen exports have no consumer anywhere outside the package

- **Where:** `packages/protocol/src/index.ts`
- **What:** Verified by whole-word grep across `packages` (excluding `packages/protocol` and `dist`): `logLevelToWire` **0**, `logLevelFromWire` **0**, `severityFromWire` **0**, `optionKeyFromWire` **0**, `sanitizeJson` **0**, `sanitizeParams` **0**, `isSensitiveHeader` **0**, `isSensitiveKey` **0**, `redactShapes` **0**, `SENSITIVE_HEADERS` **0**, `SENSITIVE_KEY_SUBSTRINGS` **0**, `REDACTED_URL_ENCODED` **0**, `NetworkBodyGateOptions` **0**, `BugseeOptionKey` **0**, `NetworkDirection`/`NetworkMechanism` **0**.
- **Why it matters:** Most are legitimately reachable public API or intentional Android-parity placeholders (`NoBodyReason.unsupported_content_type` is unused in JS but matches `android/…/contracts/exchange/NetworkEvent.java:280`, and should stay). Two are not benign and are called out above: `logLevelToWire` (SEV1 #1) and `REDACTED_URL_ENCODED` — the latter is a URL-scrubbing token for a scrubber the README says lives in `@bugsee/core`, and grepping `%3Credacted` across `packages` finds it **only** in this package, i.e. the core-side URL scrubber it was created for does not exist yet.

### 16. README overclaims byte-identity with mobile

- **Where:** `packages/protocol/README.md:5-6` — *"The single source of truth for the wire contract (design §8); byte-identical to the Bugsee mobile SDKs where they overlap."*
- **What:** Contradicted by SEV1 #2 (`NetworkStage` drops Android's `websocket` stage and the `event` field). The same false assurance appears in-code at `wire.ts:98` (*"corrected to Android-canonical"*). Both should be corrected or the divergence documented as deliberate.

---

## Runtime-code vs type-only breakdown

| File | total | executable | type-only decls | comments | blank |
|---|---|---|---|---|---|
| `wire.ts` | 170 | **0** | 116 | 44 | 10 |
| `sanitize.ts` | 143 | 96 | 5 | 31 | 11 |
| `sensitive.ts` | 113 | 99 | 0 | 8 | 6 |
| `options.ts` | 96 | 32 | 20 | 37 | 7 |
| `levels.ts` | 85 | 67 | 1 | 7 | 10 |
| `index.ts` | 61 | 26 | 30 | 3 | 2 |
| `shapes.ts` | 57 | 40 | 3 | 7 | 7 |
| `constants.ts` | 52 | 22 | 17 | 7 | 6 |
| **total** | **777** | **~382** | **~192** | **~144** | **~59** |

`wire.ts` — the largest impl file and the actual wire-shape definition — contains **zero executable statements**; it is enforced entirely by `tsc`, via 320 LOC of `wire.test-d.ts` type tests (minimal + fully-populated instances, one `@ts-expect-error` per required field of every interface, and `Equal<>` membership pins on 6 of the 7 exported unions). V8 reports **121/121 statements, 61/61 branches, 25/25 functions, 118/118 lines** — a genuine 100 %, not an artifact of excluding files (`vitest.config.ts:11` excludes only `*.test.ts`/`*.test-d.ts`/`*.d.ts`).

The honest reading: the package is ~49 % executable code, ~25 % pure type declarations, ~26 % comments and blanks. Against executable code, the 749 LOC of runtime tests are ~1.96 : 1 — mid-pack, not an outlier. Coverage is not the weak point; **assertion density on the two long constant tables is** (SEV2 #4, SEV3 #5, SEV3 #6), and no amount of line coverage would have caught those, since a table entry is "covered" the moment `Object.entries` walks it.

---

## Android parity check

Verified directly against `/Users/alexeykarimov/Projects/Bugsee/android/sdk` (read-only).

**Confirmed matching:**

| Item | JS | Android |
|---|---|---|
| dot→colon `sdk.options` rule | `options.ts:6-8` `key.replaceAll('.', ':')` | `EnvironmentInfoProvider.java:409-429` `key.replace('.', ':')` — with the *reason* documented (Mongoose "Conflicting dotted paths" on leaf-vs-prefix keys) |
| `LogLevel` 1..5 | `levels.ts:7-13` | `contracts/options/LogLevel.java:45` `Error((byte)1)` … |
| `NoBodyReason` (all 4) | `wire.ts:127-131` | `contracts/exchange/NetworkEvent.java:279-284` |
| FileType strings | `constants.ts:16-32` | `contracts/reporting/ReportFile.java:52-93` — `attachment`/`video`/`screenshot`/`traces.system`/`traces.user`/`events.system`/`events.user`/`viewtree`/`log`/`log.internal`/`network`/`breadcrumbs`/`crash`/`performance` all identical |
| Option identifiers (8 shared) | `options.ts:36,38,42,44,46,54,56,58,60,61,62,64` | `contracts/options/Options.java:15,150,207,248,254,262,271,277,120,129,137,144` |
| `.bundle.zip` suffix, `request.json`, `manifest.json` | `constants.ts:7-12` | `IssueReportingUtils.java:92`, `ReportUploadExecutor.java:52`, `IssueReportingRequest.java:802` |
| `manifest` shape `{version,time:{start,end},files,attrs}` | `wire.ts:91-96` | `IssueReportingRequest.java:806-835` |
| manifest time in unix-ms `long` | `bundle-assembler.ts:184` | `IssueReportingRequest.java:118-120,813-814` |
| network field names (`id`/`mechanism`/`url`/`method`/`type`/`size`/`redirect`/`status`/`statusText`/`customError`/`custom.{headers,body,error,no_body_reason,timings}`/`override`) | `wire.ts:138-169` | `BugseeCaptureDataEntryNetwork.java:190-214` |

**Confirmed divergences:**

1. **`NetworkStage` / frame direction** — full detail in SEV1 #2. `wire.ts:105-114` vs `NetworkEvent.java:229-236` + `BugseeCaptureDataEntryNetwork.java:200-201`.
2. **`manifest.version`** — JS `2` (`constants.ts:4`), Android `1` (`IssueReportingRequest.java:88`). **This is correct and intentional**, and safe: neither `worker/jobs/bundle.py` nor any other worker module ever reads `manifest['version']` (grep for `manifest.get('version')` / `manifest['version']` across `worker --include='*.py'` → 0 hits), and the appserver schema accepts any `Number` with `default: 1` (`_recordingManifest.js:14-18`). No forward-compat logic exists on either side — version is write-only metadata today.
3. **`log` entry `source`** — JS emits strings (`'console'`, `'logger'`); Android's `LogSource` is a numeric byte enum (`contracts/internal/LogSource.java:13-21`, `Unknown(0)`…`Internal(99)`) serialized numerically at `BugseeCaptureDataEntryLog.java:108`. Same class of defect as SEV1 #1, but **out of this package's declared surface** — `LogEvent` lives in `packages/core/src/events.ts:9-15`, not in `@bugsee/protocol`. Noted so it is fixed alongside the `level` translation rather than after it.
4. **`@bugsee/performance` option namespace** (outside this package, but it extends `BugseeOptionTypes` by declaration merging per `options.ts:72-77`): `packages/performance/src/options.ts` declares `com.bugsee.option.performance.monitoring`, where Android's canonical key is `com.bugsee.option.performance.enabled` (`Options.java`, confirmed in the full extracted identifier list). `sample-rate` and `upload-mode` do match.
5. **JS-only option keys** — `capture.network.bodies`, `capture.system-traces`, `capture.system-events`, `capture.interactions`, `config.data-size` have no Android counterpart. **Not a defect**: `options.ts:29-33` explicitly sanctions new keys under the same `com.bugsee.option.<namespace>.<feature>` convention, and Android has no equivalent concept for any of them. Worth noting that JS has no `com.bugsee.option.capture.breadcrumbs` despite emitting a `breadcrumbs` file type, where Android does (`Options.java:283`).
6. **JS-only FileTypes** `replay` and `profile`, and Android-only `input`, `minidump`, `threads.java`, `crash.trace`, `crash.tombstone`, `memory.leak`. Expected per-platform divergence; the backend routes on the manifest `type` string and simply S3-uploads unknown types (`worker/jobs/bundle.py:588-648` special-cases only `crash`/`video`/`screenshot`/`attachment`), and the viewer knows `replay.bin` (`viewer/src/app/core/types/recording.ts:568`). One consequence worth recording: the JS SDK bundles harvested native minidumps as `attachment` rather than Android's canonical `minidump` FileType (`ReportFile.java:80`, used at `BugseeExceptionProcessor.java:158`).

**Could not verify:** the `breadcrumbs`-has-no-`.json`-extension claim (`constants.ts:47`, `docs/design/sdk-design.md:710,1749`, labelled "mobile contract"). Android does not use fixed filenames at all — `CaptureExportProcessorDefault.java:195` generates `<random16>.<typeName>.json` for every default-exported stream, i.e. Android's breadcrumbs file *does* carry `.json`. Since the backend routes on the manifest `type` and never on the filename, this is not a live defect either way, but the "mobile contract" justification does not hold against the Android source; it presumably originates from iOS, which I have no access to and therefore make no claim about.

---

## Hand-rolled protocol-object sites in consumers

The good news first: **there are no hand-rolled bundle-root filenames or manifest versions in production code anywhere.** Every one of `request.json` / `manifest.json` / `apptoken` / `.bundle.zip` / `MANIFEST_VERSION` / the per-type default filenames is consumed from `@bugsee/protocol` at exactly one site, `packages/core/src/bundle-assembler.ts:1-14,66,80,183,190-192`. Bare literals appear only in test fixtures. The four platform environment builders (`packages/node/src/environment.ts:93`, `packages/browser/src/environment.ts:98`, `packages/vercel-edge/src/environment.ts:53`, `packages/webworker/src/environment.ts:86`) all route options through `optionsToWire`; `electron` and `cloudflare` reuse the node/vercel-edge builders rather than duplicating them.

Sites where a wire object *is* built by hand and can drift:

| Site | What it hand-rolls | Risk |
|---|---|---|
| `packages/capture/src/console-interceptor.ts:24,98` | `LogEvent.level` as a `LogLevelName` string | **Live defect** — SEV1 #1. Bypasses `logLevelToWire`. |
| `packages/core/src/client.ts:544-549` | `LogEvent` literal with `level` defaulting to the string `'info'` | Same. The union type `LogLevelName \| LogLevel` (`packages/core/src/events.ts:11`) actively permits the drift instead of forcing normalization at the boundary. |
| `packages/capture/src/web-socket-interceptor.ts:106,122`, `web-transport-interceptor.ts:87-90`, `sse-interceptor.ts:88-91` | `NetworkEvent` literals using `type:'message'|'open'|'close'` + `direction` | **Live defect** — SEV1 #2. Typed against `wire.ts`, so `tsc` cannot help; the shape is wrong at the type level. |
| `packages/core/src/bundle-assembler.ts:151,165,173` | `ManifestFileEntry` literals that never set `name` | SEV3 #14. |
| `packages/core/src/bundle-assembler.ts:88-99` | `serializeFileData` — per-type JSON envelope (`performance` → `{transactions:[…]}`, `profile` → bare object, everything else → array) | Encoded in core with no counterpart declaration in `@bugsee/protocol`. This is real wire structure living outside the wire package; a `FileType`-keyed envelope contract belongs here. |
| `packages/node/src/launch.ts:111` | `CAPTURE_FILE_TYPES = [...Object.keys(DEFAULT_FILENAMES), 'attachment']` | Derives an allowlist from the filename table, which silently includes `crash` — a type the assembler also emits independently at `bundle-assembler.ts:163-167`. If a `crash` entry ever reaches `capturedByType`, the bundle gets two manifest entries and two zip members both named `crash.json`. Not reachable today (nothing captures to `crash`), but the coupling is accidental rather than designed. |
| `packages/webview/src/*` | Streams capture entries to native hosts over its own versioned protocol | Not inspected in depth (out of scope); flagged as the one place where a second, independent wire encoding of the same entry types exists. |

---

## Checked and found clean

- **The dot→colon option rule, precisely.** `optionKeyToWire` (`options.ts:6-8`) is `replaceAll('.', ':')` — byte-for-byte the Android `key.replace('.', ':')` at `EnvironmentInfoProvider.java:426` and the appserver's compensating `key.replace(/\./g, ':')` at `session.utils.js:104`. Applied **exactly once**, at exactly one layer (the four platform environment builders, into `sdk.options` only) and nowhere else. Idempotent, so accidental double application is harmless (verified: `to(to('a.b.c')) === 'a:b:c'`). Empty key, dotless key, empty segments (`'a..b' → 'a::b'`, `'.' → ':'`) and non-ASCII (`'ключ.значение' → 'ключ:значение'`) all behave correctly. Mutating to `replace()` (first occurrence only) and removing the translation entirely were both **CAUGHT**. The one gap is the collision case (SEV3 #7).
- **Prototype-pollution hardening.** `optionsToWire` (`options.ts:21`), `sanitizeHeaders`/`sanitizeParams`/`sanitizeJson` (`sanitize.ts:15,25,46`) all build `Object.create(null)` outputs, so a `__proto__` key from JSON-sourced data is stored as own data. Tested at `options.test.ts:42-47`, `sanitize.test.ts:50-57,79-85,124-132`, and the tests assert *both* that the value survives and that no prototype is polluted — not theatre.
- **Non-mutation of inputs.** `sanitizeHeaders`/`sanitizeParams`/`sanitizeJson`/`gateNetworkBody` are all verified non-mutating, with identity-return fast paths asserted via `toBe` where the contract is "return the same object" (`sanitize.test.ts:225-239,252-255,264-267`) — the one place where identity assertions are the *correct* assertion rather than a smell.
- **`severityToWire` is wired correctly.** Unlike its log-level sibling, it *is* called — `packages/core/src/bundle-assembler.ts:122` `severity: severityToWire(report.severity)` — so `request.json.severity` is numeric 1–5 as intended. The iOS `low → verylow` alias (`levels.ts:56`) and the asymmetric round trip (`severityFromWire(severityToWire('low')) === 'verylow'`) are both explicitly tested (`levels.test.ts:68,101`), and mutating the alias was **CAUGHT**.
- **Runtime portability.** Zero `node:*` imports, zero DOM references, zero unguarded `globalThis` access anywhere in `src` (the only `node:` occurrences are in comments at `options.ts:37` and `wire.ts:115`). Runtime dependencies are exactly two: `@bugsee/types` (type-only) and `@bugsee/util`'s `utf8ByteLength`, which is a pure charCode loop with correct surrogate-pair handling (`packages/util/src/utf8-byte-length.ts:9-24`) — no `TextEncoder`, no `Buffer`. `String.prototype.replaceAll` (ES2021) is the newest builtin used and is satisfied by the declared `engines.node >= 18`. This package runs unmodified on every declared target.
- **Coverage and typecheck are genuinely enforced.** 100 % statements/branches/functions/lines with thresholds set at `vitest.config.ts:12-17`; `tsc --noEmit` passes with exit 0 and `tsconfig.json` `include: ["src"]` pulls in `wire.test-d.ts`, so the 320 LOC of type tests *are* checked by the CI `typecheck` step even though `vitest run` (no `--typecheck`) does not execute them. Not a gap.
- **`redactShapes` has no shared-`lastIndex` bug.** The module-level `/g` regexes (`shapes.ts:11-17`) are reused across calls, which is the classic stateful-regex trap, but `String.prototype.replace` resets `lastIndex` — verified by three consecutive identical calls returning identical results.
- **`sanitizeBody` never throws and dispatches correctly.** Invalid JSON under a JSON content type degrades to the shape pass (`sanitize.ts:85`, tested at `sanitize.test.ts:177-180`). `isJsonContentType` correctly accepts `application/json`, `text/json` and RFC 6839 `+json` suffixes while rejecting `application/json5`, handles `charset` parameters, case, and surrounding whitespace. Loosening it to `includes('json')` was **CAUGHT**.
- **`gateNetworkBody` boundary behaviour.** Exactly-at-limit is kept, over-limit is dropped, size is measured in UTF-8 bytes not characters, Content-Type lookup is case-insensitive, and a producer-set `no_body_reason` is never re-gated. The off-by-one mutation (`>` → `>=`), the `!= null` → `!== null` mutation, and lower-casing header names in `sanitizeHeaders` were all **CAUGHT**.
- **`DEFAULT_FILENAMES` values are unique** (15 keys, 15 distinct filenames — verified programmatically), and `FileType` string constants are stable strings rather than positional numerics, so there is no shift-collision hazard of the kind numeric enums invite.
- **Exact-pinning claim holds.** `docs/dev-environment.md:29,76` says `@bugsee/protocol` is exact-pinned by every consumer. All 11 consumer `package.json`s use `workspace:*`, which pnpm rewrites to the exact version at publish (as opposed to `workspace:^`). The claim is satisfied.
- **`dist/` is gitignored** (`.gitignore:2`), so the stale committed-artifact hazard does not exist here.
- **No `NaN`/`Infinity`/`BigInt`/`Date` hazards on the live path.** Verified that `optionsToWire` + `JSON.stringify` turns `NaN`/`Infinity` into `null`, drops `undefined` keys, and throws `TypeError` on `BigInt` — but the option resolver constrains values to boolean/number/string (`options.ts:33`), so none of these is reachable today. Recorded for completeness rather than as a finding.

---

**Read-only compliance:** every mutation was applied from a backup copy in the session scratchpad and reverted by the same script within the same command; the one temporary probe file (`packages/protocol/src/__probe.test.ts`) was created and deleted in a single invocation. `git status --short packages/protocol` is **empty**, and the baseline suite passes 183/183. The Android, appserver, worker and viewer repositories were read only — nothing was modified or executed there.
