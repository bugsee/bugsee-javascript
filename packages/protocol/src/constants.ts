// Wire constants (design §8.4, §8). Single source of truth for bundle file names + manifest version.

/** Manifest schema version emitted by the JS SDK (§0.16 / §8). Backend accepts v1 (mobile) + v2. */
export const MANIFEST_VERSION = 2;

// Root bundle files (§8.4).
export const REQUEST_JSON_FILENAME = 'request.json';
export const MANIFEST_JSON_FILENAME = 'manifest.json';
export const APP_TOKEN_FILENAME = 'apptoken';

/** Bundle archive name suffix (§8.3: `<random20>.bundle.zip`). */
export const BUNDLE_FILE_SUFFIX = '.bundle.zip';

/** Wire file types the JS SDK emits (§8.4). `video` is mobile-only and never emitted here. */
export type FileType =
  | 'attachment'
  | 'replay'
  | 'screenshot'
  | 'traces.system'
  | 'traces.user'
  | 'events.system'
  | 'events.user'
  | 'viewtree'
  | 'log'
  | 'log.internal'
  | 'network'
  | 'breadcrumbs'
  | 'performance'
  | 'crash';

/** Default filename per file type (§8.4). `attachment` is caller-supplied, so it has no default. */
export const DEFAULT_FILENAMES: Readonly<Record<Exclude<FileType, 'attachment'>, string>> = {
  replay: 'replay.bin',
  screenshot: 'screenshot.png',
  'traces.system': 'traces.system.json',
  'traces.user': 'traces.user.json',
  'events.system': 'events.system.json',
  'events.user': 'events.user.json',
  viewtree: 'viewtree.json',
  log: 'logs.json',
  'log.internal': 'internal.logs.json',
  network: 'network.json',
  breadcrumbs: 'breadcrumbs', // NO .json extension — mobile contract (§8.4)
  performance: 'performance.json',
  crash: 'crash.json',
};
