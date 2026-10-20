---
'@bugsee/browser': minor
'@bugsee/trackers': minor
---

Browser system traces: the `connection` trace gains `link_downstream_max_kbps` (from `NetworkInformation.downlinkMax`; omitted when the browser reports no usable value). Zero/non-finite `downlink`, `downlinkMax` and `rtt` readings are now treated as "no estimate" and omitted instead of sent as 0 (Chromium reports 0 offline and rounds `rtt` to 25 ms; the spec reports `downlinkMax` 0 for type `none`). An unreadable `navigator.onLine` produces no `connection` row instead of a fabricated online one. Connectivity is now served by a per-window singleton `ConnectivityTracker` (in the `@bugsee/trackers/browser` entry) that owns the `online`/`offline` and `navigator.connection` listeners and exposes `online`, `networkInfo` and `state` notifications. The trace name and the existing fields are unchanged.
