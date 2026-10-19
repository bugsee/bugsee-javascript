---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Browser and WebView system traces gain `screen_size` and `main_thread_lag_ms`:

- `screen_size` reports `{ width, height, dpr }` (CSS pixels of `screen.width` / `screen.height` and `devicePixelRatio`) as a held step trace: an initial value at start, then on every `resize` and `orientationchange`, de-duplicated. It is omitted when the screen or the pixel ratio cannot be read as finite positive numbers. It is deliberately not named `displays`.
- `screen_size` can go stale when the window moves to a monitor with the same pixel ratio but a different size (no `resize` fires), and iOS Safari's `screen.width` / `screen.height` do not swap on rotation.
- `main_thread_lag_ms` is timer drift, the classic event-loop-lag measurement: how late the 1 s sampling timer fired on the page's main thread (a long task or synchronous block delays it by its length), emitted every tick while the page is visible; a measured 0 is a real value. It is measured only while the page is visible: hiding stops the timer, and every time the page is shown a fresh baseline is taken so a hidden stretch never counts as lag. A window without a `performance.now` function reports nothing. Honest limit: it also reads as lag when the browser throttles the timer of a page that still says `visible` (an occluded or minimised window).

Both come from the window passed to `launch()`, are built only with the other lifecycle-based traces, and are replaced together with the sensor traces by a `systemMetricsSampler`.
