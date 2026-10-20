---
'@bugsee/util': minor
'@bugsee/node': patch
'@bugsee/electron': patch
---

`@bugsee/util` gains `reportOncePerMessage(onError)`: a wrapper that delivers each distinct failure to the host sink once (bounded memory). `hardwareExtras` (node, and the Electron composition of a caller-supplied one) now uses it, so an extra that throws on every report build reaches `onError` once instead of once per report. GPU block strings are now length-bounded (256 characters per field, 8192 for `gl_extensions`; longer values are truncated) because the environment is rebuilt for every report and stored with each queued bundle.
