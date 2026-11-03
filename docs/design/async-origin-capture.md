# Async origin capture — giving stackless rejections a call site

Status: DESIGN (research done, nothing implemented). Trigger: staging report BGSVIEWER-14 — an `unhandledrejection` whose
reason is `NotSupportedError: The element has no supported sources.` with `crash.json.exception.frames = []`.

## 1. The problem is real, and it is not in the SDK's parsing

`HTMLMediaElement.play()` on an element that cannot load rejects **from a media task, with no JavaScript on the stack**. The
`DOMException` is a genuine `Error` but its `.stack` is `undefined` (Chromium 156) — there is nothing to parse and nothing to
recover at detection time. The only place the call site exists is **the moment the API is called**.

It is not specific to `play()`. Measured with `probe.mjs` (this directory; headless Chromium 156.0.8078.4 and Firefox 151; WebKit
could not be run — the cached build did not match the installed Playwright):

| Reason of the rejection | Chromium | Firefox |
|---|---|---|
| User code: `async` throw / `Promise.reject(new Error)` / `new Promise` + `reject(new Error)` | frames, call site named | frames, call site named |
| User code: `Promise.reject('str')` / `Promise.reject()` / `Promise.reject({..})` | **no stack** (not an Error) | **no stack** |
| Platform API, rejected **synchronously** during argument validation (bad constraints, bad URL, bad algorithm name, bad key data, `OffscreenCanvas(0,0).convertToBlob`, `RTC.setRemoteDescription(bad)`, `permissions.query(bogus)`) | frames, call site named | frames, call site named |
| `fetch` network failure (`TypeError: Failed to fetch`) | frames, call site named | frames, call site named |
| Platform API that fails **later, asynchronously** | see §2 | fewer, see §2 |

**Conclusion: user-code rejections of `Error`s need no Promise patching** — their stack is created in user code and survives to
`unhandledrejection`. Only (a) non-`Error` user rejections and (b) platform async failures lack a location.

## 2. The stackless set (measured)

`frames = 0` means the reason's `.stack` is absent or only `Name: message`.

| API | Reason | Chromium | Firefox |
|---|---|---|---|
| `HTMLMediaElement.play` | NotSupportedError | **stackless** | has call site |
| `Clipboard.readText` / `writeText` (and `read`/`write`) | NotAllowedError | **stackless** | (did not reject in the probe) |
| `WakeLock.request` | NotAllowedError | **stackless** | (did not reject) |
| `ServiceWorkerContainer.register` | TypeError | **stackless** | **stackless** |
| `RTCPeerConnection.addIceCandidate` (state error) | InvalidStateError | **stackless** | has call site |
| `FileSystemDirectoryHandle.getFileHandle` (after an `await`) | TypeError | **stackless** | has call site |
| `HTMLImageElement.decode` | EncodingError | **stackless** | **stackless** |
| `BaseAudioContext.decodeAudioData` | EncodingError | **stackless** | **stackless** |
| `FontFace.load` | NetworkError | **stackless** | **stackless** |
| `FontFaceSet.load` (bad shorthand) | SyntaxError | **stackless** | has call site |
| `MediaDevices.getUserMedia` (device not found) | NotFoundError | **stackless** | **stackless** |
| `Worklet.addModule` (`CSS.paintWorklet`) | AbortError | **stackless** | (threw synchronously) |
| `createImageBitmap` (undecodable) | InvalidStateError | **stackless** | **stackless** |
| `Body.json` (invalid JSON) | SyntaxError | (no rejection seen) | **stackless** |
| dynamic `import()` failure (404 / syntax error) | TypeError / SyntaxError | **stackless** | **stackless** |
| `WebAssembly.compile` / `instantiate` | CompileError | 1 frame, **no user frame** | has call site |
| `structuredClone` inside a `.then` | DataCloneError | 1 frame, **no user frame** | has call site |

The pattern: **the more asynchronous the failure (media tasks, permission prompts, network/decoder work, workers), the less
likely a stack exists, and Chromium is much worse than Firefox.** WebKit is untested; assume it behaves like one of the two.

`import()` is syntax, not a function — it **cannot be patched**. Its message already carries the URL
(`Failed to fetch dynamically imported module: <url>`), which is the useful part.

## 3. The complete candidate list

Every promise-returning method declared in TypeScript's `lib.dom.d.ts` (6.0.3): **80 interfaces, 187 methods** (the generator also finds
the stream readers/writers, `ReadableStream.cancel/pipeTo` and `LockManager.request`, which the hand-made list below omits; all eleven are
classified `off`). The list below is the original hand-made one; the generated snapshot is `packages/capture/spec/dom-promise-methods.snapshot.json`
and the classified table is `packages/capture/src/async-origin-table.ts`. A method that can
reject without a stack is any of these whose failure is not argument validation. This list is the patch table's source of truth
and must be regenerated, not hand-maintained (§5).

```
AudioContext: close,resume,suspend
AudioDecoder: flush            AudioEncoder: flush
BaseAudioContext: decodeAudioData
Blob: arrayBuffer,bytes,text
Body: arrayBuffer,blob,bytes,formData,json,text            (mixin → Request.prototype, Response.prototype)
CSSStyleSheet: replace
Cache: add,addAll,delete,keys,match,matchAll,put
CacheStorage: delete,has,keys,match,open
Clipboard: read,readText,write,writeText
ClipboardItem: getType
CookieStore: delete,get,getAll,set
CookieStoreManager: getSubscriptions,subscribe,unsubscribe
CredentialsContainer: create,get,preventSilentAccess,store
CustomElementRegistry: whenDefined
Document: exitFullscreen,exitPictureInPicture,hasStorageAccess,requestStorageAccess
Element: requestFullscreen,requestPointerLock
FileSystemDirectoryHandle: getDirectoryHandle,getFileHandle,removeEntry,resolve
FileSystemFileHandle: createWritable,getFile
FileSystemHandle: isSameEntry
FileSystemWritableFileStream: seek,truncate,write
FontFace: load                 FontFaceSet: load
GPU: requestAdapter            GPUAdapter: requestDevice
GPUBuffer: mapAsync            GPUDevice: createComputePipelineAsync,createRenderPipelineAsync,popErrorScope
GPUQueue: onSubmittedWorkDone  GPUShaderModule: getCompilationInfo
GamepadHapticActuator: playEffect,reset
HTMLImageElement: decode
HTMLMediaElement: play,setMediaKeys,setSinkId
HTMLVideoElement: requestPictureInPicture
IDBFactory: databases
ImageCapture: getPhotoCapabilities,getPhotoSettings,grabFrame,takePhoto
ImageDecoder: decode
LockManager: query
MIDIPort: close,open
MediaCapabilities: decodingInfo,encodingInfo
MediaDevices: enumerateDevices,getDisplayMedia,getUserMedia
MediaKeySession: close,generateRequest,load,remove,update
MediaKeySystemAccess: createMediaKeys
MediaKeys: getStatusForPolicy,setServerCertificate
MediaSession: setCameraActive,setMicrophoneActive
MediaStreamTrack: applyConstraints
NavigationPreloadManager: disable,enable,getState,setHeaderValue
Navigator: requestMIDIAccess,requestMediaKeySystemAccess,share
NavigatorBadge: clearAppBadge,setAppBadge
NavigatorLogin: setStatus
OfflineAudioContext: resume,startRendering,suspend
OffscreenCanvas: convertToBlob
PaymentRequest: abort,canMakePayment,show
PaymentResponse: complete,retry
Permissions: query
PushManager: getSubscription,permissionState,subscribe
PushSubscription: unsubscribe
RTCPeerConnection: addIceCandidate,createAnswer,createOffer,getStats,setLocalDescription,setRemoteDescription
RTCRtpReceiver: getStats
RTCRtpSender: getStats,replaceTrack,setParameters
ReadableStreamGenericReader: cancel
RemotePlayback: cancelWatchAvailability,prompt,watchAvailability
Scheduler: postTask,yield
ScreenOrientation: lock
ServiceWorkerContainer: getRegistration,getRegistrations,register
ServiceWorkerRegistration: getNotifications,showNotification,unregister,update
StorageManager: estimate,getDirectory,persist,persisted
SubtleCrypto: decrypt,deriveBits,deriveKey,digest,encrypt,exportKey,generateKey,importKey,sign,unwrapKey,verify,wrapKey
VideoDecoder: flush            VideoEncoder: flush            VideoFrame: copyTo
WakeLock: request              WakeLockSentinel: release
WebTransport: createBidirectionalStream,createUnidirectionalStream
WindowOrWorkerGlobalScope: createImageBitmap,fetch         (mixin → Window / WorkerGlobalScope)
Worklet: addModule
```

Not in `lib.dom.d.ts` but real: `window.show{Open,Save}FilePicker`, `showDirectoryPicker`, `queryLocalFonts`, `Notification.requestPermission`,
`Document.fonts.ready`, `ServiceWorker`/`Client.postMessage` (no promise), `WebAssembly.{compile,instantiate,*Streaming}`,
`navigator.{bluetooth,usb,hid,serial}.*`, `Atomics.waitAsync`, `Response`/`Request` bodies, `structuredClone` (sync).
Add them by hand with a source note.

## 4. Design (v2 — revised after an independent review, §9)

There is no hook at the origin other than the call (`ReportingObserver`, `PerformanceObserver`, `console.createTask`,
`Error.prepareStackTrace` were checked: none yields anything for a media-task rejection), so the SDK wraps each listed method.

### 4.1 The wrapper

The trap that shapes everything: **attaching ANY reaction to a promise marks it handled**, so a side branch
(`p.then(noop, record)`) silently disables `unhandledrejection` for the app. The wrapper therefore returns a derived promise through a **pristine `then`**, and falls back to a no-reaction mode only when no
pristine `then` exists (§4.1a):

```ts
// derived mode: return a DERIVED promise (same reason object) built with a PRISTINE then; key the origin by reason
const origin = { error: new Error(), target: this, method };      // stack formatted lazily, only on failure
const p = original.apply(this, args);
if (!isThenable(p)) return p;
const then = pristineThen(p);                                     // §4.1a — NEVER the global Promise.prototype.then
if (then !== undefined) return then.call(p, undefined, (r) => { if (isObject(r)) byReason.set(r, origin); throw r; });

// fallback (no pristine then available): attach NO reaction; key the origin by the returned promise
const p = original.apply(this, args);
if (isObject(p)) byPromise.set(p, origin);
return p;                                                         // look up with event.promise
```

Why this shape (measured, Chromium 156 and Firefox 151):
- With zone.js 0.14.10 / 0.16.3 loaded, plain `p.then` returns a `ZoneAwarePromise` and the derived promise's rejection **never reaches
  `unhandledrejection`**; a bare native `play()` rejection still does. A pristine `then` (§4.1a) gives a native derived promise, the
  event fires with the same reason object, and the lookup by reason succeeds (Chromium and Firefox, bare and native `await`).
- The no-reaction fallback only locates a **bare** `p` (`event.promise === p`). `await v.play()`, `play().then(...)` and a
  downleveled `__awaiter` all surface a different `event.promise`, so the lookup misses (measured everywhere). It is a last resort,
  not a peer mode.
- The derived promise settles one microtask later than the original.

Not used: a `Proxy` (apply trap +3.3 µs in Firefox, 20 µs cold), `Error.stackTraceLimit` tuning (capture cost is flat across limits;
20% memory only, and it contradicts `packages/core/src/stack.ts:283-285`), side-branch reactions.

### 4.1a Obtaining a pristine `then` (measured; changes the earlier design)

Capturing `Promise.prototype.then` **from the global** and calling it on the platform's promise is wrong whenever the global `Promise` was
replaced: with zone.js, core-js forced over a deleted native `Promise`, Bluebird (its UMD overwrites `window.Promise`), es6-promise
and RSVP, the captured `then` throws a `TypeError` **synchronously inside the wrapped `play()`** ("Incompatible receiver",
"this._then is not a function", "reading 'push'"). A wrapper must never be able to break the app call, so:

1. Per call, take the `then` from the promise the platform returned, in this order: `p.__zone_symbol__then` (zone.js stores the native
   one on native promises), else a `then` captured **at install** from a clean realm (a fresh hidden iframe's `Promise.prototype`,
   called on `p`; or the global one if it was still native at install), else none.
2. Call it inside a `try`; if it throws or returns a non-thenable, return the original `p` untouched (no origin recorded) — a
   failed wrapper degrades to no wrapper, never to a broken call.
3. Install order matters: if the SDK loads before zone.js, capturing at install is enough; after, rely on `__zone_symbol__then` or
   the iframe realm. Without a document (worker) only the first two apply.

Plain `p.then` under zone is the regression to avoid: the native event is lost for a bare `play()`, and the reason only reaches
`NgZone.onError` / `ErrorHandler`.

### 4.2 Capture and retention

- `new Error()` at call time (about 0.7 µs in Chromium, 2 µs in Firefox), then `Error.captureStackTrace(holder, wrapper)` where the
  engine supports it, so the wrapper's own frame is not in the stack. Formatting `.stack` (2.7-3.8 µs) happens only when a
  rejection with no frames is reported.
- Retained per pending origin: about 600 B (Chromium, depth 8). It lives until the promise settles. A `{when, target}` token with
  no stack is 36 B and is what hot rows may use (§4.4).
- `remember` stores only a reason that is an object **without usable frames**; nothing is retained for a rejection that already
  has a stack.

### 4.3 What is reported: the call site AND the target

For `play()` the call site is the weaker signal; **`this` carries the root cause**. After the failure, in Chromium the element held
`networkState = 3`, `error.code = 4` and `error.message = "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed"`; in Firefox `"Failed to open media"`. So the origin keeps `target` (free, and released on settle) and the report adds a
description read **at report time** (the media `error` event fires before the rejection in Chromium and after it in Firefox, so
never at call time): tag/id, scrubbed `currentSrc`, `networkState`, `readyState`, `error.code/message`. Per-API describers are a
small table next to the method table (media element, image, font face, audio context, service worker container, ...); an API with
no describer reports the call site only.

~~A zero-cost complement: one capture-phase `error` listener on `document` recording failing media/image loads as a system event.~~ Dropped (see §7, step 6): it would need a new spec event name and adds timeline noise for little over the Target line.

### 4.4 Gating: arm on first failure, not a rate breaker

The earlier proposal stopped capturing above ~200 calls/s. That is inverted: in a hot loop the first calls are usually the
successful ones, and the breaker trips exactly when failures begin.

- **Rare set** (play, clipboard, wakeLock, getUserMedia, `serviceWorker.register`, pickers, worklet, `decodeAudioData`,
  file-system handles): always capture.
- **AS BUILT (step 4):** an `armed` row is not wrapped at all until `recorder.arm()` is called, which the provider does on the first
  stackless rejection nobody could locate. That is cheaper than the pass-through below (zero cost before the first failure, not one
  boolean) and needs no per-call reaction to learn that a method failed. The trade-off: arming is for ALL armed rows at once, not the
  one that failed, so afterwards the hot rows pay for capture too, bounded by the per-method budget (200 captures per minute per method,
  reset by one shared 60 s timer). Verified in headless Chromium 156 with and without zone.js: a bare `play()` still raises
  `unhandledrejection`, the origin is found by reason, and the recorded stack starts at the caller's frame.
- **Every other row: armed after its first rejection.** Before that the wrapper is a pass-through with one boolean check (about
  the cost of the native call); the first failure is reported without a call site (the report still has name/message and, where a
  describer exists, the target), and from the second failure on the call site is captured. Cost on the fast path: one load and
  one compare.
- A per-method **capture budget** (a counter reset by one shared 60 s timer, not `Date.now()` per call) bounds the cost when a
  armed method fails in a loop.

### 4.5 How the origin reaches `crash.json` (the seam)

`syntheticFrames` is **not** the seam. It is read only when the thrown value is not an `Error`
(`packages/core/src/crash.ts:333-339`), and a `DOMException` is an `Error` in both engines, so BGSVIEWER-14 takes
`buildException` (`crash.ts:196-206`), where `parsed = []` and the only extension point is `enrichFrames`
(`type FrameEnricher`, `crash.ts:85`; chained by `composeFrameEnrichers`, `crash.ts:93`).

- Add an `asyncOriginEnricher: FrameEnricher` that returns the origin's frames when `parsed.length === 0` (and the reason has an
  origin), tagged so the viewer can tell a call-site frame from a thrown one (§8, protocol question).
- Thread it into the **browser** `crashOf` the way node already does (`packages/node/src/detection-providers.ts:44-54` passes
  `enrichFrames`); the browser provider passes neither today (`packages/browser/src/detection-providers.ts:44-46`).
- `describeError` (`detection-providers.ts:28-40`) returns only `{ summary }` for an Error without a stack; it needs the same
  fallback (origin frames + the §4.3 target description) or the report has frames but a bare description.
- The same enricher must run on the **handled** path (`logException` / `captureException`, `packages/core/src/client.ts`), and on
  every framework adapter that captures an error instead of letting it reach `unhandledrejection` (§10): a stackless rejection that
  a framework swallows into its own error handler is exactly as useless as BGSVIEWER-14.
- The enricher also walks `reason.cause` (a few levels) when the reason itself has no origin: `axios`, `ky`, `ofetch` and Mithril `m.request` wrap the
  platform failure in their own class and keep the original only there (§10.4).
- Lookup at report time is **by reason, everywhere** (the reason object is the only thing that survives every path below); by
  `event.promise` only in the fallback mode, bare call only.
- Paths that carry the same stackless reason without ever raising `unhandledrejection` (measured, §10): Vue `app.config.errorHandler`
  (Vue attaches a `.catch` to promises returned by handlers/hooks/watchers), React 19 `use()` and error boundaries
  (`onCaughtError`, `componentDidCatch`), Alpine and a React root with no boundary (the window `error` event →
  `crashOfErrorEvent`, `detection-providers.ts:54`), TanStack Query (thrown to the caller), zone.js chains (`NgZone.onError`).
  `buildCrashJson` must therefore get the origin on **every** Error path, not only the `unhandledrejection` provider.

### One factory for every method, and what it costs (measured)

All patched methods go through ONE factory, `wrapPromiseMethod(prototype, name, options)`, which does the lookup, the guarded
define, the idempotency mark, the `toString` delegation, the restore and the wrapper above. A new API is then one table row, not
new code. The table row carries only data: `{ target, methods, hot?, why }`.

Measured with `bench.mjs` (this directory) on a cheap real async call (`crypto.subtle.digest`, 20 000 calls, median of 5):

| | Chromium 156 | Firefox 151 |
|---|---|---|
| native call | 1.2 µs | 4.3 µs |
| wrapper (`apply` + `.then`), no `Error` | 1.37 µs | 6.7 µs |
| **wrapper + `new Error()` (proposed)** | **2.33 µs** | **9.05 µs** |
| hand-written specialised wrapper + `Error` | 2.11 µs | 9.05 µs |
| `new Error()` alone / `new Error().stack` | 0.71 / 1.66 µs | 1.44 / 1.60 µs |

- **The unified factory costs nothing measurable** over a hand-written wrapper (2.33 vs 2.11 µs Chromium; identical in Firefox): the
  JIT specialises the closure per method. Unifying is free, and it is also the only way to keep the table maintainable.
- **Where the overhead goes** (independent measurements): in Chromium the derived `then` is about +10 ns and `new Error()` about +0.7 µs. In
  Firefox the derived `then` itself costs +2.4 µs and `new Error()` about +4 µs more, so a no-reaction mode is about 3x cheaper there
  (+0.7 µs). Reading `.stack` is paid only on a rejection that has no frames.
- That is noise for `play`, `getUserMedia`, clipboard, `decode` (a few calls per page) and visible only for APIs called thousands of
  times a second, which is exactly the `hot` list kept out of the default set. If one of those is ever wanted, the factory takes
  `capture: false` (0.17 µs) or a sampling rate, so the choice is data, not code.
- Not measured: real-page effects of the extra microtask, and the retained-`Error` memory under very many pending promises.

### Which listed methods can sit in a tight loop

Judged from how apps use them (not measured per app); the SDK's own code is not affected — its loops use
`ReadableStreamDefaultReader.read()` (fetch/bundle body streaming), which is **not** in the list, and `blob.arrayBuffer()` once per
bundle.

| Class | Methods | Where the loop comes from | Default |
|---|---|---|---|
| **Hot** (per frame / per chunk / per task) | `Scheduler.postTask`, `Scheduler.yield`; `FileSystemWritableFileStream.write/seek/truncate`; `GPUBuffer.mapAsync`, `GPUQueue.onSubmittedWorkDone`, `GPUDevice.popErrorScope`; `ImageCapture.grabFrame`, `ImageDecoder.decode`, `VideoFrame.copyTo`, `Video/AudioDecoder/Encoder.flush`; `OffscreenCanvas.convertToBlob`; `createImageBitmap` | frame-rate media/GPU pipelines, cooperative schedulers, chunked file writes | **off** (opt-in), except `createImageBitmap` which is on the measured-stackless list — see breaker |
| **Hot in bulk** | `SubtleCrypto.*` (hashing/verifying many chunks or tokens), `Blob.arrayBuffer/bytes/text` and `Body.*` (`slice().arrayBuffer()` per chunk; `response.json()` per request on chatty apps), `Cache.*` / `CacheStorage.match` (a service worker's fetch handler runs per request) | loops over thousands of items | **off** (opt-in); `fetch` itself is covered by the network interceptor, never wrapped twice |
| **Bursty** | `HTMLImageElement.decode` (galleries), `CustomElementRegistry.whenDefined`, `CSSStyleSheet.replace` (one per component at startup), `FontFaceSet.load` (per text measure in some canvas libs), `RTCPeerConnection.getStats/addIceCandidate/replaceTrack/setParameters`, `CookieStore.*`, `MediaStreamTrack.applyConstraints` (per slider tick) | hundreds in a burst, then quiet | on for the measured-stackless ones (`decode`, `FontFace.load`, `addIceCandidate`), guarded by the breaker |
| **Rare** | `HTMLMediaElement.play`, `Clipboard.*`, `WakeLock.request`, `getUserMedia`, `ServiceWorkerContainer.register`, `Permissions.query`, `FileSystem*Handle.get*Handle`, `Worklet.addModule`, `decodeAudioData`, picker APIs | user-driven, a few per page | **on** |

**Gating replaces the breaker (see §4.4).** Frequency is a property of the app, not the API, so a static list is always wrong for
someone. Hot and bursty rows are armed only after their first failure, so a loop of successful calls pays one boolean check, and a
loop that starts failing pays the capture cost for a bounded number of calls. In a pure tight loop over the cheapest native call
the capture alone roughly doubles the per-call cost (1.2 to 2.3 µs in Chromium); that is the case the arming exists for.

### Cost and risk (what could make this a bad idea)
1. **Per-call overhead** of `new Error()` (microseconds). Fine for `play`, `getUserMedia`, `clipboard`; wrong for hot APIs — `fetch` (the network interceptor already wraps it; reuse its capture, don't add a second), `Scheduler.postTask/yield`, `FileSystemWritableFileStream.write`, `Blob/Body.*`, `SubtleCrypto.*` in loops, `ReadableStream` readers. Ship a **default set** (§2 measured + obvious async-failure APIs) and a `denyHot` list; the rest is opt-in.
2. **One-microtask delay** and a new promise identity: code comparing `video.play() === ...` or relying on exact microtask order can change. Rare, documented.
3. **Detectability:** `Function.prototype.toString` on a patched method is not `[native code]`; libraries that feature-detect natively can misjudge. Mitigate by wrapping with a `toString` that delegates to the original; still not a guarantee.
4. **Third-party patchers**: zone.js patches `then`, not `play`, so "compose with patchers" is not enough — it needs the two-mode wrapper of §4.1 (a measured regression otherwise). For other patchers of the same methods: wrap idempotently, mark ours with a symbol, and compose rather than replace.
   Patches are per realm: iframes and workers are not covered unless the SDK installs there too; `HTMLMediaElement` and `Clipboard` do not exist in workers, `FontFace`, `Cache` and `SubtleCrypto` do — install only where `globalThis[ctor]?.prototype[method]` exists.
5. **Memory:** a pending promise holds one `Error`; released when the promise settles.
6. Must not throw, must survive a frozen/non-writable prototype (guarded define), and must restore on `stop()`.

## 5. Keeping the table honest

- (BUILT) `scripts/async-origin/extract.mjs` generates the candidate list from `lib.dom.d.ts` (`pnpm async-origin:refresh`); a WebIDL mixin is an interface with no `declare var`; the drift test is `packages/instrumentation-tests/test/async-origin-drift.test.ts` (it lives there, not in capture, because it reads files and capture is runtime-portable).
- Generate the candidate list from `lib.dom.d.ts` (or `@webref/idl`, the real WebIDL) in a script; mixins (`Body`,
  `WindowOrWorkerGlobalScope`) resolve to the concrete prototypes that expose them.
- A **drift test** (same pattern as `spec-drift.test.ts`): generated list vs the committed table, so a new TypeScript release that
  adds an API forces a decision (always / armed / ignore).
- Install only where `globalThis[ctor]?.prototype[method]` exists (workers differ: `HTMLMediaElement` and `Clipboard` are absent,
  `FontFace`, `Cache`, `SubtleCrypto` present — measured).
- **Tests.** Factory unit tests: `this`/`length`/`name`/`toString` fidelity, idempotency symbol, restore on stop, frozen prototype,
  synchronous throw and non-thenable passthrough, mode selection. Provider tests for both lookups (by reason, by promise). Real-browser
  e2e in `@bugsee/instrumentation-tests` (headless, Chromium **and** Firefox): per always-on API, trigger an asynchronous rejection and
  assert the report has the origin frame naming the test's call-site function plus the target description. A **zone.js composition
  e2e** (serve the `zone.js` UMD from the repo's pnpm store) asserting a bare `play()` rejection still produces a report; and a
  composition test for each custom Promise implementation found in §10.

## 6. Non-`Error` user rejections

`Promise.reject('x')`, `throw 'x'` in an async function, `reject({code})`: no stack anywhere, both engines. Patching the global
`Promise` constructor to capture a stack on every `reject()` is far more invasive than §4 (it touches every promise in the page
and every library) and is **not recommended**. Cheaper and sufficient: (a) describe the value (`typeof`, constructor name, a
bounded JSON preview) in the summary/description instead of `String(value)`; (b) optionally wrap only the **static**
`Promise.reject` to record a stack for non-`Error` reasons (a static, rarely hot). Executor-style `reject('x')` stays unlocated.

## 7. Plan

1. **Non-`Error` description** (§6a) — independent, can land first.
2. **Table + generator + drift test**, no behaviour change.
3. **`wrapPromiseMethod` factory with the pristine-then derived mode (no-reaction fallback), arming and budget** (browser-only shell; runtime-portable core in `@bugsee/capture`),
   option `captureAsyncOrigins` (default on for the always-on set, opt-out), install/restore by the browser/webworker/electron-renderer
   `launch`.
4. **`asyncOriginEnricher`** + browser `crashOf` + `describeError` + `logException` (§4.5), and the per-API target describers (§4.3).
5. **Framework adapters** (§10): route the enricher through every adapter path that captures a rejection itself. **DONE, with no per-adapter code:** every client-side adapter reports through `reportError` in `@bugsee/web-adapter`, which calls `client.logException(error)` with the ORIGINAL error object, and `logException` applies the enricher (step 5). Proven in real Chromium and Firefox for React 18 (`BugseeErrorBoundary`) and Vue 3 (`errorHandler`) in `test/async-origin.adapters.browser.e2e.ts`; Angular, Solid and Svelte use the same funnel (not run in a browser); Next/Remix/Nuxt/SvelteKit re-export React/Vue/Svelte. Server-side `reportServerError` is Node and out of scope.
6. ~~`document` capture-phase `error` listener → system event.~~ **DROPPED (owner, 2026-11-03):** it needs a new `events.system` name in the platform spec for a timeline-only signal; the call site and the Target line (steps 1-5) already cover the failing `play()`/decode case.
7. e2e (§5) - **BUILT for `HTMLMediaElement.play()`** (`test/async-origin.browser.e2e.ts`: headless Chromium AND Firefox, plain page and zone.js-first page; unhandled and `logException` paths). Not yet: the other always-on APIs, the custom-Promise-library compositions, WebKit. Viewer: render origin frames distinctly and show the target description (viewer repo; needs the protocol decision below).

## 8. Open questions
- **Protocol (DECIDED, owner 2026-11-02):** a new optional `origin: 'call'` field on the frame ("this is where the API was called, not
  where an exception was thrown"). Not a fixed marker frame name. The viewer will adopt the field. The schema gets the field plus a drift test.
- Default-on vs opt-in: measured value is high (BGSVIEWER-14 itself) and the always-on set is rare-call; recommend ON with opt-out.
- WebKit is unmeasured (needs a Playwright WebKit build matching the installed Playwright).
- `Function.prototype.toString` on a wrapped method is not `[native code]` unless the wrapper delegates; it remains detectable.
- Per-realm: iframes are not covered; workers need their own install.
- Awaited chains under a patched `then` (zone.js) cannot be located; they get the target description only.
- Node/Bun/Deno: native promise APIs there reject with stacks created in JS; not measured and out of scope here.

## 9. Independent review (what changed from v1)

An independent review (a second model, its own measurements) agreed that wrapping is the only hook and found these defects in v1,
all now reflected above: (1) the derived-promise wrapper loses `unhandledrejection` under zone.js (measured) → pristine-`then` derived promise, §4.1/§4.1a (the first review proposed two modes; the framework survey, §10, showed capturing the global `then` itself breaks `play()` when `Promise` is replaced);
(2) `syntheticFrames` is the wrong seam for a `DOMException` → `enrichFrames`, §4.5; (3) the rate breaker is inverted → arm on first
failure plus a budget, §4.4; (4) Firefox's cost is the derived `then` as much as the `Error` → a no-reaction mode, §4.1; (5) `Proxy` and
`stackTraceLimit` tuning buy nothing, §4.1; (6) the target (`this`) is the stronger signal for `play()` and v1 discarded it, §4.3.


## 10. Frameworks and custom Promise implementations (measured, headless Chromium 156 / Firefox 151)

Question: do React, Vue, Svelte, Solid, Preact, Angular and the replacement-Promise libraries change what the wrapper and
`unhandledrejection` see? **No per-library code path is needed**, provided (a) the wrapper uses a pristine `then` and can never throw
into the app call (§4.1a), (b) the origin is looked up **by reason** at every consumer (§4.5), and (c) the SDK's framework adapters
pass the origin through the same crash builder.

### 10.1 What each library does to a platform promise

| Library | What it does to promises | Effect on `unhandledrejection` | Extra handling |
|---|---|---|---|
| Plain native; core-js with native present | does not replace `Promise` | fires, same reason | none |
| core-js forced over a deleted native `Promise` | own `Promise`; dispatches an untrusted synthetic event for its own promises | fires for its own; for the native `p`, `p.then` is native | never use the global `then` |
| Bluebird | UMD replaces `window.Promise`; own untrusted event | `Bluebird.resolve(p)` handles `p`; its event carries the same reason, not `p` | lookup by reason |
| es6-promise, RSVP | global replaced only if the app does it; **no DOM event** | silent for those chains (baseline gap: the SDK sees nothing) | none for the wrapper |
| zone.js (0.14.10, 0.16.3) | `ZoneAwarePromise`; patches native `then`; reports to console and `NgZone.onError` | native `p` unhandled: fires. Zone chains: **never fires** (also for a derived promise made with plain `p.then`) | pristine then (§4.1a) |
| zone.js with `__zone_symbol__DISABLE_WRAPPING_UNCAUGHT_PROMISE_REJECTION=false` | wraps zone rejections | event fires for zone chains | pristine then |
| Vue 3 dev, with `errorHandler` | `callWithAsyncErrorHandling` runs `.catch` on handler/hook/watcher promises | **does not fire**; `errorHandler` gets the same reason | lookup by reason |
| Vue 3 dev, no `errorHandler` | `logError` rethrows | fires, same reason | none |
| Vue 3 prod, no `errorHandler` | `console.error` only | **does not fire → invisible** | the adapter is required |
| React 18/19 event handler | ignores the returned promise | fires, same reason | none |
| React 19 `use()` | attaches `then`, rethrows in render | does not fire; boundary gets the same reason; no boundary → window `error` | lookup by reason |
| TanStack Query | handles the promise internally | unhandled `fetchQuery`: fires; caught/observer errors: same reason | none |
| Redux Toolkit `createAsyncThunk` | serializes the error | `unwrap()` rejects with a **plain object, not the reason**: identity lookup misses | optional name+message match |
| jQuery 4 | `$.when`/`Deferred` pass the same reason to `.fail`; adopted native promises are handled | no event | none |
| Alpine | `.catch` → `setTimeout(throw)` | window `error` event, same reason; no `unhandledrejection` | `crashOfErrorEvent` |
| Solid | `castError` keeps Errors; `createResource` handles | reaches `ErrorBoundary` | none |
| Svelte 5 `{#await}` (source) | no `catch` block rethrows from the `then` callback | fires, same reason; silent with a `catch` block | none |
| Next.js / Nuxt client | listeners only check redirects / show a dev overlay; none `preventDefault` | no effect | the React / Vue adapters |
| Angular | `NgZone.onError` → `ErrorHandler`; `provideBrowserGlobalErrorListeners()` is opt-in and `preventDefault`s | native event still fires without it; zoneless is the v22 default (`core.mjs:1994`) but `samples/angular-spa` ships zone.js ~0.14.10 | pristine then |

### 10.2 "Custom Promise implementations"

They fall into three groups, and none needs bespoke wrapper code:
- **They replace `globalThis.Promise`** (Bluebird by default, core-js when forced, zone.js's `ZoneAwarePromise`): the only hazard is the
  wrapper calling the captured global `then` on a native promise — fixed by §4.1a. The platform keeps returning **native** promises, so the
  wrapper still sees a native `p`.
- **They produce thenables or chains that never reach `unhandledrejection`** (es6-promise, RSVP, jQuery `Deferred`, Vue's handler
  `.catch`, React's `use`): the reason is delivered through the library's or the framework's own channel. That is the SDK adapters'
  job (§10.3); the wrapper's contribution is only that the **same reason object** carries the origin.
- **Transpiled async** (`__awaiter`, regenerator): changes which promise `event.promise` is, which is why the lookup is by reason, not by promise.

### 10.3 SDK adapter paths that must apply the enrichment

Every one of these is a route by which a stackless reason arrives; each must reach `buildCrashJson` with the origin lookup
(`asyncOriginEnricher`, §4.5):

| Path | Where |
|---|---|
| `unhandledrejection` provider | `packages/browser/src/detection-providers.ts` |
| `error` event provider (Alpine, React root with no boundary) | `crashOfErrorEvent`, `detection-providers.ts:54` |
| `logException` / `captureException` | `packages/core/src/client.ts` |
| React error boundary / `reportReactError` | `packages/react/src/error-boundary.ts` |
| Vue `installBugseeErrorHandler`; Nuxt chains its own `errorHandler` (`entry.js:43`) | `packages/vue`, `packages/nuxt` |
| Angular `BugseeErrorHandler` (`reportError` → `logException`) | `packages/angular/src/error.ts` |
| Solid `solidErrorHandler`; SvelteKit `handleErrorWithBugsee` | `packages/solid`, `packages/sveltekit` |

**Vue is the one that needs a documented requirement (now in `packages/vue/README.md`):** in production with no `app.config.errorHandler`, Vue only `console.error`s and
the SDK sees nothing, with or without this work; the adapter must be installed.

### 10.4 The remaining frameworks and libraries (measured: headless Chromium 156, ~17 key cases also Firefox 151)

**Answer: no library replaced the reason object on the platform-rejection path (`play()`), and none replaced `Promise` or
`Promise.prototype.then`** (NPO only when the native `Promise` is deleted first; the pristine-then wrapper still tagged the reason
there). Two kinds of extra handling emerge, neither library-specific code:

1. **Identity breakers — network-error wrappers.** `axios` (1.21.0), `ky` (2.2.0), `ofetch` (1.5.1) and Mithril `m.request` wrap the
   `fetch`/XHR failure in their own class; the original is only on `.cause` (axios with its **XHR adapter has no `.cause` at all**,
   so the original is lost; Mithril `m.request` wraps in a new `Error`). These wrap *network* errors, not platform promises like
   `play()`, but a stackless `TypeError: Failed to fetch` behind them is the same problem. **The enricher walks `reason.cause` a few
   levels deep** as a fallback to the by-reason lookup.
2. **Invisible-error gaps — the library swallows the error and the SDK sees nothing, with or without this work.** Listed in §10.5 so the
   adapters/docs can address them.

| Library (version) | Method | Effect on the promise | `unhandledrejection` | Same reason reaches its own channel? | SDK path / gap |
|---|---|---|---|---|---|
| Svelte 3.59.2, 4.2.20 | run | `{#await}` calls `.then(ok, err)`; with no `{:catch}` it rethrows (`await_block.js:70`) | fires with no `{:catch}`; silent with one; `onMount(async)`, `on:click(async)`, `$:` async fire | yes (`{:catch}`) | `packages/svelte` (no `{#await}` hook) |
| Lit 3.3.3 + `@lit/task` 1.0.3 | run | Task catches into state | **silent** with no `render({error})`/`onError`; `until()` and async lifecycles fire | yes (`render`, `onError`, `.error`) | **GAP** (no Lit adapter) |
| Ember 7.4.0 / RSVP 4.8.5 | run (bundled ember-source modules, not a full app) | `RSVP.resolve(p)` adopts `p`; the default `RSVP.on('error')` handler throws in a backburner microtask | fires with a **different `event.promise`**, same reason; `Ember.onerror` gets the same reason instead and nothing fires | yes; later-added `RSVP.on('error')` handlers never run | **GAP** (no Ember adapter) |
| Preact 11.1.1 + compat + preact-iso 2.12.2 | run | compat `lazy` rethrows into the boundary; **iso `lazy` hangs and fires twice** (derived promises, same reason) | handlers fire; compat `lazy` with no boundary → window `error` | yes for compat `lazy`, `useErrorBoundary`, `componentDidCatch`; **no** for iso `lazy` (`ErrorBoundary.onError` never called) | `packages/react` (preact-compat test exists) |
| SWR 2.5.1 | run | catches into hook state | none unless unhandled (`mutate(key, p)`, `trigger()`, `preload` fire) | yes (`onError`, `error`, Suspense) | `packages/react` |
| React Router 7.18.5 | run | data router catches loader/action/lazy errors | none | yes (`useRouteError`, `useAsyncError`, `onError`) | `packages/remix` (`bugseeOnError`) |
| React Router 6.30.4 / Remix 2.17.5 | router run; Remix runtime source only | as RR7; **no `onError` prop in v6** | none (console.error only without an `ErrorBoundary`) | yes | **GAP** (needs a route `ErrorBoundary`) |
| Astro 7.4.4 | source, not run | island hydration errors are caught and re-dispatched as a cancelable `astro:hydration-error` `CustomEvent` (`detail.error` is the same object) plus `console.error` | none | yes (`detail.error`) | **GAP** — nothing in `packages/` listens for it |
| Q 1.5.1 / 2.0.3 | run | Q-owned chains; adopts `p` on `Q.resolve` | none for `Q.resolve(p)`+`.then` (v2: `Q.resolve(p)` alone fires) | yes (`.fail`, `.done`, `Q.onerror`) | **GAP** |
| NPO 0.8.1 | run | no-op if native exists; with native deleted it installs its own `Promise` | normal with native; silent with native deleted (`.catch` gets the reason) | yes | **GAP** |
| Alpine 3.17.5 | run | evaluator catches, warns, rethrows via window `error` | window `error` (and `unhandledrejection` for a returned promise), same reason | yes | `crashOfErrorEvent`; **dedupe on reason identity** |
| htmx 2.0.11, Stimulus 3.2.2 | run | ignore the returned promise (Stimulus `handleError`: sync throws only) | fire | n/a | browser provider |
| Mithril 2.3.8 | run | handlers ignore it; **`m.route` `onmatch` rejection swallowed** (redirect + `console.error`); `m.request` wraps | handlers fire; `onmatch` silent | handlers yes; `onmatch` no; `m.request` no | **GAP** + `.cause` walk |
| Inferno 10.0.0, Knockout 3.5.3, Backbone 1.6.1, Underscore 1.13.8, jQuery 4.0.0 | run | no promise machinery in the tested paths | async handlers fire | n/a | browser provider |
| p-queue 10.0.0, p-retry 8.0.1 | run | pass the same reason through | fires if unhandled | yes | n/a |
| axios 1.21.0, ky 2.2.0, ofetch 1.5.1 | run (network failure) | wrap in `AxiosError`/`NetworkError`/`FetchError` | fires with the wrapper type | **no**, except via `.cause` (axios XHR: none) | **walk `.cause`** |
| RxJS 7.8.2 | run | `from(p)` forwards to `subscribe` | none (error → window `error` with no callback); `firstValueFrom` unhandled fires | yes, in all 9 cases (`config.onUnhandledError` too) | n/a |
| Qwik 1.20.3, Stencil 4.45.2, Marko 6.4.7 | source only | Qwik passes the same reason to `onRejected`; **Stencil: a rejecting async `componentWillLoad/Render` goes to a bare `console.error` and bypasses `setErrorHandler`**; Marko not traced | not run | Qwik yes, Stencil yes | **GAP** |

### 10.5 Invisible-error gaps found (independent of this feature)

These swallow the error so the SDK sees nothing today; the origin work does not change that, but each is worth an adapter hook or a
documented requirement:
- **Lit `@lit/task`** with no `render({error})`/`onError`; **SWR** with no `onError`; **React Router 6 / Remix v2** with no `ErrorBoundary`
  (`console.error` only); **Mithril `onmatch`**; **Q**; **Stencil** async lifecycle; **Vue production** without `errorHandler` (§10.3).
- **Astro:** the cancelable `astro:hydration-error` event carries the same reason and nothing listened for it. **FIXED:** `listenForAstroHydrationErrors` in `packages/astro/src/hydration.ts`, installed by `registerClient`; it reports the event's error (same object) without cancelling it.
- **Ember:** the default `RSVP.on('error')` throws before later handlers run; `Ember.onerror` is the usable channel.
- **Preact-iso `lazy`:** double `unhandledrejection` on derived promises with the same reason → the SDK's dedupe must key on reason identity.

### 10.6 Unverified
Ember routes (`Route#model()`, router_js) ran as source only, not in a full Ember app; the Remix v2 browser runtime (`RemixBrowser`,
single-fetch) is source-read only; Astro, Qwik, Stencil and Marko were not run in a browser (Marko `<await>`/`<try>` only skimmed).
Angular itself was not run in a browser (the zone paths were measured, Angular source read). WebKit untested.

## 11. Known limitations of the first build (review round 1, accepted)

- **A second recorder in the same realm is inert.** Install is idempotent through `Symbol.for('bugsee.asyncOrigin')`: a method already
  wrapped is skipped, so a second copy of the SDK (two bundles, HMR) or a re-launch after a `launch()` that threw after installing
  records nothing, and the first recorder's lookup does not see it. `launchCore` has no rollback for any of its interceptors, so this
  is the same property fetch/XHR capture already has; a page reload clears it.
- **Static methods are not patched** (`Notification.requestPermission`, `PublicKeyCredential.is…Available`, `*.isConfigSupported`, …).
  They are one-off capability probes. The drift test lists them (`ASYNC_ORIGIN_UNPATCHED_STATICS`) so a new one forces a decision.
- **A hostile or non-native `then`** that succeeds but returns a non-thenable leaves the derived promise dangling; native engines never
  do this, and the recorder degrades to the untouched promise.
- **The derived promise settles one microtask after the platform's**, and is not the platform's promise object (identity, subclass
  species). Inherent to keeping `unhandledrejection` alive (§4.1).
- **`describeThrown` serialises the whole object before clipping** to 256 characters. Contents of a thrown object appear in the report
  summary as well as in `exception.reason` (where they already were); nothing redacts them beyond the existing report-level rules.
- **Target line:** the browser `launch()` passes the target describer to the core client (`describeTarget`), so `logException` (and every
  framework adapter) gets the `Target:` line like the detection providers; media error messages go through the message sanitiser,
  source URLs through `sanitizeUrl` with the query and fragment dropped entirely. Page-controlled text (element id, font family) goes
  through `sanitizeErrorMessage`: token shapes are redacted; email addresses are not part of that shared definition and this does not add
  a second one.
- **The budget counts calls, not failures.** A method called more than 200 times in a minute stops being captured for the rest of that
  minute, so a later rejection of a bursty `always` method (`Permissions.query`, `decodeAudioData`) can lack an origin.
- **Retention.** A recorded origin holds its target (a media element) and, on V8, a lazily formatted stack until `.stack` is read; an
  app that keeps a rejected `DOMException` keeps both alive. The entry is dropped with the reason (WeakMap).
- **Drift guard limits.** The extractor matches a return type literally named `Promise`, so `Promise<X> | undefined`, `PromiseLike` and
  property-signature methods are not seen (none exist in the pinned lib.dom.d.ts); a mixin target is checked to be a real
  constructor, not to carry the method (a wrong target wraps nothing, silently).
- **Path tokens.** `sanitizeUrl` redacts `key=value` and `;matrix` secrets, not a bare path segment such as `/signed/<token>/clip.mp4`.

## 12. Found by running real engines (replacement Promise, platform-API batch, WebKit)

- **core-js disguises its `Promise`.** It patches `Function.prototype.toString` so its own `Promise` and `then` read `[native code]`; a
  toString check on the GLOBAL then trusts a `then` that throws on the engine's own promises, no reaction is attached, and the reason
  is never recorded. The pristine `then` now comes first from the engine intrinsic (the prototype of an async function's result, which no
  library can swap); the global one and the hidden iframe remain as fallbacks for a native `then` patched in place (zone.js).
  native-promise-only is not supported at all (no `Promise.allSettled`, which the SDK itself needs).
- **"Has a stack" means "has frames".** Chromium's async DOMExceptions for `Clipboard.readText` and `createImageBitmap` have a stack that is
  only the header line, so a non-empty-string test skipped them. A stack counts only if it has an `at ...` or `name@url:line:col` line.
- **The wrapper is on top of a reason's own stack.** An API that rejects with a stack made inside the call (a `TypeError` from argument
  validation) has the SDK's wrapper as its top frame, and a top `user` frame decides issue grouping. Every wrapper (and a probe) is
  created by one function, so the `original.apply` line is one source location; the recorder exposes the probe's stack, and the enricher
  drops frames at that location (`probeThrower`'s caller).
- **WebKit eliminates tail calls** (strict mode): `return video.play()` removes the calling function's own frame from the stack, so an
  application function written that way is not in the call site on Safari. Nothing to fix; the e2e scenarios are non-tail on purpose.
- **Arming is verified for real:** after one unlocated stackless rejection (which is itself reported without frames), `HTMLImageElement.decode`,
  `FontFace.load` and `createImageBitmap` get call sites in Chromium, Firefox and WebKit.
- **The wrapper site is found by position, not by name.** The probe throws from its own first frame, so the wrapper's call site is the next
  non-native frame of the probe stack; the thrower's name does not survive a minifier. `hasFrames` is anchored so header text like
  `user@host:8080` or a message line starting "at least" does not count as a frame.
- **Limits left alone:** a consumer that downlevels `async`/`await` to the global Promise defeats the intrinsic `then` (the global is then
  the only source, and a core-js `then` that disguises itself would be trusted); the Astro listener's stop function is not kept (it lives
  as long as the page).

## 13. Grouping signature and presentation (owner, 2026-11-03)

The captured call site is the report's PRIMARY exception data: `exception.frames` of `crash.json`, not a side channel. That settles two
things.

- **Signature.** The worker signs on `name` + `reason` + the first non-hidden `user` frame's trace (`worker/crash/managed/common.py`),
  after symbolicating each frame by its `debug_id` (`worker/crash/javascript.py`). A report with no frames had no signature at all (the
  location is `None`), so every BGSVIEWER-14 event was its own issue. With the call site as the frames: the top frame is `user` and not
  `hidden`; the same call site gives the same signature and a different call site a different one (run through the worker's own
  `get_crash_signatures` on `crash.json` from real Chromium, Firefox and WebKit). Frames an enricher supplies get their `debug_id` in
  `buildCrashJson` (both the Error and the non-Error path), because they are parsed after the stamp; without it a minified production
  build would sign on the minified position, which changes every deploy.
- **Presentation.** Nothing to change in the viewer: the frames render as any stack. `origin: 'call'` stays on the frame as information
  for a consumer that wants to tell a call site from a throw site; the viewer change that renders a heading and a chip (viewer branch
  `feat/async-origin-call-frames`) is therefore NOT being pushed.
- `skipFrames` hides the top N frames of whatever frames are reported, call site included; no SDK path or adapter passes it by default.

## 14. Review round 4 (PR #176 threads)

- **One definition of "has frames".** The `@`-dialect parser accepted any line containing `@`, so header text like
  `NotAllowedError: connect user@host:8080 failed` became a bogus frame (and the grouping location); it now needs `:line:col` (or
  Safari's `[native code]`). `parseV8Stack` ignores an unindented line that merely starts with "at " (message text). The recorder's
  predicate is injectable (`hasFrames`), and the browser passes `parseStack(stack).length > 0`.
- **Arming covers every report path and only the reported error.** The enricher (run by `unhandledrejection`, window `error`,
  `logException`, framework error channels) arms; `FrameEnricher` gets `{ depth }`, so a frameless Error in a `cause` chain (React's
  component stack) does not arm. The recorder is also released when the collector switches the SDK off (a detection provider whose
  `stop()` releases it), and `event.promise` links a fallback-mode origin (keyed by promise) to the reason.
- **`logException` description:** header, then the call site, then the `Caused by:` chain, then the `Target:` line; a linked cause no
  longer suppresses the call site.
- **A frameless non-Error reaches the enricher too** (`syntheticException` used to skip it), so a cross-realm `DOMException` (not
  `instanceof Error`) gets its call site in `crash.json` and therefore a grouping signature; `composeFrameEnrichers` forwards `info`.
- **Astro:** the hydration listener attaches before `launch()` resolves and queues (newest 20) what arrives before the client exists;
  a later registration (relaunch) replaces the `onError` it uses.
