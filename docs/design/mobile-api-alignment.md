# Aligning the JS SDK public API with the mobile SDKs

Status: **Plan, in progress.** 2026-10-12. Source: a read-only comparison of the Android (`android/sdk`, `Bugsee.java`,
`OptionsDescriptors.java`), iOS (`BugseeLib/Bugsee.h`, `BGSOptionsDescriptors.m`) and JS public surfaces. The mobile
SDKs are the parity target (CLAUDE.md, "Android-canonical"). Where the web genuinely differs, the difference stays and
is documented under "Kept differences".

## Tasks

Each task is test-first with the mutator loop, keeps the coverage gate, and lands as its own commit.

| ID | Task | Mobile reference | Notes |
|---|---|---|---|
| T1 | Wire `ReportHandler.after`; add `setLifecycleEventsListener` with the mobile event set (Launched, Stopped, BeforeReportShown, AfterReportShown, BeforeReportUploaded, AfterReportUploaded, ReportUploadFailed, ReportUploadFailedWithFutureRetry, BeforeReportAssembled, AfterReportAssembled, ReportAssemblyFailed, BlackoutStarted, BlackoutEnded) | Android `LifecycleEvents`, iOS `BugseeLifecycleEventType` | `after` is typed today and never invoked |
| T2 | Facade cleanup: type `performanceUploadMode`; `startTransaction` / `startSpan` / `getActiveSpan` on the `Bugsee` object; stop exposing `UploadOptions.trigger` and `Mechanism` publicly | `Bugsee.startTransaction`, `startSpan`, `getActiveSpan` | internals keep working through an internal entry |
| T3 | Attachments: a public attachment type and `report.attachments` writable from `ReportHandler.before`; mobile limits (3 files, 3 MB each); bundle assembler includes them | `Report.addAttachment`, iOS `BugseeAttachment` | |
| T4 | Blackout: `startBlackout` / `endBlackout` / `isBlackout`; suspends replay, input and viewtree capture while logs and network continue | `Bugsee.startBlackout` | emits the T1 events once T1 lands |
| T5 | Launch state: `getStatus()` with the Stopped/Launching/Launched/Stopping enum, `relaunch(options?)`, `getLaunchOptions()`, `getHostLaunchOptions()`; verify launch → stop → launch works | `getStatus`, `relaunch`, `getLaunchOptions` | |
| T6 | Missing options: `captureLogsLevel`, `captureBreadcrumbs`, `detectHttpErrors`, `captureNetworkDefaultSanitizer`, `reportDefaultCrashPriority`, `reportDefaultErrorPriority`; `getDefaultNetworkSanitizer()` so a custom filter can reuse the default redaction | `OptionsDescriptors` keys under `com.bugsee.option.*` | canonical keys already exist for some |
| T7 | `notify(title, body?, severity?, fields?, urgent?)` | `Bugsee.notify` | needs a backend check first: which endpoint carries it, and does the collector accept it from a browser |
| T8 | `logException` options: `domain`; check what `mergingRules` does on iOS | Android `ExceptionOptions.Domain`, iOS `BugseeExceptionLoggingOptions` | |
| T9 | Browser: persist the user identifier across page loads, as iOS does | iOS `setUserIdentifier` | storage-failure tolerant |

## Kept differences (documented, not changed)

- `launch` is async in the browser (lazy-loaded extensions) and synchronous on Node.
- JS filters return a value; mobile filters take a callback.
- No native triggers (shake, screenshot, notification bar, broadcast), no video options, `Appearance` or `setWrapper`.
  Web uses replay, CSS masking, and per-call `strings` / `theme` / `css` on the dialog.
- `maxDataSize` per runtime (browser 10 MB, Node 50 MB).

## Open decisions (not delegated)

- **Performance sample rate:** mobile defaults to 0.01, JS to 1.0. Lowering JS cuts web-vitals volume to 1%.
- **Hang detection:** off by default on mobile, on by default on Node.

## Process

One Sonnet agent per task, each in its own git worktree, merged into `main` one at a time. A task is done when the
gates pass (`pnpm lint`, `pnpm typecheck`, `pnpm check:cycles`, per-package coverage) and the diff has been reviewed.
