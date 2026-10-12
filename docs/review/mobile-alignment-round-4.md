# Review round 4 — JS/mobile API alignment (fixes of round 3, `f930d6b..a98dabb`)

Three fresh read-only Opus reviews (2026-10-13): stop/relaunch/blackout ownership (**L4**), privacy options +
templating (**V4**), frames/relaunch hooks/test quality (**H4**). NEW findings only. IDs `R4L-n`, `R4V-n`, `R4H-n`.
Previous rounds: `mobile-alignment-round-{1,2,3}.md`. Trend: round 1 ~45, round 2 ~45, round 3 ~25, round 4 ~29
(majors: 1 + 2 + 0; no merge damage; H3's call-site/JSC work verified on real engines).

Product decisions taken with this round:
- Capture that is ON by default and collects data (`replay`, `instrumentIncomingRequests`) goes OFF on an invalid
  scalar (`0`, `null`, `''`, `'false'`, anything non-boolean/non-object) with an `onError`; replay masking stays
  fail-closed regardless.
- A WebView page must not gain control over redaction: the restricted facade of a repeat `BugseeWebView.launch()`
  blocks `endBlackout` and `setLifecycleEventsListener` (`startBlackout` stays: it only fails closed).
- Options that PROTECT (tenant partitioning, canvas blocking, obscuring, sanitizers) fail ON; the table test must
  classify each option's SAFE side explicitly, not assume "OFF unless true".

Groups: **J1** lifecycle/notify/WebView/test determinism, **J2** privacy options/templating/Electron, **J3**
signature/relaunch seams/docs.

## Findings and dispositions

### R4L — stop/relaunch/blackout ownership (J1)
- **R4L-1 major (regression of R3L-1/3), fix.** Node `markStopped` returns early when ANY newer client holds the
  carrier slot (`node/src/launch.ts:1181-1184`): after a plain relaunch (fresh subtree) the old subtree never gets
  `.stopped` and is stranded (up to `maxDataSize`) until process exit (reproduced). Skip only when another LIVE client
  uses the SAME subtree root (process-level set of live `instanceLayout.root`, added in `writeInstanceOwner`, removed on
  stop). Test the unpinned relaunch; keep the pinned-identity test.
- **R4L-2 minor, fix.** A notify batch in flight at `take()` that fails after a FAILED relaunch is re-parked on
  `globalThis.notifyBacklog` (title + user e-mail) with nobody to adopt (reproduced). Tie hand-backs to a relaunch
  attempt epoch; a stale epoch drops the items (`onError`) instead of parking.
- **R4L-3 minor, fix.** WebView: `A.stop()` (torn) then `A.endBlackout()` is suppressed toward native, then `launch()`
  builds B with a false carried flag and posts nothing: native can stay paused for the new session. After `hello`
  always post the current state (`a:false` too) and state in the spec that native resets the JS flag on `bye`/`hello`.
- **R4L-4 nit, fix.** Browser/webworker lock-release observer reuses the memoized `makeDurable` promise, so writes made
  during the drain (deferred chunk deletes) are not flushed before release: flush again in the observer; wrap the async
  success callback so a throwing `onError`/`release()` cannot become an unhandled rejection (also R4H-7).
- **R4L-5 nit, fix.** A stale handle's `isBlackout()` returns its own state; read the carrier flag.
- **R4L-6 nit/decision, fix.** `restrictedClientFor` (WebView repeat launch) must block `endBlackout` and
  `setLifecycleEventsListener` (see decision above; also R4V-7).

### R4V — privacy options, templating, Electron (J2)
- **R4V-1 major (regression), fix.** Cloudflare: `{ partitionCaptureByTenant: undefined | 'true' | 1 | null }` overrides
  the platform default `true` (`cloudflare/src/launch.ts:32-33` spread) and vercel-edge reads `=== true`: tenant
  partitioning goes OFF without notice (cross-tenant capture upload). Resolve with a fail-ON normaliser, apply the
  default only for `undefined` BEFORE the spread, report invalid values; reclassify in `option-directions.test.ts`
  (RAW_STRICT assumed "OFF unless true"); add Cloudflare to the table's interface list.
- **R4V-2 major, fix.** `replay.canvas` raw read (`browser/launch.ts:853`): `0`/`null`/`''`/`'false'` load
  `@bugsee/replay-canvas` and record canvas pixels (unmasked); `blockAllCanvas: 'true'` (masking.ts ~524) leaves canvas
  unblocked. canvas: enable only for `true` or a plain object (others OFF + `onError`); `blockAllCanvas` fail ON;
  extend the table test to nested option bags (replay.*, performance.*, nativeCrash...). Also `replay: 'false'|0|''`
  => OFF + `onError` (decision), `replay: null` stays non-throwing; `instrumentIncomingRequests` invalid => OFF.
- **R4V-3 minor, fix.** Electron: after a renderer re-run the OLD handler stays subscribed (no unsubscribe): double
  `onSessionId`, `BlackoutStarted` twice (reproduced); stale `A.startBlackout()` leaves live B un-dark. Make the old
  handler inert once its client is stopped; the renderer's blackout overrides fall back to the core methods (non-owner
  start forwards, non-owner end reports); fix the blackout.md sentence ("same rule as the kernel").
- **R4V-4 minor, fix.** Node `propagateTrace: 'false'` keeps propagation ON while the umbrella logs "using false"
  (reproduced). Give node its own definition (default true, fail OFF) and resolve the performance `propagateTrace`
  only when `platform.pageload` is true.
- **R4V-5 minor (regression of R3V-4), fix.** The 16-23 char `{token}` rule merges ordinary route names
  (`getUserDetailsV2`, `exportCsvReportV3`, `HTML5VideoPlayer2`, `Chapter12Section3`, `iso-8859-1-encoding`,
  `report_2024_q3_final`...): require randomness (e.g. alphabetic runs of >=4 letters mean a word, not a token; count
  case transitions / entropy), add the listed names as negative tests; keep real tokens templated.
- **R4V-6 minor (regression of R3V-4), fix.** The dot-less e-mail host rule turns `react@latest`, `pkg@next` into
  `{email}` (collapses CDN fetches); `@alice@example.com` / `%40alice%40example.com` still leak (first-`@` check).
  Use the last `@` and exclude known dist-tags (latest, next, beta, alpha, canary, rc, nightly, stable, experimental).
- **R4V-7 minor** = R4L-6 (J1).
- **R4V-8 minor, fix.** Electron pixel-video `guarded` calls the raw host `onError`; a throwing sink skips
  `source.clear()` and leaves pre-blackout frames in the buffer: wrap the sink, clear in `finally`.
- **R4V-9 nit, fix.** WebView "native has not declared support" judgement can stay pending forever (legacy receiver,
  no reply, one blackout change): add a bounded deadline or judge at the next upload/`stop` (J1 owns WebView).
- **R4V-10 nit, fix.** Inert WebView client `isBlackout()` should read the carrier flag, `getStatus()` Launched after
  the owner stops lies (J1); bridge conformance e2e never sends/validates `k:'blackout'` (J1: add); webview
  launch.ts:646 mentions a non-existent `startInBlackout` (J1); browser `launch.ts:875` `.catch((e) =>
  options.onError?.(e))` => unhandled rejection if the sink throws (J2); `otelExportUrl: ''` builds an exporter posting
  to the page's own URL: empty string = disabled (J2).

### R4H — signature, relaunch seams, docs, tests (J3 unless noted)
- **R4H-1 minor, fix.** `reportChangeSignature` misses `signatures` and `crash`: an `after` handler that scrubs crash
  frames/locals or changes signatures leaves the marker unrewritten and a recovered report carries the unscrubbed
  crash. Add `signatures` and a cheap crash fingerprint (frame count + `JSON.stringify` of frames).
- **R4H-2 minor, fix.** Six signature fields are untested (severity, email, type, attachment name/mimeType/fileName
  mutants survive): extend the `it.each` table.
- **R4H-3 minor, fix.** nextjs delegate `forceFlush`/`shutdown` late-binding untested: after a relaunch assert both hit
  the NEW processor.
- **R4H-4 minor, fix.** Edge `relaunch()` (sveltekit/astro/nuxt) without `launch` silently swaps to `launchEdge` while
  the JSDoc says "the SAME seam": remember the install-time seam on the carrier as the default.
- **R4H-5 nit, fix (docs).** `mobile-api-alignment.md:194-195` and `PROGRESS.md:88` still say the `/edge` entries
  re-export the plain vercel-edge `relaunch`.
- **R4H-6 nit, fix.** If `limitAttachmentsForMarker` throws, `markerRequest` stays the unlimited request: fail closed
  (`userAttachments: []`) in that catch.
- **R4H-7 nit** = R4L-4 (J1).
- **R4H-8 nit, fix (J1).** Four new tests assert "did not happen" after a fixed sleep (node/browser
  `launch-stop-shared-drain.test.ts`, core `client-stop-shared-drain.test.ts`): wait for the drain event / fake timers.
- **R4H-9 nit, fix.** The nextjs delegate keeps the stopped client reachable after `stop()` with no relaunch and when
  no provider was ever registered: drop `target` on stop; do not create the delegate when OTel is off.
- **R4H-koa, fix (J1).** The koa/nest integration tests ignore `flush()`'s result and `listen(0)` on `::` while the
  client dials `127.0.0.1`: assert `expect(await client.flush(5000)).toBe(true)` and listen on `127.0.0.1` (the
  occasional failure in loaded runs, nestjs "other side closed", is not caused by the alignment changes).
