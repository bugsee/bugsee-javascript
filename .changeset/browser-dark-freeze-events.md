---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Browser and WebView `events.system` gain three events: `dark_mode_changed` (`{dark}` from `prefers-color-scheme: dark`, via the `matchMedia` of the window passed to `launch()`, never the host global), and Page Lifecycle `freeze` / `resume` (listened for on the document, where they fire; they do not bubble to the window). A window without `matchMedia`, or whose `matchMedia` throws, simply emits no dark-mode event and is reported through `onError`. The shared `PageLifecycleTracker` now also emits `freeze` and `resume`. New export: `boundMatchMedia`.
