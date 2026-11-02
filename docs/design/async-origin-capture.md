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

## 4. Why a generic wrapper, and the one trap

There is no hook at the origin other than the call, so the SDK wraps each listed method:

```ts
const origin = new Error();                 // cheap: V8 formats .stack lazily
const p = original.apply(this, args);
if (!isThenable(p)) return p;
return p.then(undefined, (reason) => { remember(reason, origin); throw reason; });   // RETURN THE DERIVED PROMISE
```

**Trap:** attaching ANY reaction to the original promise marks it handled, and `unhandledrejection` then never fires for the
app. A side branch (`p.then(noop, record)`) would silently disable detection. Returning the derived promise (which re-throws)
keeps the app's promise the one that is unhandled, with the **same reason object**, so a `WeakMap<reason, origin>` finds it.

- `remember` stores only when the reason is an object **without usable frames** (`!/\n\s+at |@/.test(stack)`): nothing is retained for a rejection that already has a stack.
- The origin is attached at the two consumers that read a thrown value: the `unhandledrejection` provider and `captureException`/`crashOf`, via the existing `syntheticFrames` seam in `buildCrashJson` (`packages/core/src/crash.ts:114`). Frames are tagged as originating at the call ("async origin") so the viewer can say so.
- The wrapper frame itself is dropped from the captured stack.

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
- **The overhead is the stack capture**, about 1 µs per call in Chromium and 2.5-4.7 µs in Firefox (it captures eagerly there).
  The `apply` + `.then` part is about 0.2 µs in Chromium. Reading `.stack` is paid only on a rejection that has no frames.
- That is noise for `play`, `getUserMedia`, clipboard, `decode` (a few calls per page) and visible only for APIs called thousands of
  times a second, which is exactly the `hot` list kept out of the default set. If one of those is ever wanted, the factory takes
  `capture: false` (0.17 µs) or a sampling rate, so the choice is data, not code.
- Not measured: real-page effects of the extra microtask, and the retained-`Error` memory under very many pending promises.

### Cost and risk (what could make this a bad idea)
1. **Per-call overhead** of `new Error()` (microseconds). Fine for `play`, `getUserMedia`, `clipboard`; wrong for hot APIs — `fetch` (the network interceptor already wraps it; reuse its capture, don't add a second), `Scheduler.postTask/yield`, `FileSystemWritableFileStream.write`, `Blob/Body.*`, `SubtleCrypto.*` in loops, `ReadableStream` readers. Ship a **default set** (§2 measured + obvious async-failure APIs) and a `denyHot` list; the rest is opt-in.
2. **One-microtask delay** and a new promise identity: code comparing `video.play() === ...` or relying on exact microtask order can change. Rare, documented.
3. **Detectability:** `Function.prototype.toString` on a patched method is not `[native code]`; libraries that feature-detect natively can misjudge. Mitigate by wrapping with a `toString` that delegates to the original; still not a guarantee.
4. **Third-party patchers** (zone.js, other SDKs) patch the same methods: wrap idempotently, mark ours with a symbol, and compose rather than replace.
5. **Memory:** a pending promise holds one `Error`; released when the promise settles.
6. Must not throw, must survive a frozen/non-writable prototype (guarded define), and must restore on `stop()`.

## 5. Keeping the table honest

- Generate the candidate list from `lib.dom.d.ts` (or `@webref/idl`, which is the real WebIDL) in a script; mixins (`Body`, `WindowOrWorkerGlobalScope`) resolved to the concrete prototypes that expose them.
- A **drift test** (same pattern as `spec-drift.test.ts`): the generated list vs the committed table, so a new TS release adding an API forces a decision (default / hot / opt-in / ignore).
- A **real-browser e2e** in `@bugsee/instrumentation-tests` (headless, per the repo rule): for each default API, trigger an async rejection and assert the report's `crash.json` has an origin frame naming the test's call-site function. This is `probe.mjs` turned into assertions, and it is what catches a browser changing behaviour.

## 6. Non-`Error` user rejections

`Promise.reject('x')`, `throw 'x'` in an async function, `reject({code})`: no stack anywhere, both engines. Patching the global
`Promise` constructor to capture a stack on every `reject()` is far more invasive than §4 (it touches every promise in the page
and every library) and is **not recommended**. Cheaper and sufficient: (a) describe the value (`typeof`, constructor name, a
bounded JSON preview) in the summary/description instead of `String(value)`; (b) optionally wrap only the **static**
`Promise.reject` to record a stack for non-`Error` reasons (a static, rarely hot). Executor-style `reject('x')` stays unlocated.

## 7. Plan

1. **Table + generator + drift test** (no behaviour change).
2. **`async-origin` interceptor in `@bugsee/capture`** (browser-only, runtime-portable shell; installs/uninstalls the wrappers; option `captureAsyncOrigins`, default ON for the measured set).
3. **Consume it** in the browser/webworker/electron-renderer `unhandledrejection` providers and in `captureException`.
4. **Non-`Error` description** (§6a) — independent, can land first.
5. e2e (§5). Viewer: render "async origin" frames distinctly (viewer repo).

## 8. Open questions
- Default-on vs opt-in. Measured value is high (BGSVIEWER-14 itself), cost is small for the default set; recommend ON with an opt-out.
- WebKit behaviour is unmeasured — needs a matching Playwright WebKit build.
- Worker/Node: the same wrapper idea applies to Node's native-promise APIs, but those reject with stacks created in JS; not measured here.
