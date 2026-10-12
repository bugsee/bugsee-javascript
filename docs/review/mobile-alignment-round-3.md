# Review round 3 — JS/mobile API alignment (fixes of round 2, `e2f928c..f930d6b`)

Three fresh read-only Opus reviews (2026-10-12): stop/launch/relaunch safety (**L3**), blackout + privacy + options
(**V3**), payloads/exports/tests (**P3**). Findings are NEW (regressions of the round-2 fixes, misses, interactions
between fix groups). IDs: `R3L-n`, `R3V-n`, `R3P-n`. Rounds 1 and 2: `mobile-alignment-round-1.md`, `-round-2.md`.
Trend: round 1 ~45 findings, round 2 ~45, round 3 ~25 (none are merge damage).

Product decisions taken with this round:
- Every privacy-relevant boolean option has an explicit fail direction, applied through ONE shared normaliser: options
  whose safe side is ON (capture-protecting: `startInBlackout`, `replay` masking/blocking switches' safe side,
  `captureObscuring`, `sanitizeSpans`, network default sanitizer, `instrumentIncomingRequests` stays default-on) go
  fail-ON-protection on invalid values; options that collect MORE data (`captureLocalVariables`,
  `captureSourceContext`, `profiling`, `persistUserIdentifier`) go OFF unless boolean `true`.
- `relaunch()` does NOT keep `instanceIdentity` (a pinned identity must never be shared by two instances).
- Only the client that currently owns the carrier slot may change the process-wide blackout flag or tell native;
  a stale handle's `startBlackout`/`endBlackout` is forwarded to the current client, or reported through `onError`.
- Bundle-size growth of ~4.5-4.9 KB minified on launch-only bundles (shared helper imports) is accepted.

Groups (each fixed test-first by its own agent): **H1** stop/relaunch/carrier/blackout-ownership, **H2**
privacy/options/WebView/Electron/URL templating, **H3** crash frames/exports/relaunch re-exports/docs/tests.

## Findings and dispositions

### R3L — stop/launch/relaunch (H1)
- **R3L-1 major, fix.** `stop()` (drains fully) then `stop(20)`: each bumps `stopGeneration`/`lifecycleEpoch` and only
  the latest may write `.stopped` (node) / release the lock (browser, webworker); the 20 ms call returns false, the
  first call's generation is stale: nothing is ever marked/released (reproduced, node). The generation guard existed
  for `client.launch()` after stop, which `restartable:false` now rules out. Mark/release when the shared real drain
  settles true, from whichever stop observes it; keep the guard only for relaunch-with-new-client cases.
- **R3L-2 minor, fix.** `startDrain(timeout)` passes the first stop's timeout into `uploadPipeline.flush`, so the
  shared `stopDrain` is bounded by the first caller; a repeat `stop()` can never return true after it timed out.
  Run the shared drain unbounded; apply the per-call timeout only in `boundDrain`.
- **R3L-3 major (advanced option), fix.** `instanceIdentity` is now kept on relaunch and the launch override that
  removed `.stopped` is gone: relaunch in the same subtree keeps a stale `.stopped`, a sibling claims and deletes the
  live subtree (reproduced). Do not keep `instanceIdentity`; remove `.stopped` in `writeInstanceOwner` at every launch.
- **R3L-4 minor/major, fix.** Stale handle `endBlackout()` (allowed while stopped by R2L-7) clears the carrier flag
  while the live client is dark; next relaunch starts un-dark; WebView also posts `a:false` to native (reproduced; also
  R3V-1). `startBlackout()` on a stale handle is a silent no-op. Ownership rule above.
- **R3L-5 minor, fix.** notify hand-off: an in-flight batch that fails after `take()` goes back into the OLD (never
  resumed) relay and is lost; a late old-stop `.finally` can park items on `globalThis` `notifyBacklog` (titles +
  user e-mail) until some later launch. Route post-take retries to the carrier backlog; clear the backlog on the
  relaunch failure path; contradicting comment fixed. (also R3P-4)
- **R3L-6 nit, fix.** relaunch-options table test does not cover nextjs, nuxt, remix, sveltekit, astro, cloudflare,
  bun/deno; unclassified today: `onSpanProcessor`, `setupOtelProvider`, `appToken`, `injectTraceMeta`. Add those
  interfaces and classify.
- **R3L-7 nit, fix.** The deferred `BlackoutStarted` of `startInBlackout` (browser launch.ts ~869) must check
  `client.isLaunched()`; a Launching listener that calls `endBlackout()` must still see Started before Ended (emit
  Started even though silent start, or suppress both consistently).
- **R3L-8 nit, document.** `RelaunchedAfterCrash` on node misses the commonest crash (an uncaughtException whose
  report uploaded before exit leaves no marker) and can over-report a script that exits with an upload in flight:
  say so in `lifecycle-events.ts`.

### R3V — blackout, privacy, options (H2 unless noted)
- **R3V-1 major** = R3L-4 (H1).
- **R3V-2 major (fail-open), fix.** `startInBlackout` uses BOOLEAN_OPTION: `'true'`/`1` (e.g. from env) resolve OFF.
  Safe side is ON: invalid value => ON (+ `onError`). The Electron renderer's `=== true` check uses the same rule.
- **R3V-3 major (fail-open), fix.** Options still read raw: node `captureLocalVariables`/`captureSourceContext`
  (`null`, `0`, `''`, `'false'` turn them ON), browser `replay` (`0`/`'false'` still record; `replay: null` throws a
  TypeError in launch()), WebView `captureObscuring ?? true` (`0`/`''` turn obscuring OFF), node
  `instrumentIncomingRequests !== false` (`'false'` leaves it ON), performance `sanitizeSpans ?? true` (`0`/`''`
  disables the sanitizer), node `profiling`/`detectHangs` (verify). Run all of them through the shared normaliser with
  the direction chosen above; table test over every option of every platform interface (reuse the relaunch-options
  interface reader).
- **R3V-4 minor, fix.** URL templating leaks: 22-23 char base64url tokens, card numbers with separators
  (`4111-1111-1111-1111`, `4111%201111...`), `user@localhost`. Mixed-case/digit-bearing tokens 16-23 chars =>
  `{token}`; 13-19 digits with separators => `{card}`; keep linear time (1e6 probes).
- **R3V-5 minor, fix.** WebView blackout contract: (a) a carried blackout is never told to native after `hello`
  (post the current state), (b) the bridge spec must say `a:false` never ends native's own blackout and native is dark
  while either flag is set, (c) the "native has not declared support" warning can fire before the control reply:
  evaluate lazily after the reply.
- **R3V-6 minor, fix.** `launchRenderer()` called twice in one page (HMR) registers two competing three-flag handlers:
  a second call must be a no-op returning the existing instance; a re-run after main's stop must honour the carried
  blackout and R2L-7.
- **R3V-7 minor, fix.** WebView inert client lacks `startBlackout/endBlackout/isBlackout/getStatus/
  setLifecycleEventsListener` (TypeError): add safe forwards/no-ops reporting through `onError`.
- **R3V-8 nit, fix.** `recorder.ts #canvasForThisStart` calls the raw `onError`; a throw there leaves replay off
  until the next cycle: wrap.
- **R3V-9 nit, fix (docs).** `docs/design/blackout.md` "State rules" contradicts itself (start/end ignored while not
  launched vs end allowed while stopped); `mobile-api-alignment.md` says endBlackout-before-launch is a no-op "as on
  Android": it is a kept difference (Android no-ops; JS clears the carried flag); list it.

### R3P — frames, exports, tests (H3)
- **R3P-1 major, fix.** Safari/JavaScriptCore: (a) the public wrapper's `return internal.logException(...)` is a
  proper tail call, JSC drops the wrapper frame, `slice(sdkFrames=2)` removes the APP frame (fallback path
  regression); (b) `Error.captureStackTrace(errorThatAlreadyHasAStack, fn)` does not re-capture on JSC, so frame 0 is
  still the SDK frame (R2P-1 not fixed there). Capture into a plain holder object and make the wrapper call non-tail
  (`const r = internal.logException(...); return r;`); add a jsc-based test where available (macOS `jsc` shell,
  skip with a clear reason elsewhere is NOT allowed: use a recorded JSC stack fixture parsed by the real parser).
  Also: webview and webworker do not pass `stackParser` to `createClient` (V8-only core parser): every crash.json from
  Safari/Firefox workers and iOS WebView has `frames: []`: pass the browser parser.
- **R3P-2 major, fix.** `@bugsee/nextjs/server` `relaunch`: the first launch registers Bugsee's TracerProvider with
  the OLD span processor; relaunch cannot re-register (first-wins), Next spans keep flowing to the stopped client; docs
  claim relaunch re-applies OTel. Make the processor late-bound to the current carrier client (or delegate swapped on
  relaunch) + relaunch test asserting spans reach the NEW client; correct the docs.
- **R3P-3 major, fix.** `@bugsee/nuxt/server` and `/edge` export `relaunch` but `installBugseeNitro`/`...Edge` close
  over the old client (errors, trace meta, flush go to the stopped client). Resolve `getCarrierClient()` per hook;
  relaunch-then-error test.
- **R3P-4 minor** = R3L-5 (H1).
- **R3P-5 minor (test), fix.** `client.test.ts:646-655` injects `{ boundary }` but the option is `callSite`; mutant
  "caller options override callSite" survives. Fix the test key (+ assert the wrapper wins).
- **R3P-6 nit, fix (docs).** See R3V-9 (H2 owns the blackout docs); `mobile-api-alignment.md:197`.
- **R3P-7 nit, fix.** The R2P-7 marker rewrite after `after` runs on every report once an `after` handler exists: only
  when the report changed.
- **R3P-8 nit, fix.** `limitAttachmentsForMarker` unguarded inside the normalise catch: hostile report (throwing
  getter/Proxy) loses the report: wrap in try.
- **R3P-9 nit, fix.** Framework `/edge` entries (sveltekit, astro, nuxt) re-export the vercel-edge `relaunch`, which
  re-runs plain `launchEdge` and ignores a custom `launch` seam such as Cloudflare: accept the seam as an argument or
  document and cap with a test.
