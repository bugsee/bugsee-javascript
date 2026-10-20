---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/protocol': minor
'@bugsee/trackers': minor
---

Browser and WebView `events.system` gain `language_changed` (the page language changed) and `timezone_changed` (the time zone or UTC offset changed, so a DST shift counts). The Browser launch (not WebView, which keeps private-mode detection off) also gains `private_mode_detected`, from a private-browsing heuristic that is ON by default (opt-out): turn it off with `captureEnvironmentHints: false` (canonical option `com.bugsee.option.capture.environment-hints`, a non-boolean value is treated as off and reported). It reports only a `yes` answer, never as a certainty (constrained storage can false-positive), and an opted-out launch never forwards it even if another consumer enabled detection on the shared tracker. All of these come from the new per-window singleton `EnvironmentTracker` in `@bugsee/trackers/browser`, which can also observe environment hints (cookies, secure context, cross-origin isolation, service-worker control, automation flag, Do-Not-Track and GPC) and Permissions API states, read without ever prompting; unknown values are omitted. Those two stages are read only when a consumer sets `observeHints` / `queryPermissions`, and the browser launch does not, so it issues no `permissions.query()` call.
