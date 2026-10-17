---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/browser-utils': patch
'@bugsee/performance': patch
---

Browser and WebView system traces gain `app_state` and `fps`:

- `app_state` reports `foreground` / `background` (Android's vocabulary, never the raw `visible` / `hidden`) from the document's visibility, as a held step trace.
- `fps` counts `requestAnimationFrame` callbacks and reports frames per second once a second. It runs only while the page is visible: a hidden tab gets no frame loop and no timer, and a fresh window starts when it is shown again. A hidden page, a runtime without `requestAnimationFrame`, and a page that has not yet produced a single frame (rAF can be paused while the page still says visible) report nothing rather than 0; once frames have flowed, a window with none is a true 0.

The traces now read `performance`, `navigator`, `screen`, `requestAnimationFrame` and the document from the window (and document) passed to `launch()` instead of the host globals, so an injected window that has no `performance.memory` omits the heap traces. New export: `browserTraceEnvFrom`.

Hardening: reading the host's `window`, `document` or `screen` (and each surface of an injected window) can throw in a blocked or torn-down frame or through a cross-origin proxy. Every such read is now guarded: the affected trace or capture source is omitted and the error is reported through `onError`, and `launch()` never fails because of it. New export: `hostGlobal`.
