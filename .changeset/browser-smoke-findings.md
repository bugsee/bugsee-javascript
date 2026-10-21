---
'@bugsee/browser': patch
'@bugsee/webview': patch
---

Two fixes found by a real-browser smoke run. The `connection` trace no longer repeats the browser's last (stale) link estimates while offline: a `not_reachable` sample omits `link_downstream_kbps`, `link_downstream_max_kbps` and `rtt`, keeping only `save_data` (a user preference; `effective_type` is a measurement and equally stale), and the same applies when online with connection type `none`. The `process_foreground` / `process_background` events now come from the de-duplicated app `state` stage, so a duplicate or synthetic `visibilitychange` that leaves the page where it already was no longer emits a spurious event.
