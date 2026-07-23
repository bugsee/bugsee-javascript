# `@bugsee/replay-canvas` — canvas replay add-on (design)

**Status:** Draft v1 (2026-07-16); **implementation started 2026-07-22** (see the build correction below).
Builds ON the shipped `@bugsee/replay` (RP0–RP6, `docs/design/replay.md`) — read that first; this doc
covers the canvas delta.

> **Build correction (2026-07-22) — supersedes the `getCanvasManager` / new-`@bugsee/rrweb`-bundle mentions
> below.** The repo pins **rrweb 2.1.0**, which records canvas by OPTIONS alone: `recordCanvas: true` +
> `sampling.canvas: 'all' | number` (fps) + `dataURLOptions: { type, quality }`, with the canvas recorder
> built into `record` — there is **no `getCanvasManager`** (that is a newer-rrweb API). Verified the fork's
> `@bugsee/rrweb-record` bundle **already ships the canvas recorder** (`recordCanvas` / `initCanvasMutation-
> Observer` / `canvasMutation` / `toDataURL` all present), so **O1 dissolves: no cross-repo fork work and no
> new `@bugsee/rrweb` bundle/entry.** Therefore `CanvasRecordConfig = { recordCanvas: true; sampling: {
> canvas: 'all' | number }; dataURLOptions: { type: string; quality: number } }` (no manager field), and
> `@bugsee/replay-canvas` is a tiny **pure options-builder** (+ option defs + wiring) needing no rrweb import.
> To keep the dependency graph cycle-free, the lazy `import('@bugsee/replay-canvas')` is driven from
> `@bugsee/browser` (not from `registerReplay`) — so `@bugsee/replay` never imports `@bugsee/replay-canvas`.
> The seam, lazy-loading, privacy model, and slices RPC1–RPC6 are otherwise unchanged; RPC0 is types-only.

---

## 0. Context & why

`@bugsee/replay` records the DOM via the Bugsee-hardened rrweb fork (`@bugsee/rrweb`) and streams each
`eventWithTime` through the normal capture ring into `replay.bin`. rrweb's DOM recorder deliberately
**does not capture `<canvas>` pixels** — a canvas replays back blank. Apps that render into canvas
(charts, maps, WebGL/3D scenes, image/photo editors, games, signature pads) therefore have a visual
hole in their replay.

Canvas recording is a **known, deliberately-deferred gap** in the replay design (replay.md O5, D-tier-3):
it carries real CPU/size/privacy cost, so it must be **opt-in, off by default, and lazy-loaded** — never
paid for by replay users who don't need it. `@bugsee/replay-canvas` is that opt-in add-on.

### Understanding summary
- **What:** an opt-in extension that makes `@bugsee/replay` additionally capture `<canvas>` content
  (2D + WebGL) so replays render canvas visuals, at a controlled fps/quality budget.
- **Why:** close the single biggest fidelity gap in DOM-only replay for canvas-heavy apps.
- **Who:** web/Electron-renderer/DOM apps that already enabled `replay` and opt into canvas.
- **How (one line):** provide rrweb's canvas manager + canvas record-options through a new optional
  seam on `@bugsee/replay`'s recorder; ship the canvas code ONLY in this package, lazy-loaded.

### Non-goals
- No new FileType, encoder, or bundle format — canvas events are ordinary rrweb events that already ride
  `replay.bin` (RP2/RP3 unchanged).
- No core changes — this is a pluggable extension over replay's seams ("don't pierce the core").
- No server/viewer work — the dashboard's rrweb player already replays canvas events natively.
- Not on-by-default and not bundled into `@bugsee/replay`.

### Assumptions (to confirm — see §8)
- The Bugsee rrweb fork (`github.com/bugsee/rrweb`) can produce a canvas-manager build entry we consume
  from `@bugsee/rrweb` (the fork is ours; replay.md D1/D2). **A1**
- The dashboard's replay player already supports canvas events (upstream rrweb feature). **A2**
- 2D snapshot + WebGL draw-call capture via rrweb's unified `CanvasManager` is acceptable for v1. **A3**

---

## 1. Architecture

### 1.1 The seam (one small, additive change to `@bugsee/replay`)

`@bugsee/replay`'s recorder (`packages/replay/src/recorder.ts:49`) builds the rrweb call as:

```ts
this.#stop = this.#record({
  ...this.#masking,
  checkoutEveryNms: this.#checkoutEveryNms,
  recordCrossOriginIframes: false,
  emit: (event) => { if (!this.#blackedOut) this.capture('replay', event.timestamp, event); },
});
```

Add an **optional `canvas` field** to `ReplayCaptureProviderOptions` (and thread it from
`RegisterReplayOptions`). When present it is spread into the `record({...})` call; when absent (the
default) nothing changes and no canvas code is referenced:

```ts
export interface CanvasRecordConfig {
  recordCanvas: true;
  sampling: { canvas: 'all' | number };         // fps (or 'all' = every frame)
  dataURLOptions: { type: string; quality: number };
}
export interface ReplayCaptureProviderOptions {
  record: ReplayRecordFn;
  masking: ResolvedReplayMasking;
  checkoutEveryNms?: number;
  canvas?: CanvasRecordConfig;                   // NEW — undefined ⇒ DOM-only (unchanged behavior)
}
// onStart(): this.#record({ ...this.#masking, ...this.#canvas, checkoutEveryNms, recordCrossOriginIframes:false, emit })
```

`recordOptions` (from `@bugsee/rrweb`, = rrweb `BaseRecordOptions`) already types `recordCanvas` /
`sampling.canvas` (`'all' | number`) / `dataURLOptions`, so the seam is type-clean with no new rrweb type
work. This is the ONLY edit to `@bugsee/replay`, and it is behavior-preserving when `canvas` is undefined
(proven by an existing-recorder regression test).

### 1.2 What `@bugsee/replay-canvas` provides

A single factory that resolves user options → a `CanvasRecordConfig` (pure data — rrweb 2.1.0 needs no
canvas manager; the canvas recorder already ships in the fork's `record` bundle):

```ts
// @bugsee/replay-canvas
export interface CanvasReplayOptions {
  fps?: number;              // default 2
  quality?: number;          // 0..1, default 0.6
  imageType?: 'image/webp' | 'image/jpeg';  // default 'image/webp' (fallback 'image/jpeg')
  maxSnapshotDimension?: number;            // downscale cap, default 1280
}
export function createCanvasRecordConfig(opts?: CanvasReplayOptions): CanvasRecordConfig;
```

### 1.3 rrweb canvas exposure (`@bugsee/rrweb`)

The wrapper already declares itself "the single SWAPPABLE rrweb import point for @bugsee/replay (+
@bugsee/replay-canvas)" (`packages/rrweb/src/index.ts:1`). Its current `@bugsee/rrweb-record` bundle is
record-only with canvas tree-shaken out (~56 KB gzip). Add a **separate canvas entry** so the base
replay bundle stays canvas-free:

- New export `getCanvasManager` (rrweb's unified 2D+WebGL `CanvasManager`) behind a subpath entry
  `@bugsee/rrweb/canvas` (or a sibling `@bugsee/rrweb-canvas` git-dep build of the fork). `@bugsee/replay`
  never imports it; only `@bugsee/replay-canvas` does. **(cross-repo fork task — see §8 O1)**

### 1.4 Data flow (nothing new downstream)

```
replay:{canvas:true}
  → @bugsee/browser lazy import('@bugsee/replay') → registerReplay(...)
     → (canvas requested) lazy import('@bugsee/replay-canvas') → createCanvasRecordConfig(opts)
        → getCanvasManager from @bugsee/rrweb/canvas
     → createReplayCaptureProvider({ record, masking, checkoutEveryNms, canvas })
        → record({ ...masking, recordCanvas, sampling:{canvas:fps}, dataURLOptions, getCanvasManager, emit })
philosophy: canvas events are ORDINARY rrweb events → existing ring / bounding / redaction / encoder
           → replay.bin  (RP2/RP3 unchanged, no new FileType)
```

---

## 2. Privacy & masking (fail-closed by construction)

Canvas has **no intrinsic text/DOM masking** — it is raw pixels, often user content. Replay's privacy
model is fail-closed (`maskAllText`/`maskAllInputs`/`blockAllMedia` on by default, opt-out via
`.bugsee-unmask`/`.bugsee-show`; replay.md RP1/D3). Canvas layers onto that:

- **The add-on is itself the primary gate:** with `@bugsee/replay-canvas` absent/off, ZERO canvas pixels
  are captured (default). Opting in is an explicit "canvas content is safe to record" decision.
- **Per-canvas block honored:** a `<canvas>` inside any `.bugsee-block` / `.bugsee-ignore` / masked
  subtree is blocked by rrweb (placeholder, no pixels) — reuses the existing block selectors, no new API.
- **`blockAllCanvas` (BUILT 2026-07-23, default OFF):** a switch that blocks every `<canvas>` except those
  opted in via `.bugsee-show` / `[data-bugsee-show]`. Implemented as a **top-level `replay.blockAllCanvas`
  masking option** — a sibling of `blockAllMedia` in `masking.ts` (adds `'canvas'` to the composed
  `blockSelector`; the existing `.bugsee-show` `unblockSelector` opts individual canvases back in) — NOT
  nested under `canvas`, because block-selector composition is masking's job and it then flows through the
  normal masking path with no extra wiring. Composes with canvas recording: `blockAllCanvas: true` +
  `canvas: true` ⇒ record ONLY the opted-in canvases.
- **Blackout still applies:** `startBlackout()` already pauses ALL visual capture including canvas
  (it gates `emit`), no extra work.
- **Cross-origin canvases** that are tainted throw on `toDataURL`; rrweb swallows and skips them — a
  tainted canvas is silently not captured (documented, no leak).

---

## 3. Scope: 2D + WebGL

rrweb's unified `CanvasManager` captures both **2D** (periodic `toDataURL` snapshots at `sampling.canvas`
fps) and **WebGL/WebGL2** (draw-call mutation capture + state replay). v1 ships both via the one manager,
with conservative defaults; WebGL carries higher event volume, so:

- **D-scope:** enable both, but document that WebGL-heavy/high-fps apps should tune `fps`/quality (§4).
- If the fork's WebGL capture proves too heavy to land cleanly, fall back to **2D-only v1** and defer
  WebGL to v1.1 behind `webgl:false` default (see §8 O3).

---

## 4. Performance & size budget

Canvas is the expensive part of replay; every default is chosen to be cheap-by-default:

| Knob | Default | Rationale |
| --- | --- | --- |
| `fps` (`sampling.canvas`) | **2** | Snapshots are CPU + bytes; 2 fps reads well on replay, ~cheap. |
| `quality` | **0.6** | Visually adequate, ~half the bytes of lossless. |
| `imageType` | **image/webp** (→ jpeg fallback) | webp ≈ 25–35% smaller than jpeg; feature-detect. |
| `maxSnapshotDimension` | **1280** | Downscale huge canvases before encode (bytes + CPU). |
| ring bounding | inherited | Canvas events flow through the SAME `maxRecordingTime`/`maxDataSize` ring — they can't blow the budget; oldest parts drop first (design A1). |

- **Bundle:** the canvas manager (~20–40 KB gzip) ships ONLY in `@bugsee/replay-canvas` + the
  `@bugsee/rrweb/canvas` entry, lazy-loaded. Base `@bugsee/replay` and errors-only bundles are unchanged.
- **Off-thread:** encoding stays at report time (sync `encodeReplay`, RP3) — no change; canvas only adds
  more `replay` entries to the ring.

---

## 5. Packaging & lazy loading

- `packages/replay-canvas/package.json` deps: `@bugsee/replay` only (the seam type `CanvasRecordConfig`);
  `@bugsee/core` is a dev-only test type; NO `@bugsee/rrweb`/DOM runtime dep (a pure options-builder).
  Dual-module (tsup) per `docs/design/packaging-dual-module.md`;
  `sideEffects: false`; dev entry `./src/index.ts`, publishConfig → `./dist`.
- **Lazy the whole way down:** `@bugsee/browser` lazy-imports `@bugsee/replay` only when `replay` is set
  (existing RP5); `@bugsee/replay`'s `registerReplay` lazy-imports `@bugsee/replay-canvas` only when the
  canvas option is truthy. So a `replay`-without-canvas app never loads canvas code, and a no-replay app
  never loads either.

---

## 6. Option surface

Two candidates (decision O4):

- **(A, proposed) Nested under replay:** `replay: { canvas: true | CanvasReplayOptions }`. Canvas is a
  replay sub-feature; nesting keeps the namespace tidy and makes lazy wiring obvious (replay owns it).
- **(B) Separate top-level:** `replayCanvas?: boolean | CanvasReplayOptions`, aligned with the flat
  `replay` / `performance*` friendly-option style.

Either resolves to a canonical `com.bugsee.option.replay.canvas*` identifier (declaration-merged into
`BugseeOptionTypes` by this package, per the options scheme + the new `ControllingOption` type). Boolean
`true` ⇒ defaults; object ⇒ overrides.

---

## 7. Decision log

| # | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| **D1** | Canvas is an **optional seam on replay's recorder** (`canvas?: CanvasRecordConfig` spread into `record()`), not a separate provider. | A second capture provider running its own rrweb recorder. | One rrweb recorder per session (two would double-record the DOM). The seam is additive + behavior-preserving when absent. |
| **D2** | **No new FileType/encoder.** Canvas events are rrweb events on the existing `replay` stream → `replay.bin`. | A separate `canvas.bin`. | rrweb already interleaves canvas + DOM events; splitting them breaks replay ordering. RP2/RP3 untouched. |
| **D3** | Canvas runtime ships **only in `@bugsee/replay-canvas` + a `@bugsee/rrweb/canvas` entry**, lazy-loaded. | Bundle canvas into `@bugsee/rrweb-record`. | Keeps the base replay bundle ~56 KB; canvas-free apps pay nothing (design tier-3). |
| **D4** | **Fail-closed privacy:** add-on off by default; per-canvas block via existing `.bugsee-block`/`.bugsee-ignore`; blackout applies. | Record all canvases whenever replay is on. | Consistent with `blockAllMedia`/`maskAllText`; canvas pixels are high-risk. |
| **D5** | **Cheap defaults** (2 fps / q0.6 / webp / 1280px cap), all overridable; bounded by the existing ring. | High-fidelity defaults. | Canvas is the costly path; default must be safe for prod. |
| **D6** | Reuse `@bugsee/rrweb` as the single swap point (add a canvas entry there), consistent with replay.md D1/D2. | Import a canvas plugin from npm directly in replay-canvas. | Keeps ALL rrweb sourcing in one swappable module; fork privacy hardening stays centralized. |

---

## 8. Open decisions (need your call)

- **O1 — rrweb fork canvas build (cross-repo).** The fork (`github.com/bugsee/rrweb`, `bugsee-dist`) must
  emit a canvas-manager entry we expose as `@bugsee/rrweb/canvas`. Confirm we own/land that fork build now,
  or gate replay-canvas behind it (like replay's fork dependency was staged).
- **O2 — RESOLVED / BUILT (2026-07-23), default OFF.** `replay.blockAllCanvas` — a top-level masking
  sibling of `blockAllMedia` (see §2). Blocks all `<canvas>` except `.bugsee-show`; composes with canvas
  recording to record only opted-in canvases.
- **O3 — WebGL split: NOT cleanly buildable in-SDK (2026-07-23 finding).** rrweb 2.1.0's canvas manager is
  UNIFIED — `recordCanvas: true` records 2D **and** WebGL through one `initCanvasMutationObserver`, and the
  fork even force-sets `preserveDrawingBuffer=true` on WebGL contexts so snapshots work — so **WebGL is
  already captured** by the shipped snapshot config, content-agnostically. rrweb 2.1.0 exposes **no** option
  to toggle WebGL independently; a literal 2D-vs-WebGL split would require modifying the fork's canvas-manager
  source + rebuilding the `@bugsee/rrweb-record` bundle (cross-repo). Options: (a) leave as-is (WebGL works
  via snapshots); (b) expose the capture-strategy lever rrweb DOES have — `sampling.canvas` as a number (fps
  snapshots, current) vs `'all'` (record every draw call, higher fidelity, heavier); (c) do the fork work for
  a real WebGL toggle. Awaiting a decision.
- **O4 — option surface.** `replay:{canvas}` (**proposed**) vs top-level `replayCanvas`.
- **O5 — Electron-renderer parity.** Renderers already run `@bugsee/browser` replay over the streaming
  store; confirm replay-canvas is simply enabled there too (expected free), no main-process work.

---

## 9. Implementation slices (test-first, mutator loop, ≥100/90 gate, convergent review)

- **RPC0 — `@bugsee/rrweb/canvas` entry.** Expose `getCanvasManager` + `GetCanvasManager` type from the
  fork's canvas build; smoke-load guard (node-free, size). *(blocked on O1)*
- **RPC1 — replay seam.** Add `canvas?: CanvasRecordConfig` to `ReplayCaptureProviderOptions` +
  `RegisterReplayOptions`; spread into `record()`. Regression test: `canvas` undefined ⇒ byte-identical
  record options (behavior-preserving). Fake `record` asserts the canvas keys are forwarded.
- **RPC2 — `createCanvasRecordConfig`.** Options resolver (fps/quality/type/dimension defaults + clamps);
  pulls `getCanvasManager`. Pure, fully unit-tested + mutator-looped on every default/clamp boundary.
- **RPC3 — option + lazy wiring.** `com.bugsee.option.replay.canvas*` friendly↔canonical defs
  (declaration-merged); `registerReplay` lazy-imports `@bugsee/replay-canvas` when enabled and threads the
  config. Test the enabled/disabled branches + the lazy-import boundary (injected importer).
- **RPC4 — privacy tests.** Per-canvas block honored; `blockAllCanvas` (per O2); blackout pauses canvas;
  tainted-canvas skip. Assert on the emitted rrweb options + a fake canvas manager.
- **RPC5 — packaging.** package.json (deps, dual-module, sideEffects), umbrella wiring; dual `import`+
  `require` load e2e.
- **RPC6 — e2e.** jsdom/real-canvas: boot replay+canvas, draw to a 2D canvas, assert canvas events land in
  the drained `replay.bin` (mirrors replay's RP6 jsdom e2e; Playwright cross-browser deferred).

---

## 10. Testing strategy

- **Injected fakes** (no real DOM/GPU): fake `record` (captures the options object), fake
  `getCanvasManager`, fake canvas element/`toDataURL`. The recorder + resolver are unit-testable exactly
  like the existing `recorder.test.ts` / `masking.test.ts`.
- **Behavior-preserving proof** for the `@bugsee/replay` edit: snapshot the `record()` options with
  `canvas` undefined vs the pre-change baseline — must be identical.
- **Mutator loop** on every resolver default/clamp and every privacy branch; **≥100% line / ≥90% branch**
  per package; **multi-agent convergent review** of impl + tests before done (implementation-standards §2/§4/§7).
