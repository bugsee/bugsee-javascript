// Wire constants (design §8.4, §8). Single source of truth for bundle file names + manifest version.

/** Manifest schema version emitted by the JS SDK (§0.16 / §8). Backend accepts v1 (mobile) + v2. */
export const MANIFEST_VERSION = 2;

/**
 * `input.json`'s OWN stream version (`specs/sdk/reporting/bundle/input.md`), independent of
 * {@link MANIFEST_VERSION}: the wire spec is cross-platform and a consumer keys its decoding of the
 * file's `button`/`buttonMask`/`metaState`/scroll fields on THIS number, not the manifest's. Version 3
 * fixes the mouse `button` numbering across platforms, adds `buttonMask`, writes `metaState` on a mouse
 * press/release, and adds `scrollX`/`scrollY`/`scrollUnit` — all landing together in the JS SDK's mouse
 * capture, so this stream alone moves from unversioned to 3.
 */
export const INPUT_STREAM_VERSION = 3;

// Root bundle files (§8.4).
export const REQUEST_JSON_FILENAME = 'request.json';
export const MANIFEST_JSON_FILENAME = 'manifest.json';
export const APP_TOKEN_FILENAME = 'apptoken';

/** Bundle archive name suffix (§8.3: `<random20>.bundle.zip`). */
export const BUNDLE_FILE_SUFFIX = '.bundle.zip';

/**
 * Wire file types the JS SDK emits (§8.4). `video` is the mobile-canonical video file — now also emitted
 * by the Electron opt-in pixel-capture source (D8).
 *
 * ARCHITECTURE (binding): the `*.user` streams — `events.user`, `traces.user` — carry ONLY data the
 * APPLICATION supplied through `client.event()` / `client.trace()`. SDK-captured data must never be
 * written into them; it gets its own stream. `input` is the stream for SDK-captured device input.
 */
export type FileType =
  | 'attachment'
  | 'replay'
  | 'screenshot'
  | 'video'
  | 'video.aux'
  | 'traces.system'
  | 'traces.user'
  | 'events.system'
  | 'events.user'
  | 'input'
  | 'viewtree'
  | 'log'
  | 'log.internal'
  | 'network'
  | 'breadcrumbs'
  | 'performance'
  | 'profile'
  | 'crash';

/** Default filename per file type (§8.4). `attachment` is caller-supplied, so it has no default. */
export const DEFAULT_FILENAMES: Readonly<Record<Exclude<FileType, 'attachment'>, string>> = {
  replay: 'replay.bin',
  screenshot: 'screenshot.png',
  video: 'video.webm', // encoded pixel-capture video — Electron opt-in (D8)
  // The geometry of the recording over time: the frame each `input` coordinate was measured in, and
  // (web) what part of it the person could see. Version 2 of the stream is one shape for every
  // platform — specs sdk/reporting/bundle/video-aux.md. Named `video.aux` because mobile emits it
  // from the video exporter, but a web recording writes it with no pixel video at all: the frame is
  // the layout viewport, and without it a consumer falls back to `environment.hardware.screen` —
  // the whole monitor, captured once at launch — and puts clicks off the frame.
  'video.aux': 'video.aux.json',
  'traces.system': 'traces.system.json',
  'traces.user': 'traces.user.json',
  'events.system': 'events.system.json',
  'events.user': 'events.user.json',
  // Device INPUT (pointer presses, key presses) — the dedicated stream for what the SDK observes the
  // person doing. Mobile-canonical: Android's exporter emits `<random>.input.json` and the viewer
  // already has an `input` case that splits entries by `tool`. Deliberately SEPARATE from
  // `events.user`, which is reserved for app-supplied `client.event()` data — SDK code must never
  // write into a `user.*` stream (see the file header).
  input: 'input.json',
  viewtree: 'viewtree.json',
  log: 'logs.json',
  'log.internal': 'internal.logs.json',
  network: 'network.json',
  breadcrumbs: 'breadcrumbs', // NO .json extension — mobile contract (§8.4)
  performance: 'performance.json',
  profile: 'profile.json', // V8 CPU profile (.cpuprofile object) — node diagnostics
  crash: 'crash.json',
};

/**
 * `video.aux.json`'s document version (specs sdk/reporting/bundle/video-aux.md).
 *
 * Version 2 is the unified shape: `frameW`/`frameH` in the coordinates' OWN units — CSS px in the
 * layout viewport on the web — plus the visible region and the device-pixel ratio. Version 1 was
 * mobile-only and wrote `screenW`/`screenH` in DISPLAY pixels, which a consumer has to divide by the
 * density. The JS SDK has only ever written version 2, but the field is what tells a consumer which
 * of the two it is holding, so it is never omitted.
 */
export const VIDEO_AUX_VERSION = 2;

/**
 * The performance-transaction wire attribute that records a transaction NAME's provenance
 * (`'url' | 'route' | 'custom'`, `@bugsee/performance`'s `TransactionNameSource`). Lives here — not in
 * `@bugsee/performance` — because it is a plain wire attribute KEY, not APM logic, and
 * `@bugsee/node/server-instrument.ts` needs to read it off `Transaction.getAttributes()` without pulling
 * in a runtime (value-level) dependency on the opt-in APM extension (design §0.6: performance "tree-shakes
 * to nothing when unused"). `@bugsee/performance` re-exports this constant for its own consumers.
 */
export const NAME_SOURCE_ATTRIBUTE = 'bugsee.name_source';
