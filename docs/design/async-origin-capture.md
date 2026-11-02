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

Every promise-returning method declared in TypeScript's `lib.dom.d.ts` (6.0.3): **75 interfaces, 177 methods**. A method that can
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

### 4.1 The wrapper, in two modes

The trap that shapes everything: **attaching ANY reaction to a promise marks it handled**, so a side branch
(`p.then(noop, record)`) silently disables `unhandledrejection` for the app. The wrapper therefore has two modes, chosen ONCE at
install by testing `Function.prototype.toString.call(Promise.prototype.then)` for `[native code]`:

```ts
// native-then mode: return a DERIVED promise (same reason object), key the origin by reason
const origin = { error: new Error(), target: this, method };      // stack formatted lazily, only on failure
const p = original.apply(this, args);
if (!isThenable(p)) return p;
return nativeThen.call(p, undefined, (r) => { if (isObject(r)) byReason.set(r, origin); throw r; });

// patched-then mode (zone.js and friends): attach NO reaction; key the origin by the returned promise
const p = original.apply(this, args);
if (isObject(p)) byPromise.set(p, origin);
return p;                                                         // look up with event.promise
```

Why two modes (measured, Chromium 156 and Firefox 151):
- With zone.js 0.14.10 loaded, `Promise.prototype.then` returns a `ZoneAwarePromise` and the derived promise's rejection **never
  reaches `unhandledrejection`** (only zone's own `console.error`). A bare native `play()` rejection still does. So under zone.js the
  derived-promise wrapper would turn a detectable rejection into a lost one; the no-reaction mode keeps it. A pristine native
  `then` taken from a fresh iframe realm restores detection, but is not required.
- In patched-then mode only a **bare** call is located (`event.promise === p`); an awaited chain surfaces the async function's own
  promise, so the origin is lost there — the report still arrives, with element state (§4.3) instead of a call site.
- The derived promise settles one microtask later than the original; the no-reaction mode has no such delay.

Not used: a `Proxy` (apply trap +3.3 µs in Firefox, 20 µs cold), `Error.stackTraceLimit` tuning (capture cost is flat across limits;
20% memory only, and it contradicts `packages/core/src/stack.ts:283-285`), side-branch reactions.

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

A zero-cost complement, independent of any wrapping: one capture-phase `error` listener on `document` that records the element,
its `src` and the error code of a failing media/image load as a system event (it misses detached elements).

### 4.4 Gating: arm on first failure, not a rate breaker

The earlier proposal stopped capturing above ~200 calls/s. That is inverted: in a hot loop the first calls are usually the
successful ones, and the breaker trips exactly when failures begin.

- **Rare set** (play, clipboard, wakeLock, getUserMedia, `serviceWorker.register`, pickers, worklet, `decodeAudioData`,
  file-system handles): always capture.
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
- Lookup order at report time: by reason (native-then mode), then by `event.promise` (patched-then mode, bare call only).

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
3. **`wrapPromiseMethod` factory with the two modes, arming and budget** (browser-only shell; runtime-portable core in `@bugsee/capture`),
   option `captureAsyncOrigins` (default on for the always-on set, opt-out), install/restore by the browser/webworker/electron-renderer
   `launch`.
4. **`asyncOriginEnricher`** + browser `crashOf` + `describeError` + `logException` (§4.5), and the per-API target describers (§4.3).
5. **Framework adapters** (§10): route the enricher through every adapter path that captures a rejection itself.
6. `document` capture-phase `error` listener → system event.
7. e2e (§5). Viewer: render origin frames distinctly and show the target description (viewer repo; needs the protocol decision below).

## 8. Open questions
- **Protocol:** there is no frame field that says "this frame is where the API was called, not where an exception was thrown". Options:
  a new optional `origin: 'call'` on the frame, or a fixed marker frame name. Needs the viewer owners.
- Default-on vs opt-in: measured value is high (BGSVIEWER-14 itself) and the always-on set is rare-call; recommend ON with opt-out.
- WebKit is unmeasured (needs a Playwright WebKit build matching the installed Playwright).
- `Function.prototype.toString` on a wrapped method is not `[native code]` unless the wrapper delegates; it remains detectable.
- Per-realm: iframes are not covered; workers need their own install.
- Awaited chains under a patched `then` (zone.js) cannot be located; they get the target description only.
- Node/Bun/Deno: native promise APIs there reject with stacks created in JS; not measured and out of scope here.

## 9. Independent review (what changed from v1)

An independent review (a second model, its own measurements) agreed that wrapping is the only hook and found these defects in v1,
all now reflected above: (1) the derived-promise wrapper loses `unhandledrejection` under zone.js (measured) → two modes, §4.1;
(2) `syntheticFrames` is the wrong seam for a `DOMException` → `enrichFrames`, §4.5; (3) the rate breaker is inverted → arm on first
failure plus a budget, §4.4; (4) Firefox's cost is the derived `then` as much as the `Error` → a no-reaction mode, §4.1; (5) `Proxy` and
`stackTraceLimit` tuning buy nothing, §4.1; (6) the target (`this`) is the stronger signal for `play()` and v1 discarded it, §4.3.

