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
| Session replay (`@bugsee/replay`) | The rrweb recorder is STOPPED through its stop handle (its DOM observers are disconnected, not muted). Restarted at the end with a fresh Meta + FullSnapshot. A blackout in force before the lazy replay chunk loads means it never records. With the opt-in canvas add-on rrweb's own canvas recorder leaks a Worker / rAF loops per restart (it cannot be released or paused), so canvas recording is bounded to 4 recorder starts per page; after that replay restarts DOM-only and `onError` says so once. |
| Input presses / keys (`input.json`) | Dropped at the PROVIDER (at emission). Only the wheel is also gated at the source (below); presses and keys are not gated in the source itself. |
| Wheel / scroll deltas | Not collected while blacked out; pending (coalesced) deltas are cleared at both edges, so a turn made during a blackout is never flushed after it. |
| `ui.*` interaction breadcrumbs (focus/change/submit) | Dropped. |
| View hierarchy (`viewtree.json`) | A report built during a blackout carries none. |
| Performance interactions (`ui.interaction`, Event Timing) | Dropped when the interaction OVERLAPS a blackout span on the event clock, not merely when it is delivered during one (Event Timing entries arrive late). Spans are kept for 5 minutes (max 64). |
| Electron renderers | The main client's blackout is forwarded to every renderer over the control channel (`blackout-start` / `blackout-end`, and the state rides every `session` handshake reply; a main without a probe says `bo:false`). See "Electron renderers: three reasons to be dark" below. |
| Electron opt-in pixel video | On start the controller stops the source and CLEARS its buffer (frames just before the blackout are discarded too); snapshots are empty for the span, including one already in flight; the source restarts into an empty buffer at the end. |
| WebView (JS side) | The input and `ui.*` providers (and the wheel source) take the client's gate like the browser tier. The shared input source is re-bound to the CURRENT client's gate on every launch, so a relaunch does not leave it reading the dead client's state. |
| WebView (NATIVE host video) | **Not stopped by this SDK alone.** The pixels of a WebView are recorded by the native host (its video / screenshots). Every blackout change is sent over the bridge as a `blackout` message (`{b,k:'blackout',a,ts}`, in `bridge-protocol.schema.json`) and the host must pause AND clear its video while `a` is true, declaring support with `config.blackout: true` in its control reply. Until the host does, or when no native bridge is attached, the first blackout reports through `onError` that the native video is NOT paused. **Receiver contract:** (1) a blackout CARRIED over a relaunch is posted right after `hello` (the current state, `a:true`), since no change event exists for it; (2) `a:false` NEVER ends native's OWN blackout: native keeps a separate flag for its own reasons (its own `startBlackout`, a sensitive native screen) and keeps its video paused while EITHER that flag or the JS-reported one is set; (3) the "native has not declared blackout support" warning is judged only after native answered the handshake (the control reply): the first announcement made while no reply has arrived waits for it, and a second change before any reply stops waiting and warns. **Follow-up (other repos):** the Android and iOS receivers must handle `k:'blackout'` and declare `config.blackout`; until they ship, a blackout in a WebView protects JS-side capture only. |

## State rules

- `startBlackout()` is ignored while the client is not launched (no state change, no events: there is nothing to
  black out), as on Android; `startBlackout()` before `launch()` is therefore a no-op, use `startInBlackout` for a
  blackout from the first frame. `endBlackout()` is DIFFERENT: it is honoured while the client is not launched
  (before the first `launch()` and after `stop()`). It clears the carried process flag silently (no events: nothing
  is being captured for them to describe), because a blackout that could not be lifted would make the next launch
  start dark with no event to say why. Android no-ops there; this is a kept difference
  (`mobile-api-alignment.md`, Kept differences).
- The state is process-level: it lives on the carrier, so `relaunch()` (a new client) keeps a blackout in force
  silently, and the lifecycle listener does not see a Started/Ended pair for the carry. A carried blackout is
  still ended with `endBlackout()` (also while the client is stopped: the carried flag is cleared silently).
- Listener re-entrancy is bounded. A listener that keeps toggling the blackout from inside its own notification
  is cut off after 100 rounds and the blackout is FORCED ACTIVE (fail closed): every out-of-date listener,
  including replay and the carrier writer, is told "active" once, further `start`/`end` calls made by listeners
  during that final delivery are ignored, and `onError` reports it. The application can end it afterwards.
- Lifecycle events: `BlackoutStarted` / `BlackoutEnded` are emitted for the application's own transitions only.
  `startInBlackout` emits `BlackoutStarted` AFTER `Launching` (never before it), and only when that launch raised
  the blackout. Internal bookkeeping (the Electron launch hold, the handshake release) is silent.

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

It is applied before any provider starts, so no provider can observe an un-darkened moment, and a replay chunk
that loads later reads the gate as already active.

The safe side is DARK, so the option fails ON: any value that is not boolean `false` (`'true'`, `'false'`, `1`, `0`,
`null`, `''`, an object) starts the page dark and is reported through `onError`; only `false` / absent start it
un-darkened. The Electron renderer follows the same rule (and so does the internal launch hold `holdBlackout`).
Every other privacy option has an explicit fail direction too, pinned by `packages/bugsee/src/option-directions.test.ts`:
options that collect more data fail OFF, protective ones (`startInBlackout`, WebView `captureObscuring`, performance
`sanitizeSpans`) fail ON, and the rest keep their default and report.

## Electron renderers: three reasons to be dark

A renderer is dark while ANY of three independent flags is set, so none can end another's blackout:

1. **launch hold** - set at launch (silent, internal option `holdBlackout`), released ONLY by the session
   handshake. Nothing is captured before the renderer knows main's state. If no handshake ever arrives (no
   preload bridge) the renderer stays dark: fail closed. `blackout-start` / `blackout-end` / app calls before
   the handshake cannot open the hold.
2. **main's state** - `blackout-start` / `blackout-end` and the handshake's `bo`. The reply's `bo` is applied
   before the hold is released, so a dark main never flickers the renderer light.
3. **app-local state** - the renderer's own `startBlackout()` / `endBlackout()` and an explicit
   `startInBlackout: true` (which therefore survives a `bo:false` reply). Main's `blackout-end` does NOT end it,
   and the app's `endBlackout()` does not end main's.

The application is told (`BlackoutStarted` / `BlackoutEnded`) about the union of 2 and 3 only, never about the hold.

`launchRenderer()` is one instance per page: a second call (a hot reload) while the page's client is live or still
launching is a no-op returning that client. After main stopped the client a new call launches a fresh one, which
treats a CARRIED blackout as the app's own (the handshake's `bo:false` does not end it; `endBlackout()` does), and
`endBlackout()` on a stopped renderer client lifts every reason quietly (same rule as the kernel).

## Replay marker (viewer follow-up)

At blackout start and end the recorder emits an rrweb custom event (type 5) with tag `bugsee.blackout` and
`payload: { active: true | false }`, so the stream says "recording was suspended here" instead of jumping from
the last pre-blackout DOM to the post-blackout DOM (which a player shows as a frozen screen). It is backwards
compatible (players ignore custom events they do not know). **Follow-up (viewer repo):** render a "blacked out"
overlay between the two markers. The end marker is only emitted for a blackout whose start marker was emitted:
a blackout that began before recording (`startInBlackout`, or before the lazy replay chunk loaded) has no markers
at all, so the stream never contains an orphan `{active:false}`; the end marker lands BEFORE the fresh snapshot.

## Known limits

- A blackout begun in an Electron renderer by the app itself is local to that renderer; only main's blackout is
  forwarded. Main's `blackout-end` does not end a renderer-local one (they are separate flags, above).
- The webview and webworker tiers do not (yet) offer `startInBlackout`.
- WebView native video depends on receiver support (above). Electron pixel video is gated in the main process;
  a pending macOS permission check cannot start the source after `stop()`.
- Pending incident markers keep the `userIdentifier` they captured; that is an identifier-privacy limit, not a
  blackout one (see PROGRESS, user identifier persistence).
