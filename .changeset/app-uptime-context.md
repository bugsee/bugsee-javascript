---
'@bugsee/node': minor
'@bugsee/browser': minor
'@bugsee/trackers': minor
---

`environment.app.uptime_s` (whole seconds the process, or for the browser the document, had been running when the capture session started) is now written once at launch on Node, Bun, Deno, Electron main and the browser. It replaces the per-second `process_uptime_s` system trace, which is retired together with the node `ProcessTracker` `uptime` stage.
