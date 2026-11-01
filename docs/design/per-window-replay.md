# Per-window replay (and per-display pixel video)

Status: owner decision 2026-11-01. Follow-up of `streaming-export.md` and `electron.md` (D8).

## Owner rule

* Runtimes that can read **actual pixels** compose the windows of one display into ONE frame, so a report carries one `video`
  per display (the mobile SDKs' model; display ids are the ones the `displays` trace already uses, id 0 = the key window's display).
* Runtimes that **reconstruct** the screen (rrweb DOM replay) capture **per window**: one `replay` stream per window, because
  windows are separate documents and cannot be composed into one frame.

## Problem

Main's capture store has one visual lane, and the exporter writes one `replay.bin`. With several windows their rrweb events
interleave in one stream (a player applies window A's increments to window B's snapshot), time eviction keeps only the newest
base across windows, and a byte-cap reset restarts every recorder. The replay of a multi-window app is wrong today.

## Design (replay half; the pixel half is its own slice, see Slices)

| Layer | Change |
|---|---|
| `StoredEntry` | optional out-of-band `lane?: string` (a source key: the window id as text). Routing needs no deserialize. Absent = the single unkeyed lane (every runtime but Electron main; behavior unchanged). |
| Chunk store | a visual lane per key: its own open part, its own base accounting. Time eviction keeps the newest anchored part at or before the window start PER KEY. Byte-cap shedding sheds the lane that holds the OLDEST visual bytes; `onVisualReset(lane)` names the lane whose bases are all gone. |
| `FrozenPart` / backends | `FrozenPart.lane` carries the key; every backend attaches it to the records it yields (memory keeps it on the record; file, IndexedDB and the disk-pressure wrapper attach it from the frozen part). Part meta persists the lane (`openPart(ref, start, lane?)`; `PartMeta.lane`; file meta `l`, IndexedDB meta `l`), so both recovery paths rebuild one member per window. |
| `CaptureDataEntry` | `lane?: string` copied from the stored record by the reifier. |
| Export | members are grouped by `(type, lane)`. The first lane (by first record) keeps the canonical name (`replay.bin`); later lanes get `replay.<n>.bin` with a manifest entry `{type: 'replay', attrs: {window: <lane>}}`. Each member has its own stream encoder session (orphan trim and clamp are per window). A viewer that reads only `replay.bin` still gets a coherent single-window replay. |
| Electron main | tags each renderer record with its window id as `lane`; `onVisualReset(lane)` restarts ONLY that window's recorder (`checkout` carries the window id; the gate paces per lane). |
| Pixel video | separate slice: main composes the windows of a display with `getBounds()` and z-order into one frame per tick; one `video` member per display (`video.<n>.webm`, attrs `{display: id}`). |

## Slices

* **L0 DONE 2026-11-01** core: `lane` on records, per-lane visual state in the chunk store, per-lane reset callback.
* **L1 DONE 2026-11-01** file, IndexedDB and disk-pressure backends attach the lane on read (memory keeps it on the record).
* **L2 DONE 2026-11-01** reifier + assembler: one stream-encoded member per lane (`replay.bin`, `replay.1.bin`, ...,
  manifest `attrs.window`), per-member encoder sessions; a lane that produced nothing leaves no member and does not take
  the canonical name; non-stream-encoded types ignore the lane.
* **L3 DONE 2026-11-01** Electron: the receiver tags a renderer's replay with its `webContents` id; `onVisualReset(lane)`
  paces and restarts ONLY that window (`checkout(windowId)`, a gate per window; a window with no registered renderer spends
  no budget); an unkeyed reset still asks everyone.
* **L4 DONE 2026-11-01** pixel video per display. The assembler splits every encoder type by lane (so `encodePixelVideo` is no
  longer handed two displays to concatenate); a video lane that is a display id gets `attrs.displayId` (what the viewer
  already reads), anything else `attrs.window`. `createDisplayVideoSource` (electron) composes the windows of each display into
  one frame per tick (`displays`, `layers`, `compose`, `encode` injected), keeps a ring per display, skips a display with no
  visible window, forgets a vanished display after the ring's span, and yields one `video` entry per display with the display
  id as lane, lowest first. `electronDisplays` / `electronWindowLayers` adapt Electron's `screen` and `BrowserWindow`: display 0
  is the focused window's display (as in the `displays` trace); windows are ordered by creation with the focused one on top,
  because Electron exposes no z-order (the adapter's one stated limit). Frames are kept per PHYSICAL display (`DisplayInfo.key`
  = the native id), because the numbered `id` moves when focus changes monitors; a tick that does not answer for `stuckMs`
  (a hung `capturePage`) is abandoned so capture resumes; a failing `encode` costs only its display's video.
  Review of L4-L6 also fixed: the file backend keeps the open part's lane itself (no read-back dependency under disk
  pressure), a destroyed window's late replay is dropped (it cannot revive a retired lane), `forget` reads `sender.id` inside
  its guard.

* **L5 DONE 2026-11-01** the lane is persisted in the part meta (all backends and the disk-pressure wrapper), and capture
  recovery and native-crash recovery freeze each part with it: a crashed multi-window session rebuilds one replay per window.

* **L6 DONE 2026-11-01** `CaptureStore.retireLane(lane)`: main retires a window's lane when its webContents is destroyed or its
  process is gone; the store drops it once none of its data is inside the recording window (so the report range is kept
  whole), and any new record for the lane revives it (a crashed window that reloads keeps its id).

Not shipped: a concrete `compose` (painting the grabbed windows onto one display-sized frame needs an image library or an
offscreen canvas; the package stays free of both, so the host injects it) and the viewer changes below.

Known limits of what shipped: the viewer still reads only `replay.bin`, which is the first window to produce a base, not
necessarily the key window. A stream-encoded lane keeps the type's own manifest attrs (a laned video keeps `format`).

Viewer (checked 2026-11-01, `viewer/src/app/features/recording/shared/recording-session.service.ts`): it takes
`files.find(type === 'replay')`, i.e. only the FIRST replay entry of the manifest, so extra windows are ignored today and
the shown window is the first in manifest order. For video it already maps EVERY `video` entry and reads
`attrs.displayId` (`manifestEntryDisplayId`; legacy `display_id`; missing = 0), so the pixel half uses `attrs.displayId`.
Replay members use `attrs.window` (the viewer has no window concept yet): a viewer change is needed to pick or switch windows.
