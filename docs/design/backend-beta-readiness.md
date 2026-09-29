# Backend readiness for the JavaScript SDK beta

Status: **Design — approved decisions recorded, not built.** 2026-09-29.

The backend already carries most of the JavaScript support: the `javascript` app type and its 27
target subtypes, per-runtime version floors, symbol routing, the `js` build format, sourcemap
symbolication by debug-id, native minidumps, rrweb replay, runtime labels, frame variables and
source context. That work is described in `javascript-application-type.md`,
`appserver-javascript-support.md` and `electron-native-crashes.md`.

This document covers what is still missing before a public beta can send reports to production
and have them accepted, processed and shown. It came out of a read-only audit of each repo's
`origin/main` against the SDK's `main` (`0c32485`), with every load-bearing finding re-checked in
source.

## Scope

In: the appserver, the background worker and the viewer. One worktree and one PR per repo, under
`/Volumes/External2TB/Projects/Bugsee/_worktrees/{appserver,worker,viewer}-js-beta`, branch
`feat/js-beta-readiness`, based on each repo's `origin/main`.

Out, and tracked as the SDK release track (see the last section): anything that has to change in
this repo — publishing, the reported version string, missing `crash.json` on some report kinds,
the browser `user-agent` header, the empty OS value, the Electron video attributes.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Version the beta reports | `0.1.0-beta.N`. The appserver floor must admit prereleases. |
| D2 | Electron runtime system symbols (Electron/V8/Node frames in native crashes) | **Deferred.** Beta limitation; the viewer says so instead of asking for an upload. |
| D3 | When the viewer's production gate opens | **In this PR.** The viewer reaches production only through a manual deploy, so the launch is that deploy. |
| — | Line-level secret scrubbing of source context | **Not revived.** Closed as a product decision on 2026-09-06 (worker #53, javascript #4); `source_context_disabled` is the mitigation. |

## appserver

### A1 — stop rejecting reports from mobile browsers (blocker)

Since `e53b58f` the browser tier reports the operating system in `platform.type`, so a mobile
browser sends `ios` or `android` (`packages/browser/src/user-agent.ts`).
`issue.service.js:1050-1064` treats any Apple or Android `platform.type` as a native mobile SDK
and checks the reported version against the iOS (1.27.0) or Android (1.19.11) floor. A JS SDK at
0.1.0 fails and gets `IssueReportedByUnsupportedSdk` (12007). The SDK does not know 12007, treats it
as transient, and retries the report at every launch without end.

Change: return early from that check when `env.sdk.type === 'javascript'`. The JS floor is
enforced at session start by `utils.js isSupportedSdkVersion`, keyed by the runtime, not the OS.

### A2 — admit prerelease versions (blocker)

`config/default.js:156-161` sets every JS runtime's `minimum` to `0.1.0`, and
`semver.gt('0.1.0', '0.1.0-beta.1')` is true, so a beta session fails with `UnsupportedSdkError`
(99098). The SDK classes 99098 as permanent and deletes the report.

Change: every JS runtime block gets `minimum: '0.0.0-0'` (the lowest version semver can express, so
any prerelease passes), and `current`/`old` become `0.1.0-beta.1`. Those two are release-tunable and
move with each beta.

### A3 — send a retryable error under the rate limit (major)

When the issue rate limit trips, `issue.controller.js:84,96` sends the retryable `ServerTooBusy`
only if `errors/index.js isServerTooBusySupported` says so. That function answers for iOS and
Android only, so a JS client gets `TooManySimilarCrashes` (12004), which the SDK treats as
permanent. Error storms on a busy site lose their reports.

Change: `isServerTooBusySupported` returns `true` when `environment.sdk.type === 'javascript'`. The
JS SDK has handled `ServerTooBusy` since its first version, so there is no version floor.

### A4 — list the JS resource types for the MCP (minor)

`mcp/tools/issue.get-resource.js:43-62` omits `replay`, `profile` and `video.aux`, so an agent cannot
fetch a web session's replay. Add them to the enum and its description.

## worker

### W1 — symbolicate from `trace` (blocker + major)

Commit `6b99a7a` on `feat/js-context-diagnostic` was pushed after PR #48 merged and never reached
`main`. It reads each frame's position from the SDK's `trace` instead of from `data`, which fixes two
bugs the audit reproduced:

- **Anonymous frames never symbolicate.** A frame with no function name carries no `data.member`,
  so the worker builds `@line:col`; `symbolfiles/sourcemap.py:17`'s `^(.+)@(\d+):(\d+)$` needs a
  non-empty name and silently misses. Anonymous frames are the norm in minified code.
- **A reprocess reverts symbolicated frames.** The first pass overwrites `data` with the
  original-source position; the second pass reads that as if it were minified, and resets
  `trace-sym` to the minified trace. Any late map upload triggers this.

Change: cherry-pick `6b99a7a` onto the branch. It applies cleanly.

### W2 — keep the SDK's summary and signatures when there is no `crash.json` (blocker)

Hang (AppHang) reports and Electron renderer-gone reports ship without `crash.json`.
`jobs/bundle.py:884-891` fills any non-bug report without one with signature `no-crash-file` and
summary `<missing crash details>`. That overwrites the SDK's own summary ("Main thread hang
detected") and signatures (`AppHang::Fair|Medium|Severe`), and because the appserver merges on
`signatures: {$in}`, every hang and every renderer crash in an app collapses into one issue.

Change: when the environment is a JavaScript one (`environment.sdk.type == 'javascript'`) and there
is no crash file, leave the summary and signatures as the SDK reported them. Other SDKs keep the
current fallback. The SDK track separately adds a `crash.json` to both report kinds; this change
makes the worker correct either way.

### W3 — respect the SDK's `user` frame flag (major)

`crash/javascript.py:445` sets `frame['user'] = True` for every frame. The SDK marks runtime frames
(`node:`) and its own `@bugsee/*` frames as not the app's (`packages/core/src/crash.ts:178-186`), so
issues currently group on a `@bugsee/capture` or `node:` frame instead of the app's call site.

Change: keep the SDK's value and default to `True` only when the flag is absent.

### W4 — no "at at" in titles (minor)

The summary format (`crash/javascript.py:461`, `"%s at %s"`) prefixes `at` to a location that,
when unsymbolicated, is the SDK trace and already starts with `at `. Strip a leading `at ` from the
location before formatting.

## viewer

### V1 — open the JavaScript app type in production (blocker)

`elements-application-create-dialog.component.ts:199` sets
`isJavascriptTypeAvailable = config.getValue("env.type") !== "production"`, and line 200 reuses it
for Rust. Only the create-dialog radio is gated.

Change: make JavaScript always available. Give Rust its own gate through
`core/utils/deployment.ts isPreProductionFeatureAvailable()` — the helper that file names as the
only definition — so opening JavaScript does not make Rust public too.

### V2 — debug data for JavaScript apps (major)

"Setup auto upload" branches only on unity, xamarin/dotnet, android and ios, so for a JS app it opens
with zero steps. The upload dialog says "Upload mapping" and asks for a zip of debug information.

Change: add a JavaScript branch to the setup dialog that shows the `@bugsee/vite-plugin` and
`@bugsee/webpack-plugin` configuration (and the `bugsee-cli` command for other bundlers), and use
source-map wording in the upload dialog for JS apps. The iOS-only drop zone stays as it is; manual
`.map` upload is not part of the beta flow.

### V3 — stop downloading `profile.json` to discard it (major)

`profile` is not in `recording-session.service.ts`'s ignored-types list, so a CPU profile (often
several MB) is fetched and then dropped by `recording-helper.service.ts`'s `default:` branch. Add it
to the ignored list. A flame-graph view comes after the beta.

### V4 — documentation links for JavaScript apps (major)

`getDocumentationDir.ts:5-6` returns the subtype, so the console hint links to
`docs.bugsee.com/sdk/express/...`. Map every JavaScript subtype to `javascript`. The JavaScript
section of the docs site does not exist yet; that is docs-repo work, tracked below.

### V5 — small fixes (minor)

- The app-list filter has no JavaScript option.
- The issue list's reporter-email tooltip has text for iOS and Android only.
- The application plate prints the raw `application.type`.
- The performance tab computes `end - start` for spans that the SDK may leave without an end, which
  gives NaN widths; treat a missing end as the transaction end.
- Onboarding install lines name only the adapter (`npm install @bugsee/react`) while the snippet
  imports `@bugsee/bugsee`, which resolves only through hoisting. Install both, or import from the
  adapter where it re-exports — whichever the adapter's actual exports support.
- A native frame in a JavaScript app shows "missing debug information… upload". Per D2, Electron's
  own frames cannot be symbolicated during the beta, so the hint for those frames says that instead.

## Testing

Each change is test-first in its repo's own harness, with the mutator loop from
`docs/implementation-standards.md` applied to every changed function:

- appserver: mocha (`NODE_ENV=test npx mocha`), plus `npm run eslint` and the circular-dependency
  check.
- worker: `unittest` under `.venv314`, `PYTHONDONTWRITEBYTECODE=1` during mutation runs (stale
  `.pyc` files otherwise mask a mutation).
- viewer: the specs that exist for the touched services, plus `npm run build`, which is the viewer's
  real gate.

Each PR then gets the convergent multi-agent review before it is marked ready.

## Rollout

Merging to `main` deploys each repo to staging only. After staging is checked with a real JS app
(one browser session, one Node crash with a map, one mobile-browser session):

- appserver: the manual production workflow run. Production is 34 commits behind `main`, which
  also brings the `js` build format there — without it, bundler-plugin build registration fails in
  production today.
- worker: a PR from `main` into `release` labelled `deploy-production`.
- viewer: the manual production workflow run. This is the launch, since it opens the app type.

Order: worker and appserver first, viewer last, so the app type becomes creatable only once the
backend accepts what it produces.

## SDK release track (not in these PRs)

Found by the same audit; each is a change in this repo:

- Every package is `private: true` and `.changeset/config.json` has `access: restricted`; nothing is
  on npm, so every onboarding snippet fails at `npm install`.
- The reported version is hardcoded as `'0.1.0'` in six places (browser, node, webview, webworker,
  vercel-edge launch files and `core/src/carrier.ts`), so bumping `package.json` does not change it.
- Hang reports (`node/src/hang-detection-provider.ts`) and Electron renderer-gone reports
  (`electron/src/renderer-incident-provider.ts`) send no `crash.json`. A renderer minidump is
  attached but never stackwalked.
- The browser transport forwards a `user-agent` header, which is not in production's CORS
  allowed-headers list; Firefox is expected to fail the preflight.
- An unrecognised OS is sent as `platform.type: ''`, which the session endpoint rejects as missing
  (permanent); send `'unknown'`.
- Electron video is WebM, but the manifest carries no codec/format attributes, so the worker and
  viewer label it `video/mp4`.
- A cross-origin "Script error." with no filename sends zero frames, so each occurrence is its own
  issue.
- The performance uploader sends no `x-bugsee-internal` header and ignores `{ok:false}`.

Docs: the docs site has no JavaScript section, which V4 and the first-issue email both link to.

## Deferred

- Electron runtime system symbols (D2): an upload prefix routed to `electron_symbols.system` in the
  worker, plus a way to fetch Electron's published `.sym` files per version.
- A CPU-profile view in the viewer.
- Public resource links and integrations (Slack/Jira) that include the web replay; the public API's
  crash formatter, which currently renders JS crashes through the Android one; JS app-level
  "SDK outdated" flags, which cannot use a single version for an app with several runtimes.
- Retention and rollups for performance data.
