---
'@bugsee/browser': minor
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

Browser `displays` now carries a `zoom` field (page zoom, `outerWidth / innerWidth`) and its `width`/`height`/`scale` use the zoom-independent device scale, so the physical size no longer drifts with page zoom (omitted when not derivable, e.g. on touch-first devices; a docked DevTools over-reads). Electron `displays` ids follow the key window: id 0 is the display showing the focused window (else the most recently focused, else the first created), the rest ascend by Electron id, `state: "on"` marks id 0, and the list is re-written when focus or a window move changes that display. `display_*` event ids are positions in the current list.
