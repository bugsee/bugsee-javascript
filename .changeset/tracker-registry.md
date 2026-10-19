---
'@bugsee/core': minor
---

New `createTrackerRegistry()`: a weak per-key registry that makes a tracker a singleton scoped to the window object the SDK is bound to (an injected window never shares a tracker with the host's), with `for` / `peek` / `reset`. Foundation for the domain trackers in the system-traces design (§15).
