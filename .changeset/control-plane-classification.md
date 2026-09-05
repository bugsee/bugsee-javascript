---
'@bugsee/core': minor
'@bugsee/browser-utils': minor
---

The control plane now reads the collector's own error code out of a FAILED response, and the browser /
worker dead-sibling queue gets an age bound.

Two halves of one asymmetry. The DATA plane classified server answers; the CONTROL plane did not, so a
`400` from `/v2/issues` was retried at every launch — bounded on node by the 7-day retention, and on
browser/worker not bounded at all.

**What is now classified.** `bugsee-api.ts` threw on a non-2xx status *before* parsing the body, so a
verdict the SDK honours perfectly on an HTTP 200 was discarded the moment the collector attached a status
to it: `14019 InvalidAppToken` delivered with a 400 was retried forever, and `99099 KillSdk` with a status
could not switch the SDK off at all. The failed body is now read for `{ ok: false, error: { code } }` and
the code goes on `BugseeError.serverCode`, where the existing (Android-drift-tested) `classifyServerErrorCode`
sees it. This adds no codes to the permanent set — it applies the set that was already there to a response
shape that was being thrown away. Android does the same on both endpoints.

**What is deliberately NOT classified.** A NAKED non-2xx — a status with no collector code behind it —
stays retryable. Android's own two endpoints disagree about the identical status, which is the tell that a
status is not a verdict about the payload; and on the web a bare 4xx is what an intermediary answers (a
captive portal, a MITM proxy, a WAF, a stale CDN route), none of which read the bytes. Pinned by tests, so
the decision is falsifiable rather than an omission.

**What bounds the rest.** `recoverSiblingBundleQueue` now applies `DEFAULT_DURABLE_RETENTION.maxAgeMs`
(7 days) — the same bound the same bytes already meet on the same tier when an instance recovers its own
queue, and the same TTL node's dead-subtree sweep uses. Only the age cap is mirrored, not the count/byte
caps: those evict the oldest *survivors*, which here would delete a report the collector was never asked
about. A frame with no staging timestamp (staged by an older SDK) is NEVER expired — reading unknown as the
epoch would delete every pending report on the launch after an upgrade.

`@bugsee/core` additionally exports `deserializeBundleFrame` and `DEFAULT_DURABLE_RETENTION`, so the bound
is read from one place rather than restated.
