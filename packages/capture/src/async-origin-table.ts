// The patch table for async-origin capture (docs/design/async-origin-capture.md §3, §4.4, §5): every promise-returning platform
// method, and what the SDK does with it. DATA ONLY — no behaviour; the wrapper factory (a later step) reads it.
//
// The candidate list is generated from TypeScript's `lib.dom.d.ts` (`pnpm async-origin:refresh` →
// `spec/dom-promise-methods.snapshot.json`), and `packages/instrumentation-tests/test/async-origin-drift.test.ts` fails when this table and that list disagree,
// so a new TypeScript release that adds an API forces a decision here rather than silently going unwrapped.

/**
 * What the SDK does with a method:
 * - `always`: wrap and capture the call site on every call. Rare, user-driven APIs (a few calls per page).
 * - `armed`: pass-through until the method's FIRST rejection, then capture (frequency is a property of the app, not the API).
 * - `off`: never wrapped by default — hot in bulk, or already covered, or the rejection is the application's own.
 */
export type AsyncOriginMode = 'always' | 'armed' | 'off';

export interface AsyncOriginRow {
  /** The `lib.dom.d.ts` interface (or, for a manual extra, the global the methods hang off). */
  iface: string;
  methods: readonly string[];
  mode: AsyncOriginMode;
  /**
   * The constructors whose `prototype` carries the methods, when `iface` is a WebIDL mixin (no constructor of its own).
   * `'globalThis'` means the methods are own properties of the global object. Absent: `iface` itself.
   */
  targets?: readonly string[];
  /** Why this mode. One line. */
  why: string;
}

const RARE = 'rare, user-driven: a few calls per page';
const BURSTY = 'can burst (hundreds, then quiet): armed on first failure';
const HOT =
  'per frame / chunk / task: armed on first failure so a loop of successes pays one boolean';
const BULK = 'hot in bulk (per chunk / per request): off by default';

export const ASYNC_ORIGIN_TABLE: readonly AsyncOriginRow[] = [
  { iface: 'AudioContext', methods: ['close', 'resume', 'suspend'], mode: 'always', why: RARE },
  { iface: 'AudioDecoder', methods: ['flush'], mode: 'armed', why: HOT },
  { iface: 'AudioEncoder', methods: ['flush'], mode: 'armed', why: HOT },
  {
    iface: 'BaseAudioContext',
    methods: ['decodeAudioData'],
    mode: 'always',
    why: 'measured stackless (EncodingError); a few per page',
  },
  { iface: 'Blob', methods: ['arrayBuffer', 'bytes', 'text'], mode: 'off', why: BULK },
  {
    iface: 'Body',
    methods: ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'],
    mode: 'off',
    targets: ['Request', 'Response'],
    why: BULK,
  },
  { iface: 'CSSStyleSheet', methods: ['replace'], mode: 'armed', why: BURSTY },
  {
    iface: 'Cache',
    methods: ['add', 'addAll', 'delete', 'keys', 'match', 'matchAll', 'put'],
    mode: 'off',
    why: BULK,
  },
  {
    iface: 'CacheStorage',
    methods: ['delete', 'has', 'keys', 'match', 'open'],
    mode: 'off',
    why: BULK,
  },
  {
    iface: 'Clipboard',
    methods: ['read', 'readText', 'write', 'writeText'],
    mode: 'always',
    why: 'measured stackless (NotAllowedError); user-driven',
  },
  { iface: 'ClipboardItem', methods: ['getType'], mode: 'always', why: RARE },
  { iface: 'CookieStore', methods: ['delete', 'get', 'getAll', 'set'], mode: 'armed', why: BURSTY },
  {
    iface: 'CookieStoreManager',
    methods: ['getSubscriptions', 'subscribe', 'unsubscribe'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'CredentialsContainer',
    methods: ['create', 'get', 'preventSilentAccess', 'store'],
    mode: 'always',
    why: RARE,
  },
  { iface: 'CustomElementRegistry', methods: ['whenDefined'], mode: 'armed', why: BURSTY },
  {
    iface: 'Document',
    methods: ['exitFullscreen', 'exitPictureInPicture', 'hasStorageAccess', 'requestStorageAccess'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'Element',
    methods: ['requestFullscreen', 'requestPointerLock'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'FileSystemDirectoryHandle',
    methods: ['getDirectoryHandle', 'getFileHandle', 'removeEntry', 'resolve'],
    mode: 'always',
    why: 'measured stackless after an await; a few per page',
  },
  {
    iface: 'FileSystemFileHandle',
    methods: ['createWritable', 'getFile'],
    mode: 'always',
    why: RARE,
  },
  { iface: 'FileSystemHandle', methods: ['isSameEntry'], mode: 'always', why: RARE },
  {
    iface: 'FileSystemWritableFileStream',
    methods: ['seek', 'truncate', 'write'],
    mode: 'armed',
    why: HOT,
  },
  {
    iface: 'FontFace',
    methods: ['load'],
    mode: 'armed',
    why: 'measured stackless; one per face, bursty at startup',
  },
  {
    iface: 'FontFaceSet',
    methods: ['load'],
    mode: 'armed',
    why: 'measured stackless; per text measure in some canvas libraries',
  },
  { iface: 'GPU', methods: ['requestAdapter'], mode: 'armed', why: HOT },
  { iface: 'GPUAdapter', methods: ['requestDevice'], mode: 'armed', why: HOT },
  { iface: 'GPUBuffer', methods: ['mapAsync'], mode: 'armed', why: HOT },
  {
    iface: 'GPUDevice',
    methods: ['createComputePipelineAsync', 'createRenderPipelineAsync', 'popErrorScope'],
    mode: 'armed',
    why: HOT,
  },
  { iface: 'GPUQueue', methods: ['onSubmittedWorkDone'], mode: 'armed', why: HOT },
  { iface: 'GPUShaderModule', methods: ['getCompilationInfo'], mode: 'armed', why: HOT },
  { iface: 'GamepadHapticActuator', methods: ['playEffect', 'reset'], mode: 'armed', why: BURSTY },
  {
    iface: 'HTMLImageElement',
    methods: ['decode'],
    mode: 'armed',
    why: 'measured stackless (EncodingError); galleries decode in bursts',
  },
  {
    iface: 'HTMLMediaElement',
    methods: ['play'],
    mode: 'always',
    why: 'BGSVIEWER-14: NotSupportedError with no stack; rare',
  },
  { iface: 'HTMLMediaElement', methods: ['setMediaKeys', 'setSinkId'], mode: 'always', why: RARE },
  { iface: 'HTMLVideoElement', methods: ['requestPictureInPicture'], mode: 'always', why: RARE },
  { iface: 'IDBFactory', methods: ['databases'], mode: 'always', why: RARE },
  {
    iface: 'ImageCapture',
    methods: ['getPhotoCapabilities', 'getPhotoSettings', 'grabFrame', 'takePhoto'],
    mode: 'armed',
    why: HOT,
  },
  { iface: 'ImageDecoder', methods: ['decode'], mode: 'armed', why: HOT },
  { iface: 'LockManager', methods: ['query'], mode: 'always', why: RARE },
  {
    iface: 'LockManager',
    methods: ['request'],
    mode: 'off',
    why: "settles with the application callback's own result, whose Error already has a stack",
  },
  { iface: 'MIDIPort', methods: ['close', 'open'], mode: 'always', why: RARE },
  {
    iface: 'MediaCapabilities',
    methods: ['decodingInfo', 'encodingInfo'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'MediaDevices',
    methods: ['enumerateDevices', 'getDisplayMedia', 'getUserMedia'],
    mode: 'always',
    why: 'measured stackless (NotFoundError); user-driven',
  },
  {
    iface: 'MediaKeySession',
    methods: ['close', 'generateRequest', 'load', 'remove', 'update'],
    mode: 'always',
    why: RARE,
  },
  { iface: 'MediaKeySystemAccess', methods: ['createMediaKeys'], mode: 'always', why: RARE },
  {
    iface: 'MediaKeys',
    methods: ['getStatusForPolicy', 'setServerCertificate'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'MediaSession',
    methods: ['setCameraActive', 'setMicrophoneActive'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'MediaStreamTrack',
    methods: ['applyConstraints'],
    mode: 'armed',
    why: 'per slider tick in some apps',
  },
  {
    iface: 'NavigationPreloadManager',
    methods: ['disable', 'enable', 'getState', 'setHeaderValue'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'Navigator',
    methods: ['requestMIDIAccess', 'requestMediaKeySystemAccess', 'share'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'NavigatorBadge',
    methods: ['clearAppBadge', 'setAppBadge'],
    mode: 'always',
    targets: ['Navigator', 'WorkerNavigator'],
    why: RARE,
  },
  { iface: 'NavigatorLogin', methods: ['setStatus'], mode: 'always', why: RARE },
  {
    iface: 'OfflineAudioContext',
    methods: ['resume', 'startRendering', 'suspend'],
    mode: 'always',
    why: RARE,
  },
  { iface: 'OffscreenCanvas', methods: ['convertToBlob'], mode: 'armed', why: HOT },
  {
    iface: 'PaymentRequest',
    methods: ['abort', 'canMakePayment', 'show'],
    mode: 'always',
    why: RARE,
  },
  { iface: 'PaymentResponse', methods: ['complete', 'retry'], mode: 'always', why: RARE },
  { iface: 'Permissions', methods: ['query'], mode: 'always', why: RARE },
  {
    iface: 'PushManager',
    methods: ['getSubscription', 'permissionState', 'subscribe'],
    mode: 'always',
    why: RARE,
  },
  { iface: 'PushSubscription', methods: ['unsubscribe'], mode: 'always', why: RARE },
  {
    iface: 'RTCPeerConnection',
    methods: [
      'addIceCandidate',
      'createAnswer',
      'createOffer',
      'getStats',
      'setLocalDescription',
      'setRemoteDescription',
    ],
    mode: 'armed',
    why: 'measured stackless (addIceCandidate); ICE trickles in bursts',
  },
  { iface: 'RTCRtpReceiver', methods: ['getStats'], mode: 'armed', why: BURSTY },
  {
    iface: 'RTCRtpSender',
    methods: ['getStats', 'replaceTrack', 'setParameters'],
    mode: 'armed',
    why: BURSTY,
  },
  {
    iface: 'ReadableStream',
    methods: ['cancel', 'pipeTo'],
    mode: 'off',
    why: "stream plumbing; the SDK's own body streaming runs on it, and the reason is usually the application's",
  },
  { iface: 'ReadableStreamBYOBReader', methods: ['read'], mode: 'off', why: HOT },
  { iface: 'ReadableStreamDefaultReader', methods: ['read'], mode: 'off', why: HOT },
  {
    iface: 'ReadableStreamGenericReader',
    methods: ['cancel'],
    mode: 'off',
    targets: ['ReadableStreamDefaultReader', 'ReadableStreamBYOBReader'],
    why: 'stream plumbing',
  },
  {
    iface: 'RemotePlayback',
    methods: ['cancelWatchAvailability', 'prompt', 'watchAvailability'],
    mode: 'always',
    why: RARE,
  },
  { iface: 'Scheduler', methods: ['postTask', 'yield'], mode: 'armed', why: HOT },
  { iface: 'ScreenOrientation', methods: ['lock'], mode: 'always', why: RARE },
  {
    iface: 'ServiceWorkerContainer',
    methods: ['getRegistration', 'getRegistrations', 'register'],
    mode: 'always',
    why: 'measured stackless (register); once per page',
  },
  {
    iface: 'ServiceWorkerRegistration',
    methods: ['getNotifications', 'showNotification', 'unregister', 'update'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'StorageManager',
    methods: ['estimate', 'getDirectory', 'persist', 'persisted'],
    mode: 'always',
    why: RARE,
  },
  {
    iface: 'SubtleCrypto',
    methods: [
      'decrypt',
      'deriveBits',
      'deriveKey',
      'digest',
      'encrypt',
      'exportKey',
      'generateKey',
      'importKey',
      'sign',
      'unwrapKey',
      'verify',
      'wrapKey',
    ],
    mode: 'off',
    why: BULK,
  },
  { iface: 'VideoDecoder', methods: ['flush'], mode: 'armed', why: HOT },
  { iface: 'VideoEncoder', methods: ['flush'], mode: 'armed', why: HOT },
  { iface: 'VideoFrame', methods: ['copyTo'], mode: 'armed', why: HOT },
  {
    iface: 'WakeLock',
    methods: ['request'],
    mode: 'always',
    why: 'measured stackless (NotAllowedError); rare',
  },
  { iface: 'WakeLockSentinel', methods: ['release'], mode: 'always', why: RARE },
  {
    iface: 'WebTransport',
    methods: ['createBidirectionalStream', 'createUnidirectionalStream'],
    mode: 'armed',
    why: BURSTY,
  },
  {
    iface: 'WindowOrWorkerGlobalScope',
    methods: ['createImageBitmap'],
    mode: 'armed',
    targets: ['globalThis'],
    why: 'measured stackless; per sprite / frame in some apps',
  },
  {
    iface: 'WindowOrWorkerGlobalScope',
    methods: ['fetch'],
    mode: 'off',
    targets: ['globalThis'],
    why: 'covered by the network interceptor, which already records the request; never add a second wrapper',
  },
  { iface: 'WritableStream', methods: ['abort', 'close'], mode: 'off', why: 'stream plumbing' },
  {
    iface: 'WritableStreamDefaultWriter',
    methods: ['abort', 'close', 'write'],
    mode: 'off',
    why: HOT,
  },
  {
    iface: 'Worklet',
    methods: ['addModule'],
    mode: 'always',
    why: 'measured stackless (AbortError); rare',
  },
];

/**
 * Real promise-returning APIs that `lib.dom.d.ts` does not declare (it lags the platform), added BY HAND. The generated snapshot cannot
 * contain these, so each carries its source; the drift test only checks that each is STILL missing from lib.dom.d.ts (once TypeScript
 * declares it, it is classified by the generated table and the extra goes). Kept to the ones the design measured or named; add more with a measurement.
 */
export const ASYNC_ORIGIN_EXTRAS: readonly AsyncOriginRow[] = [
  {
    iface: 'globalThis',
    methods: ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker', 'queryLocalFonts'],
    mode: 'always',
    targets: ['globalThis'],
    why: 'File System Access / Local Font Access: user-driven, not yet in lib.dom.d.ts (design doc §3)',
  },
];

/** The constructors whose `prototype` (or, for `'globalThis'`, the global object itself) carries a row's methods. */
export function rowTargets(row: AsyncOriginRow): readonly string[] {
  return row.targets ?? [row.iface];
}

/**
 * Promise-returning STATIC methods on lib.dom.d.ts (the constructor side, not a prototype). The patcher wraps prototype methods
 * only, and every one of these is a one-off capability or permission probe that does not fail in a way worth locating, so none is
 * patched. Listed so the drift test (`async-origin-drift.test.ts`) forces a decision when TypeScript adds one.
 */
export const ASYNC_ORIGIN_UNPATCHED_STATICS: Readonly<Record<string, readonly string[]>> = {
  AudioDecoder: ['isConfigSupported'],
  AudioEncoder: ['isConfigSupported'],
  ImageDecoder: ['isTypeSupported'],
  Notification: ['requestPermission'],
  PublicKeyCredential: [
    'getClientCapabilities',
    'isConditionalMediationAvailable',
    'isUserVerifyingPlatformAuthenticatorAvailable',
    'signalAllAcceptedCredentials',
    'signalCurrentUserDetails',
    'signalUnknownCredential',
  ],
  RTCPeerConnection: ['generateCertificate'],
  VideoDecoder: ['isConfigSupported'],
  VideoEncoder: ['isConfigSupported'],
};
