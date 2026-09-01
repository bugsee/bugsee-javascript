# Capture-API research — what else could the SDK observe?

Parallel research into runtime and framework APIs that could yield telemetry the SDK does not
currently collect. Each file below is one researcher's raw findings; `SYNTHESIS.md` is the converged,
classified table.

## What the SDK already captures (do NOT re-propose these)

`log` (console + `client.log`) · `network` (fetch, XHR, WebSocket, SSE, WebTransport, sendBeacon,
`node:http`, `Bun.serve`, `Deno.serve`) · `traces.system` (memory, connection, orientation) ·
`events.system` · `input` (pointer/key) · `viewtree` (report-time DOM snapshot) · `replay` (rrweb) ·
`breadcrumbs` (incl. the new `ui.*` state-change crumbs) · `crash` · `performance` (web-vitals +
APM transactions/spans, OTel-exportable) · `profile` (V8 CPU) · ANR / event-loop-hang detection.

## The shared table schema — every researcher emits this, so the tables concatenate

| column | meaning |
|---|---|
| **API** | The exact identifier, e.g. `PerformanceObserver('long-animation-frame')` |
| **Where** | Runtime/browser/framework + minimum version, and whether it is standard, de-facto, or vendor-only |
| **Yields** | What data you actually get, concretely — not "performance info" but "renderStart, blockingDuration, and the attributed script's URL and character position" |
| **Shape** | `event` (discrete) · `stream` (continuous) · `sample` (periodic poll) · `snapshot` (on demand, e.g. at report time) |
| **Maps to** | An existing Bugsee stream, or NEW — and if new, say which of span / metric / log / breadcrumb it is in OTel terms |
| **Cost** | Overhead, honestly: allocation per event, main-thread work, whether it forces layout/GC, whether it is off by default for a reason |
| **Availability** | Feature-detection, permission or flag required; what happens where absent |
| **Privacy** | What a customer's end user could be exposed by it. Be specific — "URLs may contain tokens", not "some risk" |
| **Confidence** | `verified` (you read the spec/docs and confirmed the shape) · `documented` (docs say so, unverified) · `unverified` |

## Rules

- **Cite a URL for every row.** No row without a source.
- **Do not invent APIs.** If unsure whether something exists in a runtime, mark it `unverified` and say so.
- Prefer APIs that yield data a *support engineer debugging a customer's incident* would actually want.
- Note explicitly where an API is a **better source for something we already capture badly**, not only net-new data.
