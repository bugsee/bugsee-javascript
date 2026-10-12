# Review round 2 — JS/mobile API alignment (fixes of round 1, `83327ee..e2f928c`)

Four fresh read-only Opus reviews (2026-10-12): lifecycle/relaunch/carrier (**L2**), blackout + identifier privacy
(**V2**), payloads/notify/options (**P2**), tests/docs/public API (**D2**). Findings below are NEW (regressions of the
round-1 fixes, misses, bad interactions between fix groups). IDs: `R2L-n`, `R2V-n`, `R2P-n`, `R2D-n`.
Round 1: `docs/review/mobile-alignment-round-1.md`.

Product decisions taken with this round:
- `relaunch()` keeps ALL integration seams AND the deployment identity (endpoint, appId/appVersion/appBuild,
  platformType, persist/recover, runtime scope handles) but resets Bugsee behaviour options (R2P-3).
- Privacy options whose default is ON are **fail-closed on invalid values** (a value that is not boolean `true` turns
  them OFF, with an `onError` report), e.g. `captureNetworkBodies` (R2P-4). Options whose default is OFF only turn on
  for boolean `true`.
- Android DOES persist the user identifier (corrects a wrong claim in PROGRESS/T9 notes); JS stays opt-in (PII).
- Mobile APIs still without a JS equivalent (`deleteCollectedDataOnDevice`, `addNetworkEvent`, `logUnhandledException`,
  `testCrash`, on-demand `captureViewHierarchy()`, runtime secure-view/rect APIs, `MaxPending*` options) are recorded
  in the plan as follow-ups and are NOT part of this round.

Groups (each fixed test-first by its own agent): **F1** lifecycle/stop safety, **F2** blackout/privacy, **F3**
payloads/options, **F4** exports/docs/tests.

## Findings and dispositions

### R2L — lifecycle, relaunch, carrier (F1 unless noted)
- **R2L-1 major, fix.** A second `stop()` while the first still drains (or after a timed-out one) returns "drained"
  at once (`client.ts` `!launched` path); node then writes `.stopped` and browser/webworker release the lock while the
  first stop's upload is still running (duplicate upload / live subtree claimed). Keep the in-flight drain promise in
  core and return it from a repeat `stop()`; platforms treat "core Stopping" as not drained; keep the killed-client
  release path separate. Reproduced by the reviewer (node, hung transport).
- **R2L-2 major (regression of L8), fix.** `ReportHandler.after` runs only inside `assembleReport`, which is not built
  when a `triggerPipeline` is injected (Electron renderer, WebView): the app's `after` never runs there. Call it before
  `triggerPipeline.report(handled)` too (it is synchronous); tests for Electron renderer and WebView.
- **R2L-3 major, fix.** `client.launch()` after `stop()` restarts only core: node heartbeat, exit/signal handlers,
  server instrumentation and carrier slot stay torn down (double clients, live subtree declared dead after 120 s);
  browser pagehide flush and webworker carrier not restored. Make the platform `launch()` re-arm what `stop()` tore
  down (or refuse `launch()` on a stopped platform client — choose the smaller safe design and test it).
- **R2L-4 minor+major(D2-1), fix.** L1/V2 only reached node/browser: webworker, vercel-edge (also cloudflare, workerd,
  edge-light) and webview call `createClient` without `carrier` and without the `lifecycleEventsListener` option, so
  Launching/Launched are unobservable there, a relaunch loses the listener and ends a blackout. Declare + forward the
  option, pass `carrier: carrier ?? globalThis`; extend `export-parity.test-d.ts`.
- **R2L-5 minor, fix.** The event queue + `delivering` flag are per emitter but the listener slot is shared on the
  carrier: a listener calling `launch()`/`relaunch()` from client A's Stopped gets B's Launching/Launched nested.
  Keep queue/flag on the carrier next to the slot.
- **R2L-6 minor, fix.** `relaunch()` builds a new client; the old client's queued (offline) notifications are never
  resumed or handed over. Hand the queue over (or flush it before stop within the stop timeout) and test.
- **R2L-7 minor, fix (shared with R2V-6).** A carried blackout cannot be ended while stopped (`endBlackout()` is
  refused, the carrier flag stays true): the next launch starts dark without a BlackoutStarted event. Allow `end()` to
  clear the carrier state while stopped (no events), keep fail-closed on `start`.
- **R2L-8 minor, fix.** `relaunch()` gives up waiting for an in-flight launch after 5 s: with no `lastLaunch` it rejects
  "before launch()" although a launch is in flight, or races two builds. Wait for the pending launch without the bound
  (the bound applies to the OLD client's drain only).
- **R2L-9 minor, fix.** A stale WebView `stop()` clears the carrier slot and `launchedClient` unconditionally; use an
  ownership-checked clear.
- **R2L-10 minor, fix.** Webworker `stop()` closes IndexedDB without flushing the capture store (browser flushes first).
- **R2L-11 nit, fix.** `RELAUNCH_KEPT_OPTIONS` (24 keys) pins transport, stores, window/document, indexedDB etc. on
  `globalThis` after the client is gone; accept (decision above) but document it, and add the platform-level
  "no options means defaults" tests back (node/browser L10 tests were changed to `relaunch(opts())`).
- **R2L-12 nit, fix.** The kept `carrier` seam does nothing for a plain `relaunch()` after `launch(t, {carrier: X})`
  (looks on `globalThis`); look it up from the remembered options.
- **R2L-13 nit, fix.** The kill path does not bump `generation`, contradicting the comment in `client.ts`.
- **R2L-14 nit, fix.** Node `launch()` on a killed client still clears the stop marker though core launch is a no-op.
- **R2L-15 nit, fix.** Two listeners (one stops on Launched, one launches on Stopping) can loop forever
  synchronously: cap the re-entrant rounds like blackout (fail closed: stop delivering, `onError`).
- **R2D-2 major, fix (F1).** `RelaunchedAfterCrash` is exported but never emitted. Emit it when launch recovery finds
  evidence that the previous run did not stop cleanly (node: a recovered dead-sibling subtree / crash marker; browser:
  recovered incident marker) or, if no honest signal exists on a platform, document it as not emitted there. No fake
  emits.

### R2V — blackout and identifier privacy (F2)
- **R2V-1 major, fix.** Electron: `launchRenderer` returns before the handshake reply; an app that calls
  `startBlackout()` right after `await launchRenderer()` is a no-op (still in the launch hold) and the reply's
  `bo:false` then ENDS the blackout (also overrides an explicit `startInBlackout: true`). Keep three separate flags:
  launch hold (released by the handshake only), main's state (`blackout-start/end`), app-local state; dark if any is
  set. Test the exact sequence.
- **R2V-2 major, fix.** WebView: `startBlackout()` does not stop the native host's video (no blackout message in
  `protocol.ts`). Add a bridge message kind the native receivers can apply, warn through `onError` when native does
  not acknowledge, and list the limit in `docs/design/blackout.md` until native support lands (the Android/iOS
  receivers live in other repos: file the follow-up).
- **R2V-3 minor, fix.** Carrier-shared input sources stay bound to the FIRST client's blackout gate after
  `relaunch()` (wheel flush after `endBlackout()` leaks again; a relaunch during a blackout never captures wheel
  again). Late-bind the gate to the current carrier client (like the viewtree's `clientRef`). Reproduced
  (`r2v-wheel.mts`).
- **R2V-4 minor (fail-open), fix.** The 100-round redelivery cap can leave a subscriber (replay!) in the wrong state;
  the client's own lifecycle listener is subscribed first. At the cap force the state to ACTIVE (fail closed),
  ignore re-entrant `set()` during delivery, deliver once to every out-of-date listener incl. the carrier writer.
  Reproduced (`r2v-cap.ts`).
- **R2V-5 minor, fix.** `setUserIdentifier(non-string)` is a clear only in the browser wrapper; node/bun/deno/worker/
  edge/webview/Electron main use the core setter, which stores the raw value and ships it as `email` in request.json
  and notify. Normalise in core `Environment` (non-string -> clear; `getUserIdentifier()` returns `null`).
- **R2V-6 minor, fix.** See R2L-7.
- **R2V-7 minor, fix.** Each `endBlackout()` restart with canvas replay leaks rrweb internals (a Worker per cycle,
  rAF loops); and the comment at `recorder.ts:87-89` overclaims. Pause canvas sampling instead of a full restart if
  the fork allows it, else terminate on stop via the fork API / cap restarts; correct the comment.
- **R2V-8 minor, fix.** `createElectronMainControl` without `isBlackout` leaves renderers dark forever; send `bo:false`
  when no probe is given (or make it required in the type).
- **R2V-9 minor, fix.** Electron pixel video can start after `stop()` (pending `hasPermission()`); stop generation
  checked after the await.
- **R2V-10 nit, fix.** `docs/design/blackout.md` inaccuracies ("input presses/keys dropped at source" - source gates
  wheel only) and missing statements (carry across relaunch/stop, start/end ignored while not launched, the handshake
  rule, WebView native video).
- **R2V-11 nit, fix.** `startInBlackout` emits BlackoutStarted before Launching and Electron renderers emit a spurious
  Started/Ended pair; suppress events for the launch hold.
- **R2V-12 nit, fix.** Orphan `bugsee.blackout {active:false}` marker with `startInBlackout`/pre-chunk blackout; emit
  `true` first or none (document the viewer follow-up).
- **R2V-13 nit, fix (docs).** Incident markers in IndexedDB/disk keep `userIdentifier` until upload and
  `clearUserIdentifier()` does not scrub them: document in the option JSDoc and PROGRESS ("nothing is written" is
  about the identifier store only); scrub pending markers' `userIdentifier` on clear if cheap.

### R2P — payloads, options, capture (F3)
- **R2P-1 major (regression of O12), fix.** The public `logException` wrapper becomes the top frame for non-Error
  throwables (`callSiteFrames` trims only at the internal named `logException`): every `logException('str')` groups
  under `Object.logException`; `skipFrames` skips the wrong frame. Pass a boundary the wrapper supplies; tighten the
  test to "first frame is `applicationCode`". Reproduced.
- **R2P-2 major, fix.** `retryAfter` has no floor: `Retry-After: 0` or body `retryAfter: 0.0001` => 2283 requests in
  3.2 s; the appserver itself answers 429 `retryAfter:1` for an oversize batch (`notify_max_batch_size`) forever. Use
  `max(hint, RETRY_INITIAL_MS)`, keep exponential backoff, halve the batch on repeated 429. Reproduced.
- **R2P-3 major, fix.** `RELAUNCH_KEPT_OPTIONS` drops `endpoint`, `appId/appVersion/appBuild/platformType`,
  `persist/recover`, `asyncLocalStorage`, `partitionCaptureByTenant`, `globalScope/globalTarget/logger` -> a relaunch
  uploads to the default production endpoint (data-residency) with wrong app version. Keep them (decision above).
- **R2P-4 major (privacy fail-open), fix.** Validation turned invalid values of `captureNetworkBodies` (default ON)
  such as `0 | null | ''` from OFF into ON. Fail closed: for ON-by-default privacy options anything that is not boolean
  `true` is OFF (+ `onError`); apply to every privacy-relevant option and add a table test.
- **R2P-5 minor, fix.** Browser/node options read by truthiness (`persistUserIdentifier: 'false'` persists PII;
  `startInBlackout`, `captureViewHierarchy`, `captureInteractions`, report-UI flags, node `profiling`, `detectHangs`):
  add `...boolean` normalisers; invalid `notifyFlushDelay` must report; the dialog error message lists `verylow`.
  (Also R2D-11.)
- **R2P-6 minor, fix.** A throwing user `onError` still loses the report (assembly passes the raw `onError`); wrap in
  the catch / pass `onErrorSafe`. Reproduced.
- **R2P-7 minor, fix.** What `ReportHandler.after` adds is not in the crash-recovery marker (written at submit):
  recovered report differs from the live one. Document AND, since `after` is synchronous, run it before the marker is
  written for the handler-built request path where possible; keep assembly-time limits.
- **R2P-8 minor, fix.** URL templating misses short ids / PII: nanoid (21), Firebase push ids (20), `ord_12345`,
  `42.json`, `+15551234567`, IPs, dates; over-templates long slugs containing a digit. Add rules (parity with
  Android where it exists); no ReDoS (verified up to 1e6 chars). Also uppercase `LONG_HEX` (mutation survivor m13)
  and uppercase `method` in the dedup key.
- **R2P-9 nit, fix.** `decodeRequestFromMarker` with non-string `dataBase64` decodes garbage (check `typeof`);
  frozen report => `normalizeReportAttachments` throws and the marker then base64-encodes UNLIMITED attachments
  (re-opens P1: apply limits before encoding in the catch path); 3x3 MB base64+JSON is ~279 ms synchronous: chunk or
  document; `asInternalClient(browserPublicClient)` loses `reportDefaultBugPriority` (document/fix with R2D-3);
  `getDefaultNetworkSanitizer` missing from electron/vercel-edge/webworker/cloudflare/nuxt-server entries (R2D-4).
- **R2D-3 major, fix (F3).** `reportDefaultBugPriority` only affects the browser dialog; `client.upload()`, node, edge,
  worker ignore it (Android applies it to every bug report). Move it to `COMMON_OPTION_DEFINITIONS`, apply it in
  core `applyReportBefore` for derived bug severities.

### R2D — exports, docs, tests (F4 unless noted)
- **R2D-1 major, fix** = R2L-4 (option on worker/edge/webview) — owned by F1.
- **R2D-2** = owned by F1 (above).
- **R2D-3** = owned by F3 (above).
- **R2D-4 major, fix.** Directly imported packages lack the new value exports (`BugseeStatus`, `LifecycleEvents`,
  `getStatus`, `relaunch`, `addReportAttachment`, `getDefaultNetworkSanitizer`): vercel-edge, cloudflare, webworker,
  webview, electron (main/renderer), nextjs/remix/sveltekit/astro `/server` + `/edge`, astro/nuxt `/client`. Re-export
  from each (thin, same functions) and extend the parity tests to those packages. Check umbrella `relaunch` vs
  Next's `registerServer` defaults (document if relaunch re-runs the plain umbrella launch).
- **R2D-5 major, fix (docs).** `maxDataSize` (`config.data-size`, rolling capture buffer) is a different option from
  Android/iOS `config.max-data-size` (disk cap on pending reports, default 150/50): add to Kept differences.
- **R2D-6..12 minor/nit, fix (F4, docs):** http-error priority sentence (plan :36 contradicts :33); attachments row
  ("Android has no cap" is wrong: 1000; field is `userAttachments`); the "plain JS cannot forge code_dialog"
  overclaim and the stale `asInternalClient` JSDoc ("type-level cast only"); PROGRESS blackout entry lists relaunch
  carry as open (done) and says Android does not persist the identifier (wrong); plan header still "in progress";
  notify kept-differences omits WebView; `detectHttpErrors` difference (4) is not a difference (Android also uses one
  synthetic frame); document that `relaunch()` after `stop()` is a no-op on Android, that `startInBlackout` /
  `persistUserIdentifier` / `lifecycleEventsListener` are JS-only keys, that `startBlackout` is a no-op before launch;
  `launch-status.ts` cites the wrong Android type; `reportDefaultErrorPriority` does not apply to http errors.
- **R2D-13 minor, fix (F1/F4).** `emitLifecycleEvent` is on the public `BugseeClient`: app code can fake events; move
  to `InternalBugseeClient`.
- **R2D-14 tests, fix (F4).** Add/strengthen tests for the surviving mutants: blackout redelivery cap (m2), uppercase
  hex (m13), `startInBlackout` ordering before providers and event order (m18), `unref()` of the relaunch timer (m21),
  notify queue-bytes boundary (m24), recorder marker order before the snapshot (m29). Fix weak/mislabelled tests:
  `export-parity.test.ts` lacks `addReportAttachment`; `export-parity.test-d.ts` lacks `LifecycleEventsListener`,
  `LifecycleEventType`, `ReportAttachmentInput`; `notify.launch.test.ts:143` title vs body, `:137` does not assert the
  wire; `bugsee/src/node.test.ts` repeat-launch asserts only `typeof`; wall-clock asserts in browser lifecycle tests;
  e2e hard-codes `'bugsee.user_identifier.'` instead of importing the prefix; `startInBlackout` e2e negatives can pass
  vacuously (add the "lit" controls for input/ui breadcrumbs and assert the markers); replace
  `waitForTimeout(600)` in `blackout.e2e.ts` with a condition wait.
- **R2D-15, follow-up (not this round).** Mobile APIs/options with no JS equivalent (list above): recorded in the plan
  doc under "Remaining mobile gaps"; `deleteCollectedDataOnDevice` is the one to decide on next (privacy).
