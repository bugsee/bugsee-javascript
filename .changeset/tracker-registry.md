---
'@bugsee/core': minor
---

New `createTrackerRegistry()`: a weak per-key registry that makes a tracker a singleton scoped to the window object the SDK is bound to (an injected window never shares a tracker with the host's), with `for` / `peek` / `reset`. Foundation for the domain trackers in the system-traces design (§15).

`for(key, create, rebind?)` also takes an optional `rebind(tracker)` that runs on every request after the one that created the tracker, so a relaunch on the same window can hand its own error sink and capabilities to the shared tracker (latest launch wins); a throwing `rebind` never fails the request.
