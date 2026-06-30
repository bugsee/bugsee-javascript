# Browser/worker multi-instance IndexedDB coexistence + recovery — design

**Status:** Slices 1–5 BUILT + reviewed-to-convergence + on master (2026-06-30) — the durable BUNDLE queue
**and** the capture-chunk + report-marker stores are now fully multi-instance-safe on browser (webworker is
bundle-only — it has no capture-recovery path yet, #165). The SEV1 capture/marker hazard the slice-4 review
flagged is **CLOSED** (slice 5; see §1). The browser/worker-tier counterpart of the BUILT node
`multi-instance-disk-coexistence.md` (which it mirrors decision-for-decision). Surfaced by a review of
`@bugsee/webworker`: a page (`@bugsee/browser`) and its same-origin workers (`@bugsee/webworker`) — and even
N tabs of one URL — share the origin's IndexedDB and currently open the **same** default database `'bugsee'`,
so their durable bundle queues cross-recover, race, and (with different app tokens) can upload to the wrong
project. Android-canonical (same reference as the node milestone).

## 1. Problem & goal

IndexedDB is **origin-scoped**: a page, its dedicated/shared workers, its service worker, and every tab of the
same URL all share one IndexedDB. The persistent stores key everything by fixed DB names
(`createIdbBlobStore()` → db `'bugsee'`; capture `'bugsee-capture'`; markers `'bugsee-markers'`) with **no
per-instance identity** — the exact browser analog of the node "everything keyed by `dataDir`+`generation`, no
per-instance identity" defect.

Three live tabs (or page + service worker) on one origin therefore:
- **cross-recover** — each instance's `recover()` lists EVERY bundle in the shared store and re-uploads them,
  including other *live* instances' pending bundles (and removes them out from under the owner);
- **race** — independent in-memory mirrors over one store → double/triple uploads + stale mirrors;
- **wrong-project** — different app tokens sharing db `'bugsee'` → one instance uploads another's bundle under
  the wrong token.

**Goal** (identical to the node milestone, retargeted to IDB): each instance's queue/capture data must
(a) **coexist in IndexedDB without cross-contamination**, and (b) on an incident be delivered **exactly once**,
including incidents from an instance that **died** (tab close / crash / SW termination), recovered
opportunistically by any surviving or later instance.

**Non-goal (this milestone):** in-memory session sharing (a worker forwarding reports to the page client for
ONE session) — a separate follow-up. Here each instance is its own session; only its *IDB data* coexists.

> **✅ SEV1 capture/marker hazard — CLOSED by slice 5 (2026-06-30).** Before slice 5 the browser's `persist:true`
> capture-recovery (`recoverReports` over the **shared** `bugsee-capture`/`bugsee-markers` DBs) let a freshly-
> launched tab (a) reassemble + re-deliver **another live tab's** detected incident (deleting its marker) and
> worse (b) **sweep/delete another live tab's preserved capture generation** — silent capture-data loss. Slice 5
> folds the capture-chunk + marker stores onto the per-instance model (BD8–BD10): per-token DBs, per-instance
> `"<instanceId>/"` prefix, and the SAME per-instance Web Lock gates ALL recovery. A LIVE sibling holds its lock,
> so a launching tab's `recoverDeadSiblings` skips it entirely — it never reads, recovers, or sweeps a live tab's
> markers/capture. Verified (3-agent review, both fresh-round agents CONVERGED): the live-store's own
> `cleanOtherGenerations` pass is confined to self's prefixed view, and the dead-sibling sweep runs only inside
> `recoverIfDead` over the dead sibling's prefixed view. `recoverReports` (core) is unchanged — node unaffected.

## 2. The node mapping (this is a retarget, not a new design)

| node (BUILT) | browser/worker (this doc) |
|---|---|
| per-instance subtree `<dataDir>/<pid>-<threadId>-<nonce>/` | per-instance **key prefix** `"<instanceId>/…"` in a shared, token-namespaced IDB |
| `owner.json` (registry) | **none needed** — the bundle keys themselves carry the instanceId; distinct instances are derived from key prefixes (BD7) |
| `.live` heartbeat (mtime, staleness threshold) | **Web Locks** (`navigator.locks`) — a held lock auto-releases the instant the realm dies. No staleness window, no PID-reuse problem → STRICTLY better than the node heartbeat |
| liveness = `kill(pid,0)` + heartbeat-stale | liveness = the sibling's Web Lock is **acquirable** (`request(..., {ifAvailable:true})` grants it) |
| atomic-rename claim (DEFERRED on node) | **the Web Lock IS the claim** — recover a dead sibling *inside* its held lock; a concurrent coordinator sees the lock held and skips. Liveness + claim + serialization in ONE primitive |
| `recoverInstances` coordinator (scan → dead → claim → existing recovery → rm) | same coordinator, retargeted: scan key prefixes → dead → recover-under-lock → delete the prefix's keys |
| signature-dedup makes concurrent recovery safe | unchanged — the backstop is identical |

## 3. Decision log

| # | Decision | Rationale |
|---|---|---|
| **BD1** | **Per-instance key prefix in a shared, token-namespaced DB.** db = `bugsee-<tokenHash>` (a fast SYNC hash of the app token — the name is needed synchronously at `open()`; not a crypto secret). Bundle keys = `"<instanceId>/<bundleId>"`, `instanceId` = short random hex per launch. | The IDB analog of the node subtree. Token-namespacing is the wrong-project guard (different apps → different DBs). The random per-launch instanceId separates tabs/workers AND a reload (a new launch = a fresh instanceId; the prior session is just a dead sibling). |
| **BD2** | **Liveness = Web Locks.** Each instance holds an exclusive lock `"bugsee/<tokenHash>/<instanceId>"` for its lifetime (`request(name, {mode:'exclusive'}, () => new Promise<never>(()=>{}))` — held until the realm dies, auto-released on close/crash/terminate). A sibling is DEAD iff `request(name, {ifAvailable:true})` is GRANTED (its callback receives a non-null lock). | Web Locks is the browser-native, fully-portable "is this realm alive" primitive — available in window AND all worker types. The auto-release is **precise** (no staleness threshold, no PID-reuse ambiguity — the two caveats §7 of the node doc lists). |
| **BD3** | **The Web Lock IS the claim + the serializer.** Recover a dead sibling INSIDE its held lock: `request(name, {ifAvailable:true}, async lock => { if (lock) await recover() })`. A second coordinator probing the same dead sibling during recovery gets `null` (the recoverer holds it) → skips. | Subsumes the node atomic-rename claim (which was deferred there). One primitive gives liveness + claim + serialization. Server-side `request.signatures` dedup remains the backstop (a recovery that crashes mid-flight just leaves the bundle for the next launch). |
| **BD4** | **Opportunistic cross-instance recovery on launch, reusing the existing pipeline** — identical to node's `recoverInstances`. After `client.launch()`: scan the shared store's keys → distinct instanceIds → for each ≠ self that is DEAD → recover its bundles (feed them to the durable upload pipeline) + delete its keys, under its lock. Never touch a live sibling or self. | This is Android's "any live instance recovers any dead one". An instance's own prior crashed session is just a dead sibling (different instanceId) → recovered by the same path. Replaces the per-instance `durable.recover()` (own queue) — a fresh instance's own queue is empty at launch. **As-built note:** the launches keep BOTH `durable.recover()` (own, freshly-empty prefix → a harmless no-op for the persist path; still does real work for an injected `bundleStore` override, which bypasses coexistence) AND `recoverDeadSiblings` (other instances). Cross-instance recovery uses the **base** pipeline (direct upload, no re-persist into our own prefix), not the durable one. So "replaces" is true in spirit (the prior session is recovered as a dead sibling, not via own-recover) but the own-recover call is retained, harmlessly, for the override path. |
| **BD5** | **Discovery is key-prefix-derived; no registry store.** Distinct instanceIds come from `loadAll()` key prefixes. An instance with no pending bundles is invisible (nothing to recover). | Simpler than a registry + its own GC; the durable data already names its owner. (Node needed `owner.json` only to carry the pid for `kill(pid,0)`; Web Locks needs no such record.) |
| **BD6** | **Degrade where `navigator.locks` is absent:** no cross-instance recovery (each instance manages only its own live queue) + a one-time `debug.warn`; NEVER throw. | Web Locks is near-universal (Chrome 69+, Firefox 96+, Safari 15.4+, all workers), so the degrade is rare. A staleness-heartbeat fallback (the node mechanism) is a deferred hardening, not v1. Mirrors the edge ALS-absent degrade. |
| **BD7** | **Scope v1 = the durable BUNDLE queue** (browser + webworker — the immediate clash). The capture-chunk store + report-marker store (browser; webworker capture is #165) fold onto the SAME framework next: a dead instance's full data (bundles + chunks + markers) is recovered together, exactly as node's `recoverInstances` recovers a dead subtree's `pending/` + `incidents/` + `capture/`. | Keeps the first slice shippable + independently correct (the bundle queue is where the clash bites first); the capture/marker coexistence is the same instanceId-prefix + same coordinator. |
| **BD8** (slice 5) | **Capture chunks + report markers are instanceId-prefixed inside per-TOKEN DBs** — `bugsee-capture-<tokenHash>` / `bugsee-markers-<tokenHash>`, each key `"<instanceId>/<innerKey>"`. The SAME per-instance Web Lock (BD2, keyed by instanceId) gates them — one lock per instance covers bundles + chunks + markers. `generation` stays `clock.wallNow()`. | Reuses the slice-4 model exactly (instanceId prefix, not a per-generation lock): the random instanceId makes cross-tab key collisions IMPOSSIBLE (each tab writes under a distinct prefix), so `generation` needs no uniqueness change and the chunk-number collision a shared-generation would cause is structurally avoided. Per-token DBs are the wrong-project guard (the instanceId space is global → without per-token DBs, app B would scan app A's instanceIds as "siblings"). |
| **BD9** (slice 5) | **All capture recovery is DEAD-SIBLING recovery; self never self-recovers.** A fresh instanceId per launch ⇒ self's capture/marker namespace is EMPTY at launch. The prior crashed session is a dead sibling (different instanceId); the coordinator runs core `recoverReports` over each DEAD sibling's prefixed views (`currentGeneration: -1` ⇒ every one of its generations is eligible), under that sibling's Web Lock. A LIVE sibling holds its lock ⇒ skipped ⇒ its chunks/markers are NEVER read, recovered, or swept. | This is what closes the SEV1 (a live tab can no longer sweep/steal another live tab's capture). **`recoverReports` (core) is UNCHANGED** — it is simply called over prefixed views instead of the shared store, so node is unaffected and there is zero core-regression risk. The old self-recovery (preserve-prior-generations + `cleanOtherGenerations:false` + self-`recoverReports`) is REMOVED — self's namespace has only its own live generation. |
| **BD10** (slice 5) | **Dead-sibling discovery = the union of instanceIds across the bundle ∪ marker ∪ capture stores.** Incident recovery is marker(/bundle)-triggered; the capture store is ALSO scanned (a new keys-only `AsyncKeyedStore.keys(prefix)` — `getAllKeys`, no values) so a dead sibling that captured but never had an incident still gets its rolling buffer SWEPT. | Markers/bundles are small (cheap `loadAll`); the capture keys-only scan reclaims the common case (a tab closed cleanly with no crash) — matching the single-instance store's self-cleaning (which swept a prior generation on the next launch). Without it, every clean session would orphan up to `maxDataSize` of capture. |

## 4. Architecture

```
IndexedDB database:  bugsee-<tokenHash>
  object store 'bundles':  key = "<instanceId>/<bundleId>"  →  bundle bytes
Web Lock (per live instance):  "bugsee/<tokenHash>/<instanceId>"   # held for the realm's lifetime
```

New components (all in `@bugsee/browser-utils`, pure/injectable where possible):
- **`makeInstanceId()`** — short random hex per launch.
- **`createWebLockLiveness(locks?)`** — `holdSelf(name)` (acquire + hold for lifetime), `recoverIfDead(name, fn)`
  (run `fn` holding a dead sibling's lock; no-op if alive), `available` (false → degrade). Injectable `LockManager`.
- **`createPrefixedBlobStore(shared, instanceId)`** — a per-instance `AsyncBlobStore` VIEW over the shared one:
  `put`/`remove` prefix the key with `"<instanceId>/"`; `loadAll()` returns only this instance's pairs (prefix
  stripped). Pass to `createPersistentBundleStore` → the instance's own bundle store.
- **`recoverDeadInstances({ shared, selfInstanceId, lockName, recoverOne, liveness, onError })`** — the
  coordinator: `shared.loadAll()` → group keys by instanceId prefix → for each ≠ self →
  `liveness.recoverIfDead(lockNameFor(id), () => recoverOne(idsBundles))`. `recoverOne` re-uploads via the
  durable pipeline + removes the keys. Idempotent + signature-deduped.

Integration (`@bugsee/browser` + `@bugsee/webworker` launch): build `instanceId`; open the shared
token-namespaced blob store; wrap a per-instance view for the durable bundle store; `liveness.holdSelf(...)`;
after `client.launch()`, run `recoverDeadInstances(...)` instead of the own `durable.recover()`.

### Instance state machine (mirrors the node subtree machine)
```
LIVE (holds its Web Lock; writes under its "<instanceId>/" prefix)
  → DEAD (realm destroyed → lock auto-released)                         # detected by a peer at launch
  → CLAIMED (a peer acquires the dead lock with ifAvailable)           # the lock IS the claim; one winner
  → RECOVERED (its bundles fed to the durable pipeline + re-uploaded)  # existing pipeline
  → REMOVED (its "<instanceId>/" keys deleted)                          # on success; held under the lock
A peer that crashes mid-recovery releases the lock → the prefix is re-claimable next launch (idempotent).
```

## 5. Slice plan (each: test-first → per-entity mutator → multi-agent review → commit)

0. **Spike** — verify `navigator.locks` semantics in fake/test: a held exclusive lock makes `ifAvailable` yield
   `null` (alive); a released lock yields a non-null lock (dead). Provide a small in-memory `LockManager` fake
   for unit tests (fake-indexeddb has no Web Locks). ✅ DONE (folded into slice 1).
1. ✅ **Web Locks liveness** — `createWebLockLiveness` (holdSelf / recoverIfDead / availability degrade) + the
   in-memory fake. Heavy unit coverage incl. the absent-`navigator.locks` degrade + the concurrent-claim skip.
   (Commit `f5b4c1b`; the `holdSelf` rejection→warn hardening added in the slice-4 review round.)
2. ✅ **Per-instance blob view + sync token hash** — `makeInstanceId`, `hashToken` (sync), `createPrefixedBlobStore`
   (prefix put/remove, prefix-filtered loadAll). Unit coverage (isolation: instance A never sees B's keys). (`2df27ae`.)
3. ✅ **`recoverDeadInstances` coordinator** + `recoverSiblingBundleQueue` (awaitable dead-sibling bundle recovery) —
   scan → group → recoverIfDead → re-upload + delete. Tests: dead sibling recovered once; live sibling untouched;
   own-prior-crash recovered; degrade (no locks) → no cross-recovery. (`2df27ae` + `086b8bd`.)
4. ✅ **Wire into `@bugsee/browser` + `@bugsee/webworker` launch** via `createCoexistentBundleQueue` — instanceId +
   token db + per-instance bundle store + holdSelf + recoverDeadSiblings. Existing suites stay green; new tests
   assert two same-origin launches don't cross-recover a LIVE peer but DO recover a dead one, and a different app
   token is never touched. (`66c453e`.)
5. ✅ **Capture-chunk + marker coexistence** (browser; webworker #165) — BUILT (`beed7a4` + review `a5d84f8`).
   `createCoexistentBundleQueue` generalized to `createCoexistence` (bundles + per-instance capture/marker VIEWS +
   ONE unified dead-sibling coordinator); per-token DBs `bugsee-capture-<hash>`/`bugsee-markers-<hash>`; new
   `createPrefixedKeyedStore` + `AsyncKeyedStore.keys()` (keys-only discovery, BD10). The browser launch now does
   ALL recovery as dead-sibling recovery (self-recoverReports + preserve-prior-generations removed); core
   `recoverReports` UNCHANGED, called over the dead sibling's prefixed views with `currentGeneration: -1`. **Closes
   the §1 SEV1.** The generation-collision worry BD8 resolved structurally: the random instanceId prefix makes
   cross-tab key collisions impossible, so `generation` stays wall-time (no uniqueness change needed).
6. **Docs + memory** — PROGRESS.md, CLAUDE.md note, memory. (PROGRESS.md + memory updated for slices 1–5.)

## 6. Risks / caveats
- **No `navigator.locks`** (very old browser / disabled) → BD6 degrade (no cross-recovery; own queue still
  works). A staleness-heartbeat fallback is deferred.
- **DB rename `'bugsee'` → `'bugsee-<tokenHash>'` has no migration.** The pre-coexistence browser build wrote
  the bundle queue to db `'bugsee'` (un-prefixed); the new path reads only `'bugsee-<tokenHash>'`. **Decision:
  accept the orphan, no migration** — the SDK is **unreleased** (no production build has ever persisted to the
  old `'bugsee'` bundle DB in the wild), so there is nothing to migrate. If a build ever ships before this note
  is revisited, add a one-time legacy-`'bugsee'` read on first launch. (The generic `createIdbBlobStore()`
  default name is still `'bugsee'`; every browser-tier *caller* now passes an explicit per-token name.)
- **Startup lock-grant TOCTOU.** `holdSelf` returns synchronously but the real `navigator.locks` grants on a
  later microtask, so for a brief window after launch the instance's lock is not yet held. Harmless: a fresh
  instance has **no bundles under its prefix until an actual incident** (an incident bundle is `put` far later
  than launch, never synchronously), and `recoverDeadInstances` only forms sibling-ids from EXISTING keys — so a
  peer never targets a young instance with an empty prefix. The signature-dedup is the backstop even if it did.
- **`holdSelf` lock-request rejection** (invalid lock name / sandboxed context) is caught and routed to the
  liveness `warn` sink — it must never float as an `unhandledrejection` (Bugsee would self-report its own
  internal lock failure as an app error).
- **Storage eviction / quota** — IDB can be evicted under pressure; orthogonal to coexistence (affects single
  instance too), handled by the best-effort `onError` discipline already in the persistent stores.
- **A lock held by a hung-but-alive realm** reads as ALIVE (correct — its bundles are still its responsibility);
  unlike node there is no PID-reuse or heartbeat-staleness ambiguity to bound.

## 7. Deferred
- Capture-chunk + marker coexistence is slice 5 (same framework); the webworker rolling-buffer IDB store (#165)
  lands coexistence-aware.
- In-memory session sharing / report forwarding (worker → page client) — separate design (overlaps the node
  non-goal §2).
- A staleness-heartbeat liveness fallback for the no-`navigator.locks` degrade.
