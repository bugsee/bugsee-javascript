---
'@bugsee/browser': minor
'@bugsee/trackers': minor
---

Browser system traces: the `connection` trace gains `link_downstream_max_kbps` (from `NetworkInformation.downlinkMax`; omitted when the browser reports no usable value). Zero/non-finite `downlink` and `rtt` readings are now omitted instead of sent as 0. Connectivity is now served by a per-window singleton `ConnectivityTracker` (in the `@bugsee/trackers/browser` entry) that owns the `online`/`offline` and `navigator.connection` listeners and exposes `online`, `networkInfo` and `state` notifications. The trace name and the existing fields are unchanged.
