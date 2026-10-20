---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/protocol': minor
'@bugsee/trackers': minor
---

Browser and WebView `events.system` gain `language_changed` (the page language changed) and `timezone_changed` (the time zone or UTC offset changed, so a DST shift counts), plus `private_mode_detected` for an opt-in private-browsing heuristic. The heuristic is OFF unless the browser launch sets `captureEnvironmentHints: true` (canonical option `com.bugsee.option.capture.environment-hints`, anything but boolean `true` is off), reports only a `yes` answer, and is never a certainty. All three come from the new per-window singleton `EnvironmentTracker` in `@bugsee/trackers/browser`, which also observes environment hints (cookies, secure context, cross-origin isolation, service-worker control, automation flag, Do-Not-Track and GPC) and Permissions API states, read without ever prompting; unknown values are omitted.
