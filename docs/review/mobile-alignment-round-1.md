# Review round 1 — JS/mobile API alignment (T1–T9)

Four read-only Opus reviews of PRs #37–#45 (2026-10-12): lifecycle + launch state (T1, T5), report payloads
(T3, T7, T8), privacy (T4, T9), API surface + options (T2, T6). Every finding below has a disposition. IDs are
`<review>-<n>`: **L** lifecycle/launch, **P** payloads, **V** privacy, **O** options/API.

Product decisions taken with this round:
- **User-identifier persistence is opt-in, default off** (PII) — already done in `3f27b81` (V3, V4, V5, V13 partly).
- `ReportHandler.after` becomes Android-canonical: it runs after `before` and BEFORE assembly, and may still mutate
  the report (L8).
- `relaunch()` without options resets Bugsee options to their defaults, like Android and iOS; integration seams
  (transport, carrier, clock, stores) are kept (L10).
- `detectHttpErrors` matches mobile: 5xx only, once per (method, normalized URL, status) per session (O2, O3).

Groups (each fixed test-first by its own agent; later merged and re-reviewed in round 2):

| Group | Findings | Area |
|---|---|---|
| G1 | L1 L2 L4 L8 L10 L11 L12 L13 L16 L17 V2 L-blackout-nesting(L3) | core client lifecycle, relaunch, ReportHandler.after |
| G2 | L5 L6 L7 L9 L14 L18 | node/browser stop + recovery safety, webworker/vercel-edge/webview parity |
| G3 | V1 V6 V7 V8 V9 V10 V11 V12 | blackout completeness (Electron, replay marker, WebView, timing, docs) |
| G4 | P1 P2 P3 P4 P5 P6 P7 P8 P9 | attachments / notify / skipFrames |
| G5 | O1 O2 O3 O4 O5 O6 O7 O8 O9 O10 O11 O12 | options resolver, detectHttpErrors, exports parity |

## Findings and dispositions

### L — lifecycle and launch state (T1, T5)
- **L1 major, fix (G1).** Launching/Launched are emitted inside launchCore before a listener can be registered, and a
  listener is lost on `relaunch()` (new client, new emitter). Android keeps one static listener. Fix: a
  process-level listener slot on the carrier and/or a `lifecycleEventsListener` launch option, read by every client's
  emitter; survives relaunch.
- **L2 major, fix (G1).** The listener runs synchronously before state changes; a listener that calls `launch()` on
  Launching starts providers/timers twice, `stop()` on Stopping double-stops. Fix: set state before emitting and/or
  deliver events after the transition (queue + microtask); re-entrancy tests.
- **L3 major (privacy), fix (G1).** A lifecycle subscriber that calls `startBlackout()` from BlackoutEnded makes
  `blackout.ts` deliver a stale `false` after the nested `true`, so replay resumes during a blackout. Fix: subscribers
  must act on `isActive()` (not the argument) and/or the lifecycle event is delivered after the other subscribers;
  test the nested case both ways.
- **L4 major, fix (G1).** `client.launch()` while `stop()` is draining: `isLaunched()` true but status Stopping, event
  order Stopping,Launching,Launched,Stopped, and the `finally` suspends the notify relay of the now-running client.
  Fix: a stop generation; a stale stop must not emit Stopped / suspend / clear `stopping`.
- **L5 major, fix (G2).** Node: `stop()` then `client.launch()` before the drain settles writes `.stopped` into a LIVE
  subtree; the next launch claims it and deletes it under a live writer (data loss, duplicate uploads). Fix: write
  the marker only if the client is still stopped and this is the latest stop; remove it on relaunch.
- **L6 major, fix (G2).** Node `stop()` does not await the launch-time recovery (`void runLaunchRecovery`), which may
  still stage bundles into the subtree being marked `.stopped`. Browser already awaits it. Fix: keep the promise,
  await it before `markStopped`, skip the marker if it is still running.
- **L7 major, fix (G2).** Browser releases its Web Lock and closes IndexedDB even when the drain timed out (Node does
  not mark a timed-out drain); another tab then re-uploads the in-flight bundle. Fix: release only when drained and
  recovery settled.
- **L8 major (parity), fix (G1).** `ReportHandler.after` must be Android's `onAfterReportCreated`: run after `before`,
  before assembly/upload, able to add attributes/labels/attachments; not called when nothing was created (assembly
  failure, queue overflow, no pipeline, veto). Settlement stays observable through the lifecycle events.
- **L9 major, fix (G2).** webworker and vercel-edge still clear the carrier slot unconditionally on stop; webworker
  never releases its coexistence lock/IDB; webworker/vercel-edge/webview never pass `launchOptionsView`
  (`getLaunchOptions()` returns `{}`); the `index.edge-light/worker/workerd` umbrella entries lack `getStatus`,
  `relaunch`, `BugseeStatus`.
- **L10 minor (parity), fix (G1).** `relaunch()` with no options reuses previous options; both mobile SDKs reset to
  defaults. Align (keep integration seams). Before-launch relaunch: warn + launch instead of reject only if that
  matches Android (verify).
- **L11 minor, fix (G1).** `getLaunchOptions()` / `getHostLaunchOptions()` return raw unvalidated host values;
  return the values actually in effect (normalized). (Overlaps O7.)
- **L12 minor, fix (G1).** The kill state leaves status Stopped without Stopping/Stopped events; emit them.
- **L13 minor, fix (G1).** `relaunch()` calls `stop()` with no timeout (can hang); a relaunch during an in-flight async
  browser launch gets the old client back and drops the new options. Fix both.
- **L14 minor, fix (G2).** Browser `stop()` on a killed (not launched) client never releases the lock / closes IDB.
- **L15 minor, fix (all groups).** Missing failure-path tests for L2–L7: add with each fix.
- **L16 minor (parity), fix (G1).** Blackout events fire when the client is not launched; Android refuses. Align.
- **L17 nit, fix (G1).** `AfterReportShown` fires before the dialog is removed and `sent` is true for `{ok:false}`.
- **L18 nit, fix (G2).** The carrier keeps the whole launch-options object (transport, onError, custom objects) on
  `globalThis.__BUGSEE__`; keep only what `relaunch` needs, never secrets.

### V — privacy (T4, T9)
- **V1 major, fix (G3).** Blackout does nothing in Electron: not forwarded to renderers (control channel has no such
  command), and the opt-in pixel video ignores it. Add a control command; renderers apply it via `BlackoutToken`;
  gate the pixel-video controller (drop frames + clear the ring for the span); e2e.
- **V2 major, fix (G1).** `relaunch()` silently ends a blackout (fresh state). Carry the blackout state across relaunch
  (mobile: process-wide).
- **V3 major, DONE `3f27b81`.** Persistence default is now off (PII, shared computers); docs say call
  `clearUserIdentifier()` on logout.
- **V4 major, DONE `3f27b81`.** With persistence off a stored value is removed at launch and `clearUserIdentifier()`
  always removes it.
- **V5 minor, DONE `3f27b81`.** `setUserIdentifier(null | undefined | non-string)` is a clear; never stores "null".
  (A length cap on the identifier is NOT added: neither mobile SDK caps it; dismissed.)
- **V6 minor, fix (G3).** Performance interactions check blackout at delivery time, not at event time: drop entries whose
  `startTime` falls inside a blackout span.
- **V7 minor, fix (G3).** Wheel deltas collected during blackout are emitted on the next frame; gate when collected
  and clear pending deltas on start/end.
- **V8 minor, fix (G3).** The post-blackout fresh snapshot can contain values typed during the blackout (with
  `maskAllInputs:false`); correct the recorder comment and public docs ("call `endBlackout()` after the sensitive
  view is gone"). No behaviour change.
- **V9 minor, fix (G3).** Mark blackout in the replay (rrweb custom events at start/end) so the player does not show a
  frozen pre-blackout screen as if it were live; viewer rendering is a separate follow-up (note it in the doc).
- **V10 minor, fix (G3).** In a WebView `startBlackout()` gates nothing; pass `BlackoutToken` to its input and UI
  breadcrumb providers.
- **V11 minor, fix (G3).** A page cannot load already blacked out; add launch option `startInBlackout`.
- **V12 nit, fix (G3).** Document precisely what continues during blackout (request bodies, navigation URLs,
  `video.aux` geometry); add a blackout entry to `docs/PROGRESS.md`; fix `docs/review/replay.md` #5 and
  `docs/review/browser.md` #6 which still call `startBlackout` dead code.
- **V13 nit, dismissed.** Old storage keys after token rotation are not cleaned up: acceptable (opt-in now, one small
  entry); documented.

### P — payloads (T3, T7, T8)
- **P1 major, fix (G4).** User attachments are JSON-serialised into the crash-recovery marker before the limits apply
  (3 MB bytes -> ~43 MB JSON, synchronous write; binary cannot be recovered). Fix: apply the limits at
  `createReportingRequest`/submit time and store attachments in the marker as base64 (or not at all with a documented
  loss on crash); test recovery round-trip of a binary attachment.
- **P2 major, fix (G4).** A non-string `fileName` (or `mimeType`) throws in assembly; the report is lost and the marker
  pinned forever. Validate types (drop the field, `onError`), guard the loop with try/catch so a bad attachment can
  never lose the report.
- **P3 major, fix (G4).** `notify()` sends `user:{id}`; the integrations read only `name`/`email` and Android sends
  `{email}`. Send `{email: id}`; fix the T7 findings doc claim.
- **P4 major, fix (G4).** Notifications are still sent and retried after `stop()` / kill (`flush()` and the retry timer
  re-arm). Add a stopped flag in the relay honoured by `flush`/`scheduleRetry`, cleared on launch; skip the flush in
  the kill state.
- **P5 major, fix (G4).** `skipFrames` larger than the stack hides every frame, so the worker gets no location or
  signature. Clamp to `frames.length - 1` and `onError` once.
- **P6 minor, fix (G4).** Notify queue is bounded by count only (1000 x 256 KB). Add a total-bytes cap (1 MB, like
  Android) and an age cap (72 h).
- **P7 minor, fix (G4).** `urgentSends = Promise.allSettled([urgentSends, attempt])` grows a chain; track a Set/counter.
- **P8 minor, fix (G4).** Recovery assembles without `onError` (silent drops); pass it.
- **P9 nit, fix (G4) where cheap.** Comments that say the limits "mirror the mobile SDKs" (only iOS has 3x3 MB);
  empty `data` accepted (iOS drops it); filename slice can split a surrogate pair, strip bidi override chars;
  export `addReportAttachment` from browser/node/umbrella; cap `domain` length (150, as the worker's Android path);
  honour `retryAfter` on 429; treat a 403 `KillSdk` from the relay as a kill.

### O — options and API surface (T2, T6)
- **O1 major, fix (G5).** An option passed explicitly as `undefined` counts as supplied: `captureNetworkDefaultSanitizer:
  undefined` DISABLES network redaction, `detectHttpErrors: undefined` ENABLES detection. Treat `undefined` as not
  supplied in the resolver; make consumers read `!== false`/`=== true` on validated booleans; non-boolean values warn
  and fall back.
- **O2 major, fix (G5).** `detectHttpErrors` differs from mobile (5xx only, per-session de-duplication on (method,
  normalized URL, status), severity High, domain `HttpError::Server`, attributes `http_status_code` / `http_method` /
  `http_url`). Match mobile; keep the 20/min limit as a backstop; list remaining differences under Kept differences.
- **O3 major, fix (G5).** Aborted requests (`AbortError`, aborted signal, destroyed node request) are reported as HTTP
  errors. Skip them (interceptors emit `abort` or the provider ignores aborts).
- **O4 minor, fix (G5).** Report text keeps PII in the URL path and every id becomes its own issue; template numeric ids,
  UUIDs, hex strings, JWTs and e-mail addresses in the path (Android `DetectorUrlSanitizer`), and put URL/status in
  attributes.
- **O5 minor, fix (G5).** Export parity: `getDefaultNetworkSanitizer` (and relaunch/getStatus for the same entries, owned
  by G2) on worker/workerd/edge-light; perf types (`Span`, `Transaction`, `PerformanceFacade`, `PerformanceApi`) on the
  node/bun/deno entries; meta-framework server entries (nextjs, remix, sveltekit, astro) re-export it; add an
  export-parity test across all entries.
- **O6 minor, fix (G5).** webworker/webview/vercel-edge/cloudflare launch-option interfaces do not declare the new
  options; `detectHttpErrors` is wired only in browser and node. Declare them; wire the provider wherever network
  capture is installed.
- **O7 minor, fix (G5).** `sdk.options` carries the raw value, not the one in effect (`'urgent'`, `'Verbose'`); write the
  normalized value back. (Shares code with L11: G5 owns the resolver, G1 consumes it.)
- **O8 minor, document (G5).** Electron: main's `captureBreadcrumbs` / `captureLogsLevel` / priorities do not apply to
  renderer data unless renderers get the same options; document as a kept difference (forwarding options in the
  session handshake is a follow-up).
- **O9 minor, fix (G5).** Invalid values are silent without `onError`; accept integer levels 1-5; ignore `undefined`.
- **O10 nit, fix (G5).** Stale comment in `browser/src/ui-breadcrumb-source.ts:235-244` ("no such option").
- **O11 nit, fix (G5).** `Object.freeze` the object returned by `getDefaultNetworkSanitizer()`.
- **O12 nit, document (G5).** `@internal` types are in the published d.ts and plain JS can still pass `trigger`;
  acceptable (type-level hiding); add a runtime strip of `trigger`/`mechanism` from the PUBLIC `upload`/`logException`
  entry points so plain JS cannot forge `code_dialog`.
