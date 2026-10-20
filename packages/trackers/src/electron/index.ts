// `@bugsee/trackers/electron` entry. Platform tracker implementations that need Electron main-process APIs live under
// src/electron/ and are exported from here. Electron is never imported: the `app` object is injected as a structural
// `ElectronAppSource`, so this entry has no dependency on `electron` or the DOM. The portable root entry must never
// import from this directory.
export { type ElectronGpu, mapGpuInfo } from './gpu-info';
export {
  type AppProcessMetric,
  type ChildProcessGone,
  type ElectronAppSource,
  type ElectronProcessEnv,
  type ElectronProcessEvents,
  ElectronProcessTracker,
  type ElectronProcessTrackerEnv,
  electronProcessTrackerFor,
  type GpuInfoType,
  resetElectronProcessTracker,
} from './process-tracker';
