---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Browser and WebView system traces gain `screen_size` and `main_thread_lag_ms`:

- `screen_size` reports `{ width, height, dpr }` (CSS pixels of `screen.width` / `screen.height` and `devicePixelRatio`) as a held step trace: an initial value at start, then on every `resize` and `orientationchange`, de-duplicated. It is omitted when the screen or the pixel ratio cannot be read as finite positive numbers. It is deliberately not named `displays`.
- `screen_size` can go stale when the window moves to a monitor with the same pixel ratio but a different size (no `resize` fires), and iOS Safari's `screen.width` / `screen.height` do not swap on rotation.
- `main_thread_lag_ms` is timer drift: how late the 1 s sampling timer fired on the page's main thread, emitted every tick while the page is visible; a measured 0 is a real value. A freeze of 1 s or more reads between its length minus one second and its length; a block shorter than one second that crosses no due tick reads 0, so short jank can go unseen (a finer timer or `PerformanceObserver('longtask')` would be the follow-up). It is measured only while the page is visible: hiding stops the timer, and every time the page is shown a fresh baseline is taken so a hidden stretch never counts as lag. A window without a `performance.now` function reports nothing. Timer throttling of a page that still says visible (an occluded window) may also read as lag; this is unverified.

Both come from the window passed to `launch()`, are built only with the other lifecycle-based traces, and are replaced together with the sensor traces by a `systemMetricsSampler`.
