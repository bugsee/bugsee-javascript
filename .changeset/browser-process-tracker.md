---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/trackers': minor
---

Browser and WebView system traces gain `main_thread_idle_ms` (the browser's granted idle period, 0-50 ms, from one `requestIdleCallback` probe per sampling tick on visible pages; omitted where `requestIdleCallback` is absent, and for a tick in which no idle period was granted) and `user_idle_state` (`active`, `idle` or `locked`, from the Idle Detection API). `user_idle_state` is produced only when the page's `idle-detection` permission is already granted: the SDK never prompts for it. The heap (`ram_js_heap_*`) and `main_thread_lag_ms` traces are unchanged but now come from one per-window `ProcessTracker` (new in `@bugsee/trackers/browser`), whose stages (`heap`, `mainThreadLag`, `idle`, `userIdle`, `uptime`) run only while they have listeners.
