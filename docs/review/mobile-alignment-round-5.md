# Review round 5 — JS/mobile API alignment (fixes of round 4, `a98dabb..08bc589`)

Three fresh read-only Opus reviews (2026-10-13): lifecycle/WebView/stop (**L5**), privacy options/templating/Electron
(**V5**), signature/edge seams/CI health (**H5**). NEW findings only. IDs `R5L-n`, `R5V-n`, `R5H-n`.
Earlier rounds: `mobile-alignment-round-{1,2,3,4}.md`. Trend: ~45, ~45, ~25, ~29, ~19 (round 5: 1 major, no merge
damage; every area also lists what it verified fine, including 3x repeated suite runs and CPU-loaded runs).

Decisions taken with this round:
- The URL sanitizer is a heuristic privacy filter, not a perfect classifier. Policy: when a segment cannot be
  shown to be a human word it is templated (privacy over grouping); the corpus measurements below are the acceptance
  numbers. Residual: a few % of short (16-23 char) random tokens may stay (documented).
- Page script in a WebView is untrusted: it gets an ALLOW-LISTED facade (no spread of the real client), and the
  lifecycle listener slot is not page-writable.
- Test budgets: every test that builds TypeScript programs / reads many files / is deliberately quadratic uses ONE
  shared timeout constant, and no assertion compares a wall-clock duration.

Groups: **K1** privacy options + sanitizer + traceparent allow-list, **K2** WebView facade / node registry /
signature / edge leak / test assertions, **K3** CI timing budgets.

## Findings and dispositions

### R5V — privacy options, templating, Electron (K1)
- **R5V-1 major (regression of R4V-5), fix.** `looksLikeWords` counts any run of 3+ lowercase letters as a word and
  now also gates the 24+ and 20-21 char rules: lowercase random tokens (cuid2, base32 lowercase, nanoid lowercase,
  ULID lowercase, base36) are kept verbatim in summaries/grouping labels. Measured keep rates now vs round 4:
  cuid2-24 12.1% (0.06%), cuid2-32 8.1% (0%), base32-26 30.0% (0.5%), base32-52 14% (0%), nanoid-lc-21 15.8% (1.55%),
  ULID-lc-26 5.1% (0.01%); corpus: base36 lowercase 16-19 chars 16.2% (4.1%), 20-21 15.5% (1.5%), 24-31 9.3% (0.015%).
  Fix: a single-case lowercase string is NEVER word-like unless it is a recognised slug (dictionary-free rule: >=2
  Title-case pieces, or an explicit separator-delimited slug whose pieces are each <=12 letters and pronounceable by a
  cheap vowel/consonant-run test); drop the word check for 24+ chars. Acceptance: on the 200k seeded corpus keep rate
  <= round-4 numbers for every alphabet/length bucket (add lowercase base36/base32/cuid2/ULID/nanoid corpora to the
  test with the thresholds), false templating of the 3000-route corpus must stay <= 15%.
- **R5V-2 minor (regression of R4V-6), fix.** Last-`@` e-mail rule: `alice@example.com@`, `alice@example.com@latest`,
  `jane.doe@corp.com@next`, `alice@example.com@x`, `alice@example.com@%20` now leak (old first-`@` rule templated them):
  template when ANY `@` position yields an address (single linear scan).
- **R5V-3 minor, fix.** `x@<dotted>` is always an e-mail: `react@18.2.0`, `logo@2x.png` become `{email}`. A host that
  is only digits and dots (semver) or `\d+x.<ext>` is not an address.
- **R5V-4 minor, fix.** Round-4 warnings call the app's `onError` unguarded and make `launch()` throw with a rethrowing
  sink: `node/src/local-variables.ts:305` (includeCaught/reportSite), `vercel-edge/src/launch.ts:300`
  (partitionCaptureByTenant; also cloudflare), `browser/src/launch.ts:~865` (canvas). Route through a guarded report
  helper like `reportInvalid`.
- **R5V-5 nit, fix.** `vercel-edge/src/launch.ts:302` warning text uses `JSON.stringify(value)`: BigInt throws out of
  launch, Symbol/function print "undefined". Use a safe describe helper (typeof/String in try).
- **R5V-6 minor, fix.** `capture/src/traceparent.ts:141`: `tracePropagationTargets: ['']` matches every URL (trace +
  session ids to every third party; e.g. `process.env.TARGETS.split(',')` with an empty env). Drop empty strings, reject
  non-array / non-string-non-RegExp entries with `onError`, neutralise `/g` and `/y` regex state (lastIndex reset).
- **R5V-7 nit, fix.** `bugsee/src/wire.ts:209`: `otelExportUrl` as a `URL` object worked before and is now silently
  ignored; whitespace-only `'   '` still builds an exporter (fetch('   ') = the page's own URL). Accept `URL`
  (stringify), trim strings, report non-empty invalid values.
- **R5V-8 minor, fix.** The option-direction table's INTERFACES omit adapter option interfaces: nextjs
  `setupOtelProvider` (`=== false`: `'false'|0|null` keep the zero-config provider ON) and nuxt `injectTraceMeta`
  (truthy: `'false'`/`1` keep injection ON, `null`/`0` OFF). Add `NextjsServerOptions` and the nuxt option interfaces to
  the table; classify both fail OFF + `onError` and normalise.
- **R5V-9 nit, fix (docs).** JSDoc of `partitionCaptureByTenant` (vercel-edge:108 "Default false": Cloudflare defaults
  true, invalid fails ON, explicit false silently disables isolation: document and warn once), `replay`
  (browser launch.ts:340), `instrumentIncomingRequests` (node launch.ts:409), `reportSite` (local-variables.ts:78)
  must state the invalid => OFF rule.
- **R5V-10 nit, fix.** The detector-url-sanitizer test's `Date.now() - started < 30_000` wall-clock assertion
  (measured 11.7 s on CI): drop it, keep the timeout as the hang guard. (Pre-round-4 misses noted, not fixed here:
  IPv4:port, `::ffff:1.2.3.4`, `fe80::1%25eth0`, `[::1]`, `tel:+1415...`, double-encoded `%2540`, hashed bundle names
  collapsing, `es-419` => `es-{id}`: take the cheap ones - ip:port, `[::1]`, `tel:`, `%2540`, hashed bundle names keep
  the extension - with tests.)

### R5L — lifecycle, WebView, registry (K2)
- **R5L-1 minor, fix.** WebView restricted facade bypass (reproduced): in a WebView the carrier is `globalThis`; page
  script can set `__BUGSEE__[...].lifecycleListener` and receive the owner's events; `restrictedClientFor` returns
  `{ ...client, ...blocked }`, so the enumerable `Symbol.for('com.bugsee.internal-client')` property leaks:
  `emitLifecycleEvent` (fake events) and unstripped `upload`/`prepareUpload` (forge `trigger`). Build the restricted
  client from an explicit allow-list (no spread); keep the lifecycle slot unreachable from page script in a WebView (a
  module-private host or non-writable accessor); tests that page script cannot install a listener nor reach the
  internal methods.
- **R5L-2 nit, fix.** Node live-root count leaks when a launch fails after `writeInstanceOwner` registered
  (`instance-layout.ts:122`, `launch.ts:603`): a later same-pinned-root launch never writes `.stopped`. Register at the
  end of `buildLaunch` or release in a catch; keep the count on the carrier so ESM/CJS copies agree.
- **R5L-3 nit, fix.** R4L-2 test "a queued item stashed by the late old stop after the attempt failed is dropped too"
  passes without the fix (stop bound fires before the relaunch bound): make the stash happen AFTER the failure and
  assert the `onError`; confirm with the mutation `client.ts:~940 if (false && ...)`.
- **R5L-4 nit, fix.** The R4L-5 test edit (`client-blackout-ownership.test.ts:171-173`) lost its check (`b.isBlackout()`
  now reads the carrier): assert b's own state via its BlackoutService or after b re-claims ownership; confirm with the
  mutation `blackout.start()` in the stale branch of `startBlackout` (`client.ts:~1721`).

### R5H — signature, edge seams, CI health (K2 for 1-4, K3 for 5-6)
- **R5H-1 minor, fix (K2).** `crashFingerprint` ignores the `cause` chain, `exception.name` and `domain` (reproduced):
  scrubbing `crash.exception.cause.frames[*].variables` or `cause.reason` leaves the marker unrewritten. Fingerprint
  `JSON.stringify(crash)` whole (measured 0.05 ms for 10 frames, 1.1 ms for a 1 MB crash); add cause-chain, name and
  domain rows to the `it.each` table; fix the wrong code comment.
- **R5H-2 minor (PII), fix (K2).** An attachment redacted to the SAME length (mask with `*`, `fill(0)`) is not detected
  (length-only signature; reproduced). Compare string data by value (cheap when lengths differ), bytes by a cheap hash
  (e.g. FNV-1a over the bytes, O(n)); also detect removal of SDK `report.attachments` (a `.dmp`).
- **R5H-3 nit, fix (K2).** When `markerRequest` ends up `undefined` (R4H-6) `markerDurable` stays true and the
  'incident unrecoverable' warning is skipped: set `markerDurable = false` wherever no marker is persisted.
- **R5H-4 minor, fix (K2).** `relaunchEdge`/`rememberEdgeLaunch` leaked into `@bugsee/bugsee` (edge-light) and
  `@bugsee/cloudflare` through `export *` from vercel-edge (a plain `relaunchEdge()` there silently re-runs
  `launchEdge`, dropping umbrella extensions / the Cloudflare launch). Move both to a non-index module imported by
  sveltekit/astro/nuxt (or explicit export lists); add them to the export-parity guard as FORBIDDEN names on those
  entries.
- **R5H-5 minor (CI), fix (K3).** Memoising per target file did not help: `option-directions` still builds ~10 distinct
  programs (68 s on the runner with a 180 s budget; the same before and after). Share one `CompilerHost` with a
  `getSourceFile` cache across programs (measured 1.91 s -> 0.57 s for 10 programs) in BOTH
  `option-directions.test.ts` and `relaunch-options.test.ts`; keep the timeout constant shared.
- **R5H-6 minor (CI), fix (K3).** `protocol/src/sanitize.test.ts` linear-time XML test measured 60 s on CI against a
  120 s limit: raise `LINEARITY_TEST_TIMEOUT_MS` to 180_000 and use that ONE constant in `linear-time.test.ts` (it
  hard-codes 180_000 today). K1 owns the `detector-url-sanitizer.test.ts` wall-clock assertion (R5V-10).

## K1 fix record (R5V-1 .. R5V-10)

Fixed test-first with the mutator loop; measured on the seeded corpora in `packages/capture/src/detector-url-corpus.test-d.ts`
(the unit test uses 20,000 tokens a bucket, the scratch figures below 200,000).

- **R5V-1.** A segment is word-like only as (a) a separator-delimited slug whose pieces are words of <= 12 pronounceable
  letters / numbers / short codes (words >= numbers), or (b) a camel/Pascal name: >= 2 Title words, each pronounceable
  (consonant runs counted in sounds with a list of known clusters, vowel runs, vowel ratio, `q` needs `u`), at most one
  fragment, two acronyms (only known ones count), 80% of the name covered by words, 60% by words of 4+ letters. A
  single-case string with no separator is never word-like; the old coverage heuristic is gone at every length. 3+ word
  slugs now also need pronounceable words and only version-shaped words may have a number between letters.
  Keep rate on 200,000 tokens a bucket (a98dabb = no word check at all, in parentheses where the new figure is higher):

  | alphabet | 16-19 | 20-21 | 22-23 | 24-31 | 32-47 | 48-64 |
  |---|---|---|---|---|---|---|
  | base64url | 5.191 | 3.070 | 2.213 | 1.046 | 0.164 | 0.008 |
  | base62 | 4.737 (4.724) | 2.692 (2.683) | 1.937 (1.935) | 0.844 | 0.137 | 0.004 |
  | hex | 0 | 0 | 0 | 0 | 0 | 0 |
  | base36 lower | 4.056 | 1.720 | 0.990 | 0.021 | 0.001 | 0 |
  | base36 upper | 4.056 | 1.720 | 0.990 | 0.021 | 0.001 | 0 |
  | base32 lower | 16.514 | 9.973 | 7.041 | 0.369 | 0.043 | 0.001 |
  | cuid2 | 5.334 | 2.266 | 1.298 | 0.028 | 0.001 | 0 |
  | ULID lower | 2.246 | 0.801 | 0.425 | 0.005 | 0 | 0 |
  | nanoid lower | 5.282 | 2.401 | 1.425 | 0.040 | 0.001 | 0 |

  Every bucket is at or below a98dabb except three base62 buckets, 0.001-0.013 points above (24, 4 and 2 tokens in
  200,000: random mixed-case pieces that happen to read as two words). False templating of the 3,000-segment route
  corpus: 0.00% (a98dabb: 16.67%, round 4 before this fix: 0.00% because it kept lower-case random tokens). The corpus
  clusters were tuned against it, so a second, differently worded 3,000-segment set (scratch) was used: it first showed
  10.3% and 2.8% before the missing consonant clusters it exposed were added, then 0.0%; treat the true rate on unseen
  vocabulary as a few percent, not zero (a missing cluster templates a real word: privacy over grouping).
- **R5V-2/3.** One linear scan over every `@`; a host of only digits and dots or `\d+x[.ext]` is not an address.
- **R5V-4/5.** `reportGuarded` / `describeValue` in `@bugsee/util` (re-exported by core): node local-variables, vercel-edge,
  browser canvas, cloudflare. A rethrowing sink cannot break launch; BigInt / Symbol / function values are described.
- **R5V-6.** Empty entries dropped, non-array and non string/RegExp entries reported, `/g` `/y` flags removed on a copy.
- **R5V-7.** `otelExportUrl` accepts a `URL`, trims, blank = no exporter, other types reported.
- **R5V-8.** `NextjsServerOptions` and the Nuxt interfaces are in the direction table; `setupOtelProvider` and
  `injectTraceMeta` fail OFF + `onError` via `resolveFailClosedBoolean` (core).
- **R5V-9.** JSDoc for the four options; Cloudflare warns once per isolate about an explicit `partitionCaptureByTenant: false`.
- **R5V-10.** Wall-clock assertion removed; `ip:port`, `[::1]`, `tel:`, `%2540`, hashed asset names (`bundle.{token}.jpg`).
