# Browser/worker multi-instance IndexedDB coexistence + recovery — design

**Status:** DESIGN (2026-06-29). The browser/worker-tier counterpart of the BUILT node
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
| **BD4** | **Opportunistic cross-instance recovery on launch, reusing the existing pipeline** — identical to node's `recoverInstances`. After `client.launch()`: scan the shared store's keys → distinct instanceIds → for each ≠ self that is DEAD → recover its bundles (feed them to the durable upload pipeline) + delete its keys, under its lock. Never touch a live sibling or self. | This is Android's "any live instance recovers any dead one". An instance's own prior crashed session is just a dead sibling (different instanceId) → recovered by the same path. Replaces the per-instance `durable.recover()` (own queue) — a fresh instance's own queue is empty at launch. |
| **BD5** | **Discovery is key-prefix-derived; no registry store.** Distinct instanceIds come from `loadAll()` key prefixes. An instance with no pending bundles is invisible (nothing to recover). | Simpler than a registry + its own GC; the durable data already names its owner. (Node needed `owner.json` only to carry the pid for `kill(pid,0)`; Web Locks needs no such record.) |
| **BD6** | **Degrade where `navigator.locks` is absent:** no cross-instance recovery (each instance manages only its own live queue) + a one-time `debug.warn`; NEVER throw. | Web Locks is near-universal (Chrome 69+, Firefox 96+, Safari 15.4+, all workers), so the degrade is rare. A staleness-heartbeat fallback (the node mechanism) is a deferred hardening, not v1. Mirrors the edge ALS-absent degrade. |
| **BD7** | **Scope v1 = the durable BUNDLE queue** (browser + webworker — the immediate clash). The capture-chunk store + report-marker store (browser; webworker capture is #165) fold onto the SAME framework next: a dead instance's full data (bundles + chunks + markers) is recovered together, exactly as node's `recoverInstances` recovers a dead subtree's `pending/` + `incidents/` + `capture/`. | Keeps the first slice shippable + independently correct (the bundle queue is where the clash bites first); the capture/marker coexistence is the same instanceId-prefix + same coordinator. |

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
   for unit tests (fake-indexeddb has no Web Locks).
1. **Web Locks liveness** — `createWebLockLiveness` (holdSelf / recoverIfDead / availability degrade) + the
   in-memory fake. Heavy unit coverage incl. the absent-`navigator.locks` degrade + the concurrent-claim skip.
2. **Per-instance blob view + sync token hash** — `makeInstanceId`, `hashToken` (sync), `createPrefixedBlobStore`
   (prefix put/remove, prefix-filtered loadAll). Unit coverage (isolation: instance A never sees B's keys).
3. **`recoverDeadInstances` coordinator** — scan → group → recoverIfDead → re-upload + delete. Tests over the
   in-memory blob + lock fakes + a vi.fn pipeline: dead sibling recovered once; live sibling untouched;
   own-prior-crash recovered; concurrent-claim single winner; degrade (no locks) → no cross-recovery.
4. **Wire into `@bugsee/browser` + `@bugsee/webworker` launch** — instanceId + token db + per-instance bundle
   store + holdSelf + recoverDeadInstances (replacing own `durable.recover()`). Existing suites stay green; new
   tests assert two same-origin launches don't cross-recover a LIVE peer but DO recover a dead one.
5. **Capture-chunk + marker coexistence** (browser; webworker #165) — the same instanceId prefix on the
   `bugsee-capture`/`bugsee-markers` DBs + the coordinator recovering a dead instance's chunks+markers too.
6. **Docs + memory** — PROGRESS.md, CLAUDE.md note, memory.

## 6. Risks / caveats
- **No `navigator.locks`** (very old browser / disabled) → BD6 degrade (no cross-recovery; own queue still
  works). A staleness-heartbeat fallback is deferred.
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
