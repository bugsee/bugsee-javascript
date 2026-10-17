---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Browser and WebView system traces gain `app_state` and `fps`:

- `app_state` reports `foreground` / `background` (Android's vocabulary, never the raw `visible` / `hidden`) from the document's visibility, as a held step trace.
- `fps` counts `requestAnimationFrame` callbacks and reports frames per second once a second. It runs only while the page is visible: a hidden tab gets no frame loop and no timer, and a fresh window starts when it is shown again. A hidden page, or a runtime without `requestAnimationFrame`, reports nothing rather than 0.

The traces now read `performance`, `navigator`, `screen`, `requestAnimationFrame` and the document from the window (and document) passed to `launch()` instead of the host globals, so an injected window that has no `performance.memory` omits the heap traces. New export: `browserTraceEnvFrom`.
