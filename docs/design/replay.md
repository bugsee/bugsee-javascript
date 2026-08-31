# Session Replay — design (`@bugsee/replay` + `@bugsee/replay-canvas`)

Status: **BUILT + on `main`** — slices RP0–RP6 complete, with the rrweb fork wired as a git dependency
(`github:bugsee/rrweb#bugsee-dist`, ~56KB record-only). Option-driven + lazy-loaded, incident-buffered ring,
fail-closed masking, `replay.bin` FileType. The canvas add-on is a separate package
(`docs/design/replay-canvas.md`). Design captured 2026-07-07. Read alongside `docs/design/sdk-design.md`
(the settled replay decisions: §0.5#6, §11/§60, §16 §204, §27#10, §51, §90/§92) and `docs/PROGRESS.md`.

---

## 1. Understanding summary

**What.** Visual session replay for the browser tier: record the DOM (mutations, input, scroll, mouse, viewport)
continuously into the rolling buffer, and on an incident ship the buffered events as a new **`replay.bin`** bundle
file (a gzipped rrweb event stream). The dashboard renders it with a native rrweb player — **no server-side MP4
transcode** (mobile's `video` path is unchanged; this is the web analogue).

**Why.** Replay is the single biggest visual-context gap vs the mobile SDKs and vs competitors. It turns "an error
happened" into "here's exactly what the user saw and did in the last ~60 s."

**Who.** Browser (`@bugsee/browser` + the umbrella) apps — **all of them by default**. Replay is ON unless the app
passes `replay: false`; an options object customises it. Framework adapters inherit it (they compose the browser tier).
Rationale: video is Bugsee's headline feature and both mobile SDKs record by default, so a JS SDK that shipped it off
was a parity divergence a web integrator would never discover. `replay: false` keeps a genuinely errors-only path.

**Key constraints (from sdk-design.md, binding):**
- **Option-driven, not an integration** (§0.5#6). `replay: boolean | ReplayOptions`, **default ON** (opt out with
  `replay: false`). `@bugsee/replay` is **lazy-`import()`ed, and skipped entirely when `replay` is `false`** — the
  bundle-size budget is what the lazy chunk and the opt-out exist for, NOT a reason to default off: an app that opts
  out keeps the ≤15 KB errors-only bundle, and the replay add-on has its own **≤90 KB gzipped** budget that only
  recording apps pay (as a separate chunk fetched after launch).
- **Privacy fail-closed** (§27#10, §92): `maskAllText` / `maskAllInputs` / `blockAllMedia` all default `true`;
  `<input type=password>` + `autocomplete=cc-*` **always** masked (never unmaskable); iframes + shadow DOM excluded by
  default.
- **Two seams** (§204): a recorder **Capture provider** + a **`ReplayEncoder` Service**. `startBlackout()` pauses it.
- **Android-canonical; Sentry is a reference, never a source.** No `@sentry-*` runtime dependency.
- **Non-DOM runtimes** (node/edge/worker): the `replay` option is ignored with a `debug.warn` (via `integration-shims`).

**Non-goals (v1):** continuous full-session streaming upload (we are incident-driven — see D4); server-side video
transcode; the dashboard rrweb player (a separate frontend/backend task, §60); canvas replay (deferred to
`@bugsee/replay-canvas`, opt-in); the report-time DOM view-hierarchy snapshot (`snapshot()`/`viewHierarchyProvider` —
related but separate; replay is a prerequisite for the component-tree-capture snapshot, see
`docs/design/component-tree-capture.md`).

---

## 2. Assumptions

- rrweb (upstream `rrweb-io/rrweb`, MIT) is the recorder. We do NOT build a DOM recorder from scratch.
- The record path (`@rrweb/record` + `rrweb-snapshot` + `@rrweb/types`) is ~50–60 KB gzipped before slimming; with
  iframe/canvas/shadow-DOM recording disabled we target ~40 KB, + a ~10 KB fflate worker (externalizable). Comfortably
  inside the ≤90 KB add-on budget; and it's **lazy-loaded**, so the ≤15 KB errors-only budget is untouched.
- The existing rolling-capture pipeline (aggregator → store ring → bundle) is the substrate. Replay events are just
  another capture stream, bounded by `maxRecordingTime` / `maxDataSize`.

---

## 3. Decision log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| **D1** | **rrweb via a Bugsee FORK of upstream `rrweb-io/rrweb`**, consumed through a thin `@bugsee/rrweb` wrapper package. Cherry-pick the generically-useful patches from Sentry's fork (privacy/robustness/perf tiers — §4); skip Sentry-specific wiring. | (a) npm `@rrweb/record` dep as-is; (b) `@sentry-internal/rrweb`; (c) vendor upstream in-tree | User decision. A fork gives patch control (masking hardening, size trimming, "a recorder bug never breaks the host page") without depending on Sentry code or on upstream's release cadence. The `@bugsee/rrweb` wrapper makes the exact source a swappable detail. |
| **D2** | **Build order: implement `@bugsee/replay` against the `@bugsee/rrweb` wrapper, which initially re-exports npm `@rrweb/record`**, and swap the wrapper's internals to the Bugsee fork once the fork exists. | Block the build until the fork is created + all Sentry commits ported | Unblocks the SDK work immediately; the fork + porting proceeds in parallel and is invisible to `@bugsee/replay` (same wrapper API). The porting tiers (§4) are a checklist against the fork, not a prerequisite for the recorder/encoder slices. |
| **D3** | **Fail-closed masking defaults** (`maskAllText`/`maskAllInputs`/`blockAllMedia` = true; password + `autocomplete=cc-*`/`type=tel` hard-masked; iframes + shadow DOM excluded). Bugsee-namespaced opt-out selectors `.bugsee-unmask`/`[data-bugsee-unmask]` (+ mask/block/ignore), additive to rrweb `rr-*`. | Match rrweb's permissive defaults | Binding (§27#10). Privacy is the gating concern for shipping replay on by-default-ish. |
| **D4** | **Incident-driven ring-buffer ("buffer") mode is v1**: record into a bounded in-memory ring (full-snapshot `checkoutEveryNms` ≈ maxRecordingTime), include the buffered stream in the bundle only when a report fires (gated by `includeVideo`, §51). Continuous full-session streaming is deferred. | Continuous session upload (Sentry's session mode) | Matches the whole SDK's incident-driven model (rolling buffer + no-incident-uploads-nothing) and the existing capture store. Continuous mode = a v1.x follow-up. |
| **D5** | **Encoder = fflate gzip, SYNCHRONOUS at report time** (`gzipSync`), produces `replay.bin`. NOT `@rrweb/packer`. **[Revised at RP2:** originally a Web Worker; but encoding is a ONE-SHOT at incident time (not continuous — recording runs on the main thread regardless), so a sync gzip keeps `assembleBundle` pure/synchronous with no async-pipeline change. A worker is a deferred optimization.**]** | Web Worker (async); `@rrweb/packer`; pako | Sync one-shot avoids making the whole trigger/upload pipeline async; fflate is small; matches the established `@bugsee/util` zip usage. |
| **D6** | **`replay.bin` is a new `FileType`** produced by the encoder via a **bundle-assembler special-case** (like `performance`/`profile` already are) — binary, not JSON. | Ship rrweb events as a `replay.json` | §60: the wire file is `replay.bin` (gzipped rrweb stream); the dashboard player consumes it directly. |
| **D7** | **Recorder is a `CaptureProvider`** (mirrors `log-provider`): `record({ emit })` is the source; each `eventWithTime` becomes a `replay` capture entry, subscriber-presence-activated + gated by the `replay` option. | A bespoke non-capture recorder | Reuses the ring/persistence/redaction/bounding of the capture pipeline for free; one uniform data model. |
| **D8** | **Non-DOM shim** via `@bugsee/integration-shims`: the `replay` option on node/edge/worker warns + no-ops. | Hard error | §372 — friendly degradation, matches Sentry's pattern. |

---

## 4. The `@bugsee/rrweb` fork + Sentry-commit porting plan

`@bugsee/rrweb` (new tier-3 wrapper) exposes exactly what `@bugsee/replay` needs — `record`, the event/masking types,
and the masking-option surface — decoupling `@bugsee/replay` from the underlying rrweb packaging. Internals: initially
`export { record } from '@rrweb/record'` (npm), later re-pointed at the Bugsee fork (git dep or vendored).

**Bugsee fork = upstream `rrweb-io/rrweb` + these ported Sentry patches** (MIT; preserve attribution). Curated
cherry-pick, NOT a blind replay of all commits:

- **Tier 1 — privacy (port first):** mask element attributes too (`placeholder`/`title`/`aria-label`); re-mask on
  attribute mutation; per-element input masking on `change` even when global input-masking is off; **password +
  detectable sensitive inputs hard-masked, never unmaskable**; tagName-casing masking fix.
- **Tier 2 — robustness (port; "a recorder bug never breaks the host page"):** cross-origin iframe `contentWindow`
  try/catch; CSP-safe `replaceSync` style parsing + inline MHTML parser; swallow `customElements.define` exceptions;
  `node.childNodes`/non-element `setAttribute` guards; blocked-image dimension fix; `ignoreCSSAttributes` for inline
  styles.
- **Tier 3 — perf/size (port the mechanism):** dead-code-eliminate `hooks`/`plugins`; build flags to disable
  iframe/canvas/shadow-DOM recording (aligns with D3's exclusions); canvas off by default (opt-in via
  `@bugsee/replay-canvas`).
- **Skip:** `@sentry-internal/*` renames, Sentry breadcrumb/envelope/segment coupling, `beforeAddRecordingEvent` glue,
  player/rrvideo changes.

**DONE (2026-07-08):** the fork `github.com/bugsee/rrweb` exists; branch `bugsee-port` carries the curated privacy
hardening (input hard-floors incl. sensitive-`autocomplete`, + attribute-value masking via a `maskAttributeFn` hook);
robustness was audited as already-in-upstream-2.1.0. `@bugsee/rrweb` consumes the fork via a **git dependency** on
`@bugsee/rrweb-record` (branch `bugsee-dist` — a prebuilt, record-only bundle, replay player tree-shaken out, ~56 KB
gzip), and `@bugsee/replay`'s masking config activates `maskAttributeFn`. Verified end-to-end by the real-rrweb e2e.
**Deferred:** the `unmask`/`unblock`/`maskAllText` selective-opt-out (needs a per-node hot-path rearchitecture — its
own slice) and Tier-3 size trimming.

---

## 5. Architecture

```
 replay option (default ON; skipped only on `replay: false`)
      │  lazy import('@bugsee/replay')  ← separate chunk; `replay:false` keeps the errors bundle ≤15KB
      ▼
 registerReplay(client, options)
      ├─ ReplayEncoder service  (EXPLICIT init w/ masking opts; container.getProvider('replay-encoder'))
      │     └─ fflate gzip in a Worker → replay.bin        [D5]
      └─ ReplayCaptureProvider  (rrweb record → 'replay' capture entries)   [D7]
              │  record({ emit, maskAllText, maskAllInputs, blockAllMedia, checkoutEveryNms, … })  [D3]
              ▼
        CaptureAggregator.addEntry({type:'replay', timestamp, data: eventWithTime})
              ▼  (existing) ring store, bounded by maxRecordingTime/maxDataSize
        bundle assembly (on report, if includeVideo) → serializeFileData('replay', events) → encoder → replay.bin  [D6]
```

**Components (each a build slice, §6):**
1. **`@bugsee/rrweb` wrapper** — `record` + types + masking option surface; npm-backed now, fork-backed later (D1/D2).
2. **Masking config** (`resolveReplayMaskingOptions(options)`) — fail-closed defaults → rrweb `record()` options +
   Bugsee-namespaced selectors (D3). Pure, heavily unit-tested (privacy is the risk surface).
3. **`ReplayCaptureProvider`** — extends `CaptureProviderBase`; `onStart` calls `record({ emit: e => this.capture('replay', e.timestamp, e) , …masking})`, `onStop` calls the stopFn; `controllingOption` = the replay option; `checkoutEveryNms` bounds the ring (D4/D7). `startBlackout`/`stopBlackout` pause/resume.
4. **`ReplayEncoder` service** — `encode(events): Promise<Uint8Array>` = fflate gzip in a Worker (D5); registered under `ReplayEncoderToken`; EXPLICIT-init with the masking/worker options.
5. **`FileType 'replay'` + assembler special-case** — `fileNameForType('replay') = 'replay.bin'`; `serializeFileData('replay', …)` routes through the encoder to bytes (D6). Requires the assembler to support a binary (async) file producer — a small, well-scoped core change.
6. **Launch wiring** (`@bugsee/browser` + umbrella) — unless `replay` is `false`: `await import('@bugsee/replay')`, `registerReplay(client, resolvedReplayOptions)`; `includeVideo` gates inclusion at report time (D4). Non-DOM: shim warn (D8).
7. **`@bugsee/replay-canvas`** (separate, opt-in) — passes rrweb's `getCanvasManager` into `record()`; own budget.

**Report-time coupling.** The recorder runs continuously; the ring holds the last window. `includeVideo` (default per
sdk-design) decides whether the `replay` entries are assembled into the bundle for a given `logException`. This reuses
the existing per-report file assembly — no new upload path.

---

## 6. Slice plan (each: design → red test → green → per-entity mutator loop → multi-agent review → commit)

**As-built status (2026-07-08): RP0–RP6 DONE + on main. `@bugsee/replay` records a real rrweb `replay.bin`
end-to-end.** As-built deltas from the plan are noted per slice.

- **RP0 — `@bugsee/rrweb` wrapper** ✅ (`635b531`) — npm-backed re-export (`record` + `eventWithTime`/`recordOptions`/
  `listenerHandler` types). Swappable: the fork swap edits ONLY `packages/rrweb/src/index.ts`.
- **RP1 — masking config** ✅ (`852a1b7`) — `resolveReplayMaskingOptions`: fail-closed defaults (maskAllText/Inputs +
  blockAllMedia), always-mask password, Bugsee `.bugsee-mask/.bugsee-block/.bugsee-ignore` selectors. Exhaustive
  privacy tests + mutator.
- **RP2 — `FileType 'replay'` + assembler binary-file support** ✅ (`c8fa989`) — **as-built delta:** the seam (O1) is an
  injected **`fileEncoders?: Partial<Record<FileType, (payloads) => Uint8Array>>`** on `BundleAssemblyContext`; JSON
  types stay byte-identical (encoder only applied when present).
- **RP3 — replay encoder** ✅ (`308ce44`) — **as-built delta (D5 revised):** SYNCHRONOUS stateless `encodeReplay(payloads)
  = gzipSync(strToU8(JSON.stringify(...)))` (fflate), not a worker service. Decode round-trip tested.
- **RP4 — `ReplayCaptureProvider`** ✅ (`9153c60`) — rrweb `record` → `replay` entries; `checkoutEveryNms` (def 60000),
  `recordCrossOriginIframes:false`, start/stop, blackout. Tests inject a fake `record` (mirror `log-provider.test`).
- **RP5 — launch wiring + lazy load** ✅ (core `28e4a6b` fileEncoders thread; register `bb44631`; browser `d2e14b8`) —
  `replay` option → `import('@bugsee/replay')` + `registerReplay(client, fileEncoders, options)`; a shared mutable
  `fileEncoders` map is passed by-ref to `createClient` and populated post-lazy-load. Verified: the main browser bundle
  inlines NO rrweb/fflate code (only the `import()` specifier) — errors bundle unchanged.
- **RP6 — real-rrweb e2e** ✅ (`74a9bfd`) — **as-built delta:** a **jsdom** real-rrweb integration test in
  `@bugsee/instrumentation-tests` (`test/replay.e2e.ts`, per-file `// @vitest-environment jsdom`; run via
  `pnpm test:e2e`). Boots the REAL `launchCore({replay:true})` → REAL lazy-loaded `@bugsee/replay` → REAL rrweb `record`
  on a jsdom DOM, throws, and asserts the ACTUAL uploaded bundle's `replay.bin` ungzips to a stream with a FullSnapshot
  (type 2) and that the secret is masked (**verified to DISCRIMINATE** — masking off ⇒ secret appears ⇒ test fails).
  **DEFERRED → RP6b:** a cross-browser **Playwright** run (needs Playwright infra + the fork wired; jsdom ≠ a real
  engine).
- **RP7 — `@bugsee/replay-canvas`** (opt-in add-on) — deferred/optional.
- **Fork track (parallel, user-gated):** the Bugsee rrweb fork EXISTS (GitHub, Bugsee org). Remaining: port Tier 1→3
  (§4) + repoint the `@bugsee/rrweb` wrapper import. Independent of RP1–RP6.

---

## 7. Testing strategy

- **Unit (vitest, jsdom):** masking config (pure), encoder (fake worker + fflate round-trip), recorder provider (fake
  `record` source — no real DOM needed; assert entries emitted + start/stop/blackout), assembler `replay` special-case,
  launch wiring (mock `import('@bugsee/replay')`). 100% line / ≥90% branch per the gate. Privacy paths get the harshest
  mutator scrutiny.
- **e2e (Playwright):** the only place a REAL rrweb `record()` runs against a real DOM — RP6 proves the end-to-end
  `replay.bin` + masking in a real browser.
- rrweb itself is not our test surface (it's the fork's); we test our masking-option mapping, the capture/encode/bundle
  integration, and the lazy-load wiring.

---

## 8. Open questions / deferred

- **O1 — assembler binary-file API shape.** Adding an async/binary file producer to the bundle assembler is the one
  non-trivial core change (RP2). Decide the exact seam (an injected `FileEncoder` map vs a per-type `serialize` that may
  return bytes/Promise) at RP2 design time; keep JSON types byte-identical.
- **O2 — `includeVideo` default.** Confirm the default (include replay in every report vs opt-in per `logException`);
  sdk-design keeps the Android key. Lean: include when replay is enabled + a report has buffered events.
- **O3 — continuous session mode** (D4 alternative) — a v1.x follow-up if product wants full-session replay, not just
  the pre-incident window.
- **O4 — the fork's maintenance/CI** (rebasing on upstream rrweb; which Sentry commits to re-check over time) — a
  fork-repo concern, out of this SDK repo.
- **O5 — `@bugsee/replay-canvas`** scope (RP7) — canvas recording is off by default + a known replay gap; opt-in add-on.
