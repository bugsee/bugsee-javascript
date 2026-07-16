// @bugsee/node-utils — http/https/fs/ALS helpers shared by @bugsee/node, bun and electron-main
// (design §5). Built test-first per docs/implementation-standards.md.

export {
  type BatchedFsChunkStorageOptions,
  createBatchedFsChunkStorage,
} from './batched-fs-chunk-storage';
export { createNodeBundleStore } from './bundle-store';
export {
  type CaptureRingWriterOptions,
  createCaptureRingWriter,
  createSyncRingWorker,
  type RingWorker,
  type RingWorkerArgs,
} from './capture-ring-writer';
export {
  type CrashpadSessionMarkerStore,
  createNodeCrashpadSessionMarkerStore,
} from './crashpad-session-marker-store';
export { createFsChunkStorage } from './fs-chunk-storage';
export {
  appendFileSecure,
  ensureDir,
  listFiles,
  readFileBytes,
  remove,
  writeFileSecure,
} from './fs-storage';
// httpRequest implements core's HttpTransport; the transport contract types live in @bugsee/core.
export { httpRequest, transportFor } from './http-request';
export { createNodeReportMarkerStore } from './report-marker-store';
export { createWorkerThreadRingWorker } from './worker-ring-worker';
