# Viewer wire compatibility (JS SDK ↔ dashboard)

Status: **Recommendation for parallel SDK work** — 2026-08-05.  
Companion: Bugsee `viewer` ingest normalizer (`js-sdk-resource-normalize.ts`).  
Do **not** treat this as an implement-now mandate in the SDK; the viewer already tolerates today’s as-built wire. Use this when touching emit paths so SDK and viewer workstreams do not thrash.

---

## 1. Context

The JavaScript SDK ships incident bundles (`*.bundle.zip`) with shapes that diverge from the mobile/Android envelope the dashboard historically consumed:

| Area | JS SDK as-built | Mobile / historical viewer |
|---|---|---|
| Capture JSON files | Top-level **arrays** | `{ version, events\|logs\|traces }` |
| `logs.json` `level` | String names (`"error"`) | Numeric 1–5 |
| Connection network stages | Flat `type: "message"` + `direction` | `type: "websocket"` + `event: "send"\|"message"` |
| `abort` | `type: "abort"` | Viewer HTTP path expects `cancel` |
| `replay.bin` recovery | May be ungzipped JSON | Player expects gzip (with fallback) |

The **viewer** now normalizes these at ingest so Console / Network / Events / Traces / Breadcrumbs / rrweb replay render for current SDK builds. This doc lists **recommended SDK emit fixes** so the interim viewer shim can shrink over time without breaking old bundles (viewer keeps tolerance).

---

## 2. What the viewer already tolerates

Implemented in the viewer (no SDK change required for display):

1. Bare-array envelopes for `log`, `network`, `events.*`, `traces.*`, `breadcrumbs`.
2. String → numeric log level mapping (`error→1` … `verbose/trace/log→5`).
3. Network rewrite: `ws`/`sse`/`webtransport` `before` → `websocket`+`create`; `message`+`direction` → `send`/`message`; `abort` → `cancel`; `customError` → `error`/`custom.error`; derive `size` from `custom.body` length when missing.
4. Connection UI detection via `mechanism ∈ {ws,sse,webtransport}` (not only first-stage type).
5. Replay: seek anchor = first rrweb event timestamp; decode gzip **or** raw JSON for `replay.bin`.
6. List “has visuals” treats `type: "replay"` like video; `electron-main` uses the non-visual placeholder when no replay.

---

## 3. Recommended SDK emit fixes (SDK-owned)

Apply these when the relevant packages are already open for change. Prefer dual-write / additive fields so older viewers keep working.

### 3.1 Call `logLevelToWire` on every log entry

- **Where:** log capture / console interceptor emit path (`@bugsee/protocol` helper already exists; callers missing — see review Wave 5.1).
- **Wire:** `logs.json` entries use numeric `level` 1–5 per §8.4 / Android parity.
- **Why:** Viewer CSS, filters, and icons key on numbers; string levels only work via the temporary normalizer.

### 3.2 Dual-write connection stages for the viewer/Android encoding

As-built JS emits (example WS frame):

```json
{ "type": "message", "direction": "out", "mechanism": "ws", ... }
```

Viewer/Android historically expect:

```json
{ "type": "websocket", "event": "send", "mechanism": "ws", ... }
```

**Recommendation:** keep `direction` (useful) **and** set `event` (`send`|`message`|`open`|`close`|`create`|`error`) with `type: "websocket"` for connection lifecycle, matching §8.7 design text. Do not remove `direction` until the viewer drops its rewrite.

Same for SSE (`direction: "in"` always) and WebTransport session stages.

### 3.3 Always gzip `replay.bin` on recovery paths

- Recovery / durable-queue assembly must thread `fileEncoders.replay` (`encodeReplay` → fflate gzip).
- A plain-JSON blob named `replay.bin` works in the viewer only via fallback; do not rely on that long-term.

### 3.4 Clock contract for replay sync

- rrweb `eventWithTime.timestamp` and `manifest.time.start`/`end` are absolute unix ms.
- Viewer seeks with `pause(position - firstReplayEvent.timestamp)`.
- Prefer `manifest.time.start ≤ min(replay event timestamps)` (already true if start = min across all capture types). Avoid remapping replay timestamps to relative offsets.

### 3.5 Gaps the viewer cannot invent (still SDK product work)

| Gap | Notes |
|---|---|
| WS/SSE **payloads** | Interceptors never attach frame bodies; frames show empty body in the UI |
| `size` | Optional on wire; never set by interceptors (viewer derives from body when present) |
| Rich timings | Only `{ duration }` on complete today; no dns/connect Resource Timing |
| Mobile envelope | Optional `{ version: 2, events: [...] }` would match `report-bundle-structure`; not required while viewer wraps arrays |

---

## 4. Detection contract (stable)

| Question | Authority |
|---|---|
| Is this a JS SDK report? | `environment.sdk.type === "javascript"` |
| Browser vs node vs edge? | `environment.platform.type` |
| Show rrweb player? | Manifest file `type === "replay"` (signed URL to `replay.bin`) — **not** platform alone |

Do not use `x-client-type` as the JS/replay discriminator.

---

## 5. Coordination

- **Viewer** owns ingest tolerance + replay player; keep normalizer until SDK emit recommendations land and old bundles age out.
- **SDK** owns emit correctness; land §3 fixes in small PRs that do not race viewer work.
- When dual-write (§3.2) and numeric levels (§3.1) ship, open a follow-up viewer PR to narrow the normalizer (keep bare-array wrap for one release cycle).

---

## 6. References

- Design: [`sdk-design.md`](./sdk-design.md) §8.4 file types, §8.7 network, §11 replay
- Protocol: `packages/protocol/src/wire.ts`, `packages/protocol/src/levels.ts` (`logLevelToWire`)
- Replay encode: `packages/replay/src/encoder.ts`
- Assembler (bare arrays): `packages/core/src/bundle-assembler.ts` `serializeFileData`
- Reviews: `docs/review/protocol.md` SEV1 (levels + direction), `docs/review/REMEDIATION-PLAN.md` Wave 5
- External mobile contract: `report-bundle-structure/bundle/network.md`
