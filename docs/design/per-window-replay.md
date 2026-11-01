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
| `FrozenPart` / backends | `FrozenPart.lane` carries the key; every backend attaches it to the records it yields (memory keeps it on the record; file, IndexedDB and the disk-pressure wrapper attach it from the frozen part). Part meta is NOT extended: a recovered prior generation exports as one unkeyed stream (documented limit). |
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
* **L4 open** pixel video per display (compositor in main), and viewer support for secondary members.

Known limits of what shipped: a recovered prior generation (crash recovery) exports as one unkeyed replay, because part
meta does not persist the lane; the viewer still reads only `replay.bin`, which is the first window to produce a base, not
necessarily the key window. A window that closes leaves its last base segment in the store until the byte cap sheds it (it is
the oldest visual data, so it goes first): time eviction keeps the newest base per lane, and an idle window is
indistinguishable from a closed one without a signal from main, so the lane is not dropped on `rendererGone` yet (open:
a store `dropLane`). A stream-encoded lane keeps the type's own manifest attrs (a laned video keeps `format`).

Open (needs the viewer/mobile side): the exact secondary member names and manifest attrs are chosen here (`replay.<n>.bin`,
`attrs.window`), not taken from a mobile convention; they must be confirmed against the viewer before the viewer reads them.
