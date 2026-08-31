// Wire constants (design §8.4, §8). Single source of truth for bundle file names + manifest version.

/** Manifest schema version emitted by the JS SDK (§0.16 / §8). Backend accepts v1 (mobile) + v2. */
export const MANIFEST_VERSION = 2;

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
 * The performance-transaction wire attribute that records a transaction NAME's provenance
 * (`'url' | 'route' | 'custom'`, `@bugsee/performance`'s `TransactionNameSource`). Lives here — not in
 * `@bugsee/performance` — because it is a plain wire attribute KEY, not APM logic, and
 * `@bugsee/node/server-instrument.ts` needs to read it off `Transaction.getAttributes()` without pulling
 * in a runtime (value-level) dependency on the opt-in APM extension (design §0.6: performance "tree-shakes
 * to nothing when unused"). `@bugsee/performance` re-exports this constant for its own consumers.
 */
export const NAME_SOURCE_ATTRIBUTE = 'bugsee.name_source';
