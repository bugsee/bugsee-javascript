---
'@bugsee/core': patch
'@bugsee/browser': patch
---

Fix: errors that are not `Error` objects shipped minified stack frames that could never be symbolicated.

`logException(false)`, `Promise.reject({ ... })`, an Angular `HttpErrorResponse` handed to `ErrorHandler.handleError`: a thrown
value with no stack of its own is reported with the CALLER's frames. Those frames were stamped with their source-map `debug_id`
only when a frame enricher happened to hand back a different array, so in the common case (no enricher, or one that returns the
frames it was given) they went out without one. The worker symbolicates per frame by `debug_id`, so it left them minified, and
because a report with no debug-ids is indistinguishable from one with nothing to resolve it came back `ready`, never
`missing_sym`: nothing flagged it, even with the build's source maps uploaded.

The caller-site frames are now stamped before the enricher sees them, exactly as a real `Error`'s frames are, and again if the
enricher replaces them.

Also: an `error` event with no thrown value (`event.error == null`, e.g. a script error on another origin) built its frame by
hand as `{ trace, user }`, with no `debug_id` and no structured position. It now goes through the same frame conversion as every
other frame, and its description carries the `debugId=` suffix a real stack's does.

Adds debug-id regression coverage for every capture path that produces frames: node uncaught exception and unhandled rejection,
the app-hang stack (ESM `file://` and CommonJS registrations), the edge runtime, cause chains, and the end-to-end
`client.logException` path for non-Errors.
