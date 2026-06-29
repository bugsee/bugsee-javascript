// @bugsee/browser-utils
// Browser runtime primitives shared by the browser / web-worker / service-worker tiers:
// the fetch HttpTransport + IndexedDB-backed durable stores (DOM instrumentation — pending).
// Tier 3. See docs/design/sdk-design.md §5 and docs/implementation-standards.md.
export { createFetchTransport, type FetchLike, fetchTransport } from './fetch-transport';
export {
  type AsyncBlobStore,
  type AsyncKeyedStore,
  createIdbBlobStore,
  createIdbKeyedStore,
  type IdbBlobStoreOptions,
} from './idb';
export {
  createPersistentBundleStore,
  type PersistentBundleStore,
} from './idb-bundle-store';
export {
  createIdbChunkBackend,
  createIdbChunkCaptureStore,
  type IdbChunkBackendOptions,
  type IdbChunkCaptureStoreOptions,
} from './idb-chunk-backend';
export {
  createPersistentReportMarkerStore,
  type PersistentReportMarkerStore,
} from './idb-report-marker-store';
export {
  createWebLockLiveness,
  type LockManagerLike,
  WEB_LOCKS_UNAVAILABLE_WARNING,
  type WebLockLiveness,
} from './web-lock-liveness';
