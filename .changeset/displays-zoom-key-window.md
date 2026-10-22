---
'@bugsee/browser': minor
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

Browser `displays` now carries a `zoom` field and recovers the physical size from it, but only when the page zoom can be trusted: Chromium, the top-level window, a pointer-fine device, and `outerWidth / innerWidth` within 1.5% of a real browser zoom preset (it is snapped to the preset, so the value does not flap). Otherwise `zoom` is omitted and `width`/`height`/`scale` use `devicePixelRatio` alone, as before. That is the case with a docked DevTools or side panel (the common developer setup), a custom zoom step, Firefox and Safari. Changes are written after 250 ms of quiet, so a window maximize animation does not write a burst of values. Electron `displays` ids follow the key window: id 0 is the display showing the focused window (else the most recently focused, else the first visible/created), the rest ascend by Electron id, `state: "on"` marks id 0, and the list is re-written when focus or a window move changes that display (moves are debounced 200 ms). `display_*` event ids are positions in the current list; correlate by `nativeId`. With `screen` passed, the displays trace keeps focus and move listeners on `app` and on each window even with `captureWindowEvents: false`.
