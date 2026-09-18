# Batching symbol uploads (one archive, or one registration, for many maps)

Status: **note / not built.** Written 2026-09-18 against bugsee-cli `feat/sourcemap-upload-throughput`
(PR #42), worker `master`, and `@bugsee/bundler-plugin-core` at `40ef8ff`.

This is the parking spot for "why don't we pack every chunk's source map into one ZIP and send it
once?". It needs a cross-repo sweep (appserver + worker + CLI + JS plugin), so it is written down
rather than built. Every number below is measured and says how.

## What happens today

One symbol document per source map, two round-trips each:

1. `POST /apps/<token>/symbols` with `{uuid, version, build, hash, …}` → a presigned endpoint, or
   `DuplicateSymbolsFoundError` (code 16004) when the server already has that uuid;
2. `PUT` the zstd archive holding that one `.map`.

A 200-chunk web build is therefore 400 requests. bugsee-cli PR #42 made them run up to 8 at a time
(`--concurrency`, ceiling scaled to the batch), which took 200 maps from **23.58 s to 4.10 s**
against a mock with 50 ms of latency. That is the baseline any batching scheme has to beat.

## The upload wire already allows a multi-identity archive

`presigned::Metadata` carries `uuids: Option<&[String]>` — "the Mach-O slice UUIDs declared up front
so the server can dedup BEFORE signing an upload URL". It is how a dSYM bundle with several slices,
and an IL2CPP multi-ABI line-map, upload as ONE archive today. So "one archive, many debug-ids" is
an established shape on the upload side, not a new protocol.

## Why it does not work yet — the read side

`symbolfiles/__init__.py :: get_symbol_file` extracts the archive and, with no `symbol_file_filter`,
picks `file_list[0]`. The JS symbolication path passes no filter (`crash/javascript.py:402`).

So a 200-map archive registered under 200 debug-ids would hand **every** frame the first map in the
zip: not an error, just wrong line numbers. That is the blocker, and it is in the worker, not the
CLI. The fix already exists next door — the symcache path selects the member whose name matches the
requested debug id (`_same_debug_id`, same file) — but it is a worker change plus a storage-layout
decision (member naming must be keyed by debug-id).

## Three costs that survive even after that fix

1. **Per-map dedup disappears.** The server dedups by uuid, so a rebuild re-sends only the chunks
   that changed — pinned by the e2e flow `sourcemaps_rebuild_registers_both_chunks_and_puts_only_the_changed_one`.
   With one archive, one changed chunk re-uploads all 200 maps on every deploy. Declaring all uuids
   does not help: the duplicate answer is for the whole set.
2. **Read amplification.** Every symbolication downloads and extracts the symbol archive to read one
   map. Today that is one map's zip (tens of KB); batched it is the whole archive (0.5–2 MB) per
   lookup, unless the worker re-splits and caches per uuid on ingest.
3. **The byte win is modest.** 60 real maps from this repo's `dist` output (2.47 MB raw):

   | | size |
   |---|---|
   | per-map zstd-11, summed | 0.62 MB |
   | one zstd-11 archive of all 60 | 0.54 MB |
   | saving | **13%** |

   Chunks of a single app share more text than 60 unrelated packages do, so a real app is probably
   25–40%, but it is not the order-of-magnitude the request count suggests.

Also: one archive is all-or-nothing on failure, and packing a few hundred maps means holding the
whole archive in memory (the chunked-upload path exists for build artefacts, not for symbols).

## Options

| | what changes | request count (200 maps) | keeps per-map dedup | read side |
|---|---|---|---|---|
| **A. One ZIP for the whole build** | CLI packs all maps, declares `uuids: [...]`; worker selects the member by debug-id | 2 | ✗ | needs member-by-debug-id + re-split/cache |
| **B. Batch the registration only** | appserver accepts N uuids → returns N presigned URLs; CLI PUTs each map in parallel | 201 | ✓ | unchanged |
| **C. Today (PR #42)** | — | 400, 8 in flight | ✓ | unchanged |

**B is the recommendation** if we act: it removes half the round-trips (the half that is a small JSON
POST and therefore pure latency), keeps per-uuid dedup and the current read path, and is an appserver
change plus a small CLI change — no worker work, no storage-layout decision. A is the bigger win on
paper and the bigger blast radius in practice.

## Cross-repo scope when we pick this up

- **appserver** — batch-register endpoint (B), or multi-uuid symbol documents for sourcemaps (A).
- **worker** — only for A: member selection by debug-id in `get_symbol_file`, ingest-time re-split
  or per-uuid cache, and a decision on how archive members are named.
- **bugsee-cli** — `debug-files upload --type sourcemaps`: build the batch, then either one PUT (A)
  or N parallel PUTs against N presigned URLs (B). `--concurrency` stays meaningful under B.
- **bugsee-javascript** — `@bugsee/bundler-plugin-core` only needs the new CLI version; no API change.

Tracking issues: [bugsee-javascript#7](https://github.com/bugsee/bugsee-javascript/issues/7)
(the cross-repo one) and [bugsee-cli#43](https://github.com/bugsee/bugsee-cli/issues/43) (the CLI
side, blocked on the appserver/worker decision).
