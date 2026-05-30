// @bugsee/util
// Pure utilities: env detection, Deferred, base64, sha256, deep-merge, json-safe-stringify, exponential-backoff, fflate re-export
// Tier 0. See docs/design/sdk-design.md §5 and docs/implementation-standards.md.

export type { BackoffOptions } from './backoff';
export { computeBackoff } from './backoff';
export { fromBase64, toBase64 } from './base64';
export type { PlainObject } from './deep-merge';
export { deepMerge } from './deep-merge';
export type { Deferred } from './deferred';
export { createDeferred } from './deferred';
export {
  isBrowser,
  isBun,
  isCloudflareWorker,
  isDeno,
  isElectronMain,
  isElectronRenderer,
  isNode,
  isServiceWorker,
  isVercelEdge,
  isWebWorker,
} from './env';
export { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from './fflate';
export { jsonSafeStringify } from './json-safe-stringify';
export { sha256Hex } from './sha256';
export { utf8ByteLength } from './utf8-byte-length';
