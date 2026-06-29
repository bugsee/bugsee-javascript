// @bugsee/webworker — DOM-less browser-family SDK for Web Workers + Service Workers. Capture: console→log +
// network (fetch/ws). Detection: global `error`/`unhandledrejection` on the worker `self`. No DOM, no ALS /
// per-request context, memory-only (IndexedDB persistence is a follow-up). Tier 2. See docs/design/sdk-design.md
// §3.2/§3.3.
export {
  buildWorkerEnvironment,
  realWorkerProbe,
  type WorkerEnvironmentInput,
  type WorkerPlatformType,
  type WorkerProbe,
} from './environment';
export { type Bugsee, type BugseeWorkerLaunchOptions, launch } from './launch';
