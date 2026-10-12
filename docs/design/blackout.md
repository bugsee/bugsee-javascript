# Blackout (`startBlackout` / `endBlackout` / `isBlackout` / `startInBlackout`)

**Status:** built (kernel state in `@bugsee/core`; gated sources per platform). This document is the precise
contract: what a blackout stops, what it deliberately does NOT stop, and what an integrator must do.

Mobile parity: Android `Bugsee.startBlackout()/endBlackout()/isBlackout()`, iOS `Bugsee.h`. Idempotent and NOT
counted: one `endBlackout()` ends any number of `startBlackout()` calls.

## Mechanism

`@bugsee/core` owns one boolean and its change subscription (`BlackoutToken` / `BlackoutGate`). The kernel does
not know which providers are visual: each visual source is handed the read-only gate and decides for itself.

## What a blackout STOPS (visual / interaction capture)

| Source | Behaviour while blacked out |
|---|---|
| Session replay (`@bugsee/replay`) | The rrweb recorder is STOPPED (not muted). Restarted at the end with a fresh Meta + FullSnapshot. A blackout in force before the lazy replay chunk loads means it never records. |
| Input presses / keys (`input.json`) | Dropped at the provider and at the source. |
| Wheel / scroll deltas | Not collected while blacked out; pending (coalesced) deltas are cleared at both edges, so a turn made during a blackout is never flushed after it. |
| `ui.*` interaction breadcrumbs (focus/change/submit) | Dropped. |
| View hierarchy (`viewtree.json`) | A report built during a blackout carries none. |
| Performance interactions (`ui.interaction`, Event Timing) | Dropped when the interaction OVERLAPS a blackout span on the event clock, not merely when it is delivered during one (Event Timing entries arrive late). Spans are kept for 5 minutes (max 64). |
| Electron renderers | The main client's blackout is forwarded to every renderer over the control channel (`blackout-start` / `blackout-end`, and the state rides every `session` handshake reply). A renderer launches blacked out and is released by the handshake, so nothing is captured before it knows main's state. Renderers apply it through `BlackoutToken`. |
| Electron opt-in pixel video | On start the controller stops the source and CLEARS its buffer (frames just before the blackout are discarded too); snapshots are empty for the span, including one already in flight; the source restarts into an empty buffer at the end. |
| WebView | The input and `ui.*` providers (and the wheel source) take the client's gate like the browser tier. |

## What a blackout does NOT stop (be explicit with your users)

These continue by design (mobile parity: logs, network, traces and events carry on). They can carry sensitive
data, so an integrator hiding a sensitive screen must consider them separately:

- **Network events, including request and response BODIES** (subject to `captureNetworkBodies`, the size limit
  and the default sanitizer / your `networkFilter`). A request made from the sensitive view still ships its
  URL, headers and body. Turn bodies off or sanitise them if the sensitive view talks to your API.
- **Navigation URLs.** Route changes keep feeding the performance extension (transaction names, paths) and
  request URLs stay in the network stream.
- **`video.aux` geometry** (the viewport/frame record the `input` coordinates are placed on). It describes the
  window size over time, not content, and is not gated.
- Console logs, `client.log/event/trace`, app breadcrumbs, system traces and events, errors and crash reports
  (a report built during a blackout simply has no replay-since-start, input, viewtree or pixel video for the
  span).

## IMPORTANT: end the blackout only after the sensitive view is gone

`endBlackout()` restarts replay with a fresh full snapshot taken from the LIVE page. If the sensitive view is
still on screen, that snapshot contains whatever it holds at that moment, **including values typed during the
blackout when `maskAllInputs` is `false`** (with the default `maskAllInputs: true` they are masked). Call
`endBlackout()` after the view has been removed or cleared.

## Starting already blacked out: `startInBlackout` (browser)

A page that renders sensitive content from its first frame has no moment to call `startBlackout()` before
capture can begin. The browser launch option `startInBlackout: true`
(`com.bugsee.option.capture.start-in-blackout`, default `false`) raises the blackout BEFORE any provider is
added or started: nothing visual or interaction-related is captured until `endBlackout()`.

Electron renderers always launch with it set and are released by the session handshake (main's blackout state).
If a renderer never completes the handshake (no preload bridge) it stays dark: fail closed.

## Replay marker (viewer follow-up)

At blackout start and end the recorder emits an rrweb custom event (type 5) with tag `bugsee.blackout` and
`payload: { active: true | false }`, so the stream says "recording was suspended here" instead of jumping from
the last pre-blackout DOM to the post-blackout DOM (which a player shows as a frozen screen). It is backwards
compatible (players ignore custom events they do not know). **Follow-up (viewer repo):** render a "blacked out"
overlay between the two markers.

## Known limits

- A blackout begun in an Electron renderer by the app itself is local to that renderer; only main's blackout is
  forwarded. Main's `blackout-end` also ends a renderer-local one (main is authoritative).
- The webview and webworker tiers do not (yet) offer `startInBlackout`.
