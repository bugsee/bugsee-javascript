---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/trackers': minor
---

Browser and WebView system traces gain `storage_estimate` (`{usage, quota}` in integer MB, from `navigator.storage.estimate()`). It is an origin quota estimate that browsers fuzz, not device free space, so it is a JS-specific trace and not the Android `disk_mem_*` group; a value the browser does not report is omitted, never sent as zero. The source is a per-window singleton `StorageTracker` in `@bugsee/trackers/browser` that polls sparsely (on start, when the page becomes visible, then every 5 minutes) and keeps the last estimate across the last unsubscribe.
