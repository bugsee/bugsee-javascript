---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/protocol': minor
'@bugsee/trackers': minor
---

Browser and WebView `events.system` gain `language_changed` (the page language changed) and `timezone_changed` (the time zone or UTC offset changed, so a DST shift counts), plus `private_mode_detected` for a private-browsing heuristic. The heuristic is ON by default in the browser launch (opt-out) and is turned off with `captureEnvironmentHints: false` (canonical option `com.bugsee.option.capture.environment-hints`, a non-boolean value is treated as off and reported); it reports only a `yes` answer, never as a certainty (constrained storage can false-positive). All three come from the new per-window singleton `EnvironmentTracker` in `@bugsee/trackers/browser`, which can also observe environment hints (cookies, secure context, cross-origin isolation, service-worker control, automation flag, Do-Not-Track and GPC) and Permissions API states, read without ever prompting; unknown values are omitted. Those two stages are read only when a consumer sets `observeHints` / `queryPermissions`, and the browser launch does not, so it issues no `permissions.query()` call.
