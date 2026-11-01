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

* **L0** core: `lane` on records, per-lane visual state in the chunk store, per-lane reset callback (memory backend).
* **L1** file, IndexedDB and disk-pressure backends attach the lane on read.
* **L2** reifier + assembler: members per `(type, lane)`, naming, manifest attrs, per-member encoder sessions.
* **L3** Electron: window id as lane, per-window `checkout` and per-lane pacing.
* **L4** pixel video per display (compositor); viewer support for secondary members.

Open (needs the viewer/mobile side): the exact secondary member names and manifest attrs are chosen here (`replay.<n>.bin`,
`attrs.window`), not taken from a mobile convention; they must be confirmed against the viewer before the viewer reads them.
