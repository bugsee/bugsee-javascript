---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Browser and WebView system traces gain `screen_size` and `main_thread_lag_ms`:

- `screen_size` reports `{ width, height, dpr }` (CSS pixels of `screen.width` / `screen.height` and `devicePixelRatio`) as a held step trace: an initial value at start, then on every `resize` and `orientationchange`, de-duplicated. It is omitted when the screen or the pixel ratio cannot be read as finite positive numbers. It is deliberately not named `displays`.
- `screen_size` can go stale when the window moves to a monitor with the same pixel ratio but a different size (no `resize` fires), and iOS Safari's `screen.width` / `screen.height` do not swap on rotation.
- `main_thread_lag_ms` is the delay of a `MessageChannel` round trip on the main thread, one ping per second (never a continuous loop). A ping that is still pending at the next tick reports its age instead of posting another, so a freeze shows up while it is happening. It is measured only while the page is visible: a hidden tab throttles timers and messages, so hiding aborts the ping and discards the last value, and a fresh measurement starts when the page is shown again. Nothing is reported before the first tick of a visible run, and a window without `MessageChannel` or a `performance.now` function reports nothing.

Both come from the window passed to `launch()`, are built only with the other lifecycle-based traces, and are replaced together with the sensor traces by a `systemMetricsSampler`. `browserTraceEnvFrom` now also carries the window's `MessageChannel`.
